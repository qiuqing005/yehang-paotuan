import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const frontendUrl = process.env.LIVEKIT_FAILURE_FRONTEND_URL ?? 'http://localhost:5173';
const apiBase = process.env.LIVEKIT_FAILURE_API_BASE ?? 'http://localhost:8787';
const outputDir = process.env.LIVEKIT_FAILURE_OUTPUT_DIR ?? path.join(process.cwd(), 'output', 'playwright');
const screenshotPrefix = process.env.LIVEKIT_FAILURE_SCREENSHOT_PREFIX ?? 'livekit-chunk-failure';
const emailDomain = process.env.LIVEKIT_FAILURE_EMAIL_DOMAIN ?? 'example.com';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, json };
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function registerUiUser(displayName) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `livekit-failure-${suffix}@${emailDomain}`;
  const password = `pass-${suffix}`;
  const verification = await requestJson(`${apiBase}/api/auth/verification-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert(verification.response.status === 202, `/api/auth/verification-code returned ${verification.response.status}`);
  assert(/^\d{6}$/.test(verification.json?.debugCode ?? ''), 'verification debugCode missing');

  const registered = await requestJson(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName,
      email,
      password,
      role: 'keeper',
      verificationCode: verification.json.debugCode,
    }),
  });
  assert(registered.response.status === 201, `/api/auth/register returned ${registered.response.status}`);
  return { account: registered.json.account, email, token: registered.json.token };
}

async function createRoom(token, name) {
  const created = await requestJson(`${apiBase}/api/rooms`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name, system: 'COC 7th', visibility: 'public' }),
  });
  assert(created.response.status === 201, `/api/rooms returned ${created.response.status}: ${JSON.stringify(created.json)}`);
  return created.json;
}

async function deleteRoom(token, roomId) {
  await requestJson(`${apiBase}/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

async function loggedContext(browser, token) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['microphone'],
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  });
  await context.addInitScript((value) => localStorage.setItem('paotuan.session', value), token);
  return context;
}

async function enterRoomFromLobby(page, roomName) {
  await page.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-shell', { timeout: 15000 });
  const roomCard = page.locator('.room-card', { hasText: roomName }).first();
  await roomCard.waitFor({ timeout: 15000 });
  await roomCard.getByRole('button', { name: /加入|重新加入|返回房间|进入/ }).first().click();
  if (await page.getByRole('button', { name: /守秘人/ }).count()) {
    await page.getByRole('button', { name: /守秘人/ }).click();
  }
  if (await page.getByRole('button', { name: /进入房间/ }).count()) {
    await page.getByRole('button', { name: /进入房间/ }).click();
  }
  await page.waitForSelector('.room-shell', { timeout: 15000 });
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const suffix = Date.now().toString(36);
  const owner = await registerUiUser('LiveKit Failure Owner');
  const room = await createRoom(owner.token, `LiveKit Failure ${suffix}`);
  let browser;
  const cleanupErrors = [];
  let testError = null;
  let chunkRequests = 0;

  try {
    browser = await chromium.launch();
    const context = await loggedContext(browser, owner.token);
    await context.route('**/api/livekit/token', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const payload = JSON.parse(route.request().postData() || '{}');
      const voiceSessionId = String(payload.voiceSessionId ?? 'chunkfailure0');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: true,
          url: 'wss://livekit.invalid',
          token: 'fake-livekit-token',
          identity: `${owner.account.id}:${voiceSessionId}`,
          roomName: `room:${room.id}`,
        }),
      });
    });
    await context.route('**/*livekit-client*.js*', async (route) => {
      chunkRequests += 1;
      await route.fulfill({
        status: 503,
        contentType: 'text/javascript',
        body: 'throw new Error("simulated livekit chunk failure");',
      });
    });

    const page = await context.newPage();
    await enterRoomFromLobby(page, room.name);
    await page.locator('.room-tabs button[aria-label="语音"]').click();
    await page.locator('.voice-panel').getByRole('button', { name: /加入语音/ }).click();
    await page.locator('.voice-panel', { hasText: '语音资源加载失败，请检查网络后重试。' }).waitFor({ timeout: 15000 });
    assert(chunkRequests >= 2, `expected standard and cache-busted chunk requests, got ${chunkRequests}`);
    const firstAttemptChunkRequests = chunkRequests;

    const retryButton = page.locator('.voice-panel').getByRole('button', { name: /加入语音/ });
    await retryButton.waitFor({ timeout: 15000 });
    assert(await retryButton.isEnabled(), 'voice retry button should be enabled after chunk failure');
    await retryButton.click();
    await page.waitForFunction(() => document.querySelector('.voice-panel')?.textContent?.includes('语音资源加载失败'), null, {
      timeout: 15000,
    });
    assert(
      chunkRequests > firstAttemptChunkRequests,
      `livekit dynamic import was not retried after failure; chunkRequests=${chunkRequests}`,
    );

    const screenshot = `${screenshotPrefix}-room-voice-chunk-failure.png`;
    await page.screenshot({ path: path.join(outputDir, screenshot), fullPage: false });
    console.log(JSON.stringify({ apiBase, frontendUrl, chunkRequests, screenshot, owner: owner.email }, null, 2));
  } catch (error) {
    testError = error;
  } finally {
    if (browser) {
      await browser.close().catch((error) => cleanupErrors.push(error));
    }
    await deleteRoom(owner.token, room.id).catch((error) => cleanupErrors.push(error));
  }

  if (cleanupErrors.length > 0) {
    const message = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
    if (testError) {
      console.error(`livekit chunk failure cleanup failed after test error: ${message}`);
    } else {
      throw new Error(`livekit chunk failure cleanup failed: ${message}`);
    }
  }
  if (testError) {
    throw testError;
  }
}

await main();

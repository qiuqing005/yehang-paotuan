import dns from 'node:dns';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const frontendUrl = process.env.UI_CHECK_FRONTEND_URL ?? 'http://localhost:5173';
const apiBase = process.env.UI_CHECK_API_BASE ?? frontendUrl;
const outputDir = process.env.UI_CHECK_OUTPUT_DIR ?? path.join(process.cwd(), 'output', 'playwright');
const screenshotPrefix = process.env.UI_CHECK_SCREENSHOT_PREFIX ?? 'remote';
const emailDomain = process.env.UI_CHECK_EMAIL_DOMAIN ?? 'example.com';

const cloudMailBaseUrl = process.env.UI_CHECK_CLOUD_MAIL_BASE_URL ?? 'https://mail.example.com';
const cloudMailEmail = process.env.UI_CHECK_CLOUD_MAIL_EMAIL ?? '';
const cloudMailPassword = process.env.UI_CHECK_CLOUD_MAIL_PASSWORD ?? '';
const cloudMailToken = process.env.UI_CHECK_CLOUD_MAIL_TOKEN ?? '';
const resolveIp = process.env.UI_CHECK_RESOLVE_IP ?? '';
const resolveHosts = new Set(
  (process.env.UI_CHECK_RESOLVE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
);

const frontendHost = new URL(frontendUrl).hostname;
const apiHost = new URL(apiBase).hostname;
const forcedHosts = resolveHosts.size > 0 ? resolveHosts : new Set([frontendHost, apiHost]);

if (resolveIp) {
  const lookup = dns.lookup.bind(dns);
  dns.lookup = (hostname, options, callback) => {
    if (forcedHosts.has(hostname)) {
      if (typeof options === 'function') {
        options(null, resolveIp, 4);
        return;
      }
      if (options?.all) {
        callback(null, [{ address: resolveIp, family: 4 }]);
        return;
      }
      callback(null, resolveIp, 4);
      return;
    }
    lookup(hostname, options, callback);
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function makeSolidPng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const rows = [];
  for (let row = 0; row < height; row += 1) {
    rows.push(Buffer.from([0]));
    for (let column = 0; column < width; column += 1) {
      rows.push(Buffer.from(rgba));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const avatarPng = makeSolidPng(32, 32, [23, 122, 109, 255]);

async function assertVisibleToast(page, selector, label) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'attached', timeout: 15000 });
  await page.waitForFunction(
    (targetSelector) => {
      const element = document.querySelector(targetSelector);
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity || '0');
      return (
        rect.width > 80 &&
        rect.height > 24 &&
        rect.right > 0 &&
        rect.left < window.innerWidth &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        opacity >= 0.6 &&
        style.visibility !== 'hidden'
      );
    },
    selector,
    { timeout: 15000 },
  );
  const metrics = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      height: rect.height,
      opacity: Number.parseFloat(style.opacity || '0'),
      visibility: style.visibility,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };
  });
  assert(
    metrics.width > 80 && metrics.height > 24 && metrics.opacity >= 0.6 && metrics.visibility !== 'hidden',
    `${label} toast is not visibly rendered: ${JSON.stringify(metrics)}`,
  );
  return metrics;
}

async function assertNoVisibleOverlap(page, subjectSelector, targetSelectors, label) {
  const overlaps = await page.evaluate(
    ({ subjectSelector: subject, targetSelectors: targets }) => {
      const subjectElement = document.querySelector(subject);
      if (!subjectElement) {
        return [{ selector: subject, reason: 'subject missing' }];
      }
      const subjectRect = subjectElement.getBoundingClientRect();
      const visibleRect = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0.05
        ) {
          return null;
        }
        return rect;
      };
      const activeSubjectRect = visibleRect(subjectElement);
      if (!activeSubjectRect) {
        return [{ selector: subject, reason: 'subject hidden' }];
      }
      return targets.flatMap((selector) =>
        [...document.querySelectorAll(selector)].flatMap((element) => {
          const rect = visibleRect(element);
          if (!rect) {
            return [];
          }
          const overlapX = Math.max(0, Math.min(subjectRect.right, rect.right) - Math.max(subjectRect.left, rect.left));
          const overlapY = Math.max(0, Math.min(subjectRect.bottom, rect.bottom) - Math.max(subjectRect.top, rect.top));
          const area = overlapX * overlapY;
          return area > 4
            ? [{
                selector,
                area,
                subject: {
                  bottom: subjectRect.bottom,
                  left: subjectRect.left,
                  right: subjectRect.right,
                  top: subjectRect.top,
                },
                target: {
                  bottom: rect.bottom,
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                },
              }]
            : [];
        }),
      );
    },
    { subjectSelector, targetSelectors },
  );
  assert(overlaps.length === 0, `${label} overlaps important UI: ${JSON.stringify(overlaps)}`);
}

async function requestJson(url, init, retries = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (error) {
        throw new Error(`Expected JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { response, json };
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

async function cloudMailLogin() {
  if (cloudMailToken) {
    return cloudMailToken;
  }

  assert(cloudMailEmail && cloudMailPassword, 'Cloud Mail credentials are required when debugCode is unavailable');
  const { response, json } = await requestJson(`${cloudMailBaseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: cloudMailEmail, password: cloudMailPassword }),
  });
  assert(response.ok, `/api/login returned ${response.status}`);
  assert(json?.code === 200, `/api/login failed: ${json?.message ?? 'unknown error'}`);
  assert(typeof json?.data?.token === 'string', 'Cloud Mail login missing token');
  return json.data.token;
}

async function cloudMailCreateMailbox(token, email) {
  const { response, json } = await requestJson(`${cloudMailBaseUrl}/api/account/add`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });
  assert(response.ok, `/api/account/add returned ${response.status}`);
  assert(json?.code === 200, `/api/account/add failed: ${json?.message ?? 'unknown error'}`);
}

async function cloudMailLatestMail(token, email) {
  const result = await requestJson(
    `${cloudMailBaseUrl}/api/allEmail/list?type=receive&accountEmail=${encodeURIComponent(email)}&size=1`,
    { headers: { Authorization: token } },
  );
  assert(result.response.ok, `/api/allEmail/list returned ${result.response.status}`);
  assert(result.json?.code === 200, `/api/allEmail/list failed: ${result.json?.message ?? 'unknown error'}`);
  return result.json?.data?.list?.[0] ?? null;
}

async function waitForCloudMailCode(token, email, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const mail = await cloudMailLatestMail(token, email);
    const body = `${mail?.code ?? ''}\n${mail?.subject ?? ''}\n${mail?.text ?? ''}\n${mail?.content ?? ''}`;
    const match = body.match(/\b\d{6}\b/);
    if (match) {
      return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Timed out waiting for Cloud Mail verification code for ${email}`);
}

async function registerUiUser(displayName = 'UI Check User', role = 'keeper') {
  const suffix = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`;
  const email = `ui-${suffix}@${emailDomain}`;
  const password = `pass-${suffix}`;
  let inboxToken = null;

  const hasCloudMail = cloudMailToken || (cloudMailEmail && cloudMailPassword);
  if (hasCloudMail) {
    inboxToken = await cloudMailLogin();
    await cloudMailCreateMailbox(inboxToken, email);
  }

  const verification = await requestJson(`${apiBase}/api/auth/verification-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert(verification.response.status === 202, `/api/auth/verification-code returned ${verification.response.status}`);

  let verificationCode = verification.json?.debugCode ?? '';
  if (!verificationCode && inboxToken) {
    verificationCode = await waitForCloudMailCode(inboxToken, email);
  }
  assert(/^\d{6}$/.test(verificationCode), 'verification code missing or invalid');

  const registered = await requestJson(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      displayName,
      role,
      verificationCode,
    }),
  });
  assert(registered.response.status === 201, `/api/auth/register returned ${registered.response.status}`);
  assert(typeof registered.json?.token === 'string', 'register missing token');
  assert(typeof registered.json?.account?.id === 'string', 'register missing account id');
  return { account: registered.json.account, email, token: registered.json.token };
}

async function requestFriend(token, email) {
  const { response, json } = await requestJson(`${apiBase}/api/friends`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });
  assert(response.status === 201, `/api/friends returned ${response.status}`);
  return json;
}

async function acceptFriend(token, friendId) {
  const { response, json } = await requestJson(`${apiBase}/api/friends/${friendId}/accept`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert(response.status === 200, `/api/friends/${friendId}/accept returned ${response.status}`);
  return json;
}

async function sendDirectMessage(token, friendId, text) {
  const { response, json } = await requestJson(`${apiBase}/api/friends/${friendId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  assert(response.status === 201, `/api/friends/${friendId}/messages returned ${response.status}`);
  return json;
}

async function createScript(token, input) {
  const { response, json } = await requestJson(`${apiBase}/api/scripts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  assert(response.status === 201, `/api/scripts returned ${response.status}`);
  return json;
}

async function createRoom(token, name, visibility, scriptId) {
  const { response, json } = await requestJson(`${apiBase}/api/rooms`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, system: 'COC 7th', visibility, scriptId }),
  });
  assert(response.status === 201, `/api/rooms returned ${response.status}`);
  return json;
}

async function deleteRoom(token, roomId) {
  const { response } = await requestJson(`${apiBase}/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert(response.status === 200, `/api/rooms/${roomId} DELETE returned ${response.status}`);
}

async function updateRoomPhase(token, roomId, phase) {
  const { response, json } = await requestJson(`${apiBase}/api/rooms/${roomId}/phase`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ phase }),
  });
  assert(response.status === 200, `/api/rooms/${roomId}/phase returned ${response.status}`);
  return json;
}

async function prepareRoomForRecruiting(token, roomId) {
  const { response, json } = await requestJson(`${apiBase}/api/rooms/${roomId}/preparation`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      summary: '远程 UI 检查公开剧情：玩家加入前应能看到模组前提和可选人设。',
      scriptCharacters: [
        {
          id: 'remote-ui-investigator',
          name: '远程检查调查员',
          count: 4,
          occupation: '私家侦探',
          publicSummary: '围绕异常案件行动的公开调查员人设。',
          story: '与案件委托方存在公开联系，适合进行 COC 7th 车卡。',
          parameters: '',
          privateBrief: '',
          recommendedSkills: [],
        },
      ],
    }),
  });
  assert(response.status === 200, `/api/rooms/${roomId}/preparation returned ${response.status}`);
  return json;
}

async function sendRoomMessage(token, roomId, text) {
  const { response, json } = await requestJson(`${apiBase}/api/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  assert(response.status === 201, `/api/rooms/${roomId}/messages returned ${response.status}`);
  return json;
}

async function loggedContext(browser, token, viewport, isMobile = false) {
  const context = await browser.newContext({
    viewport,
    isMobile,
    hasTouch: isMobile,
    deviceScaleFactor: isMobile ? 2 : 1,
    permissions: ['microphone'],
  });
  await context.addInitScript(({ sessionToken, configuredApiBase }) => {
    if (configuredApiBase) {
      window.__PAOTUAN_API_BASE__ = configuredApiBase;
    }
    localStorage.setItem('paotuan.session', sessionToken);
  }, { sessionToken: token, configuredApiBase: apiBase === frontendUrl ? '' : apiBase });
  return context;
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const user = await registerUiUser();
  const friend = await registerUiUser('UI Check Friend', 'player');
  const diceOwner = await registerUiUser('UI Dice Owner', 'keeper');
  await requestFriend(user.token, friend.email);
  await acceptFriend(friend.token, user.account.id);
  await sendDirectMessage(user.token, friend.account.id, 'UI 检查：好友私聊预置消息');
  for (let index = 1; index <= 45; index += 1) {
    await sendDirectMessage(user.token, friend.account.id, `UI 检查：分页私聊记录 ${String(index).padStart(2, '0')}`);
  }
  await sendDirectMessage(friend.token, user.account.id, 'UI 检查：好友发来的未读消息');
  const createdRooms = [];

  try {
    createdRooms.push(await createRoom(user.token, 'UI Public Room', 'public'));
    const room = createdRooms[0];
    const diceScript = await createScript(diceOwner.token, {
      title: `UI 骰子剧本 ${Date.now().toString(36)}`,
      summary: '用于检查房间聊天内的剧本骰子按钮。',
      visibility: 'private',
      diceProfiles: [
        { id: 'ui-script-check', label: '剧本检定', formula: '1d100<=60', probability: 0.6 },
      ],
    });
    const diceRoom = await createRoom(diceOwner.token, 'UI Dice Room', 'private', diceScript.id);
    createdRooms.push({ ...diceRoom, cleanupToken: diceOwner.token });
    assert(room.summary === '', 'blank room should not carry seed summary');
    assert(Array.isArray(room.scene?.tokens) && room.scene.tokens.length === 0, 'blank room should not carry seed tokens');
    assert(Array.isArray(room.characters) && room.characters.length === 0, 'blank room should not carry seed characters');
    assert(!JSON.stringify(room).includes('灰烬旅店'), 'blank room leaked seed room content');
    for (let index = 1; index <= 65; index += 1) {
      await sendRoomMessage(user.token, room.id, `UI 检查：历史团内记录 ${String(index).padStart(2, '0')}`);
    }

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        ...(resolveIp ? [`--host-resolver-rules=${[...forcedHosts].map((host) => `MAP ${host} ${resolveIp}`).join(',')}`] : []),
      ],
    });
    try {
    const loginPage = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    await loginPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await loginPage.waitForSelector('.auth-shell', { timeout: 15000 });
    await loginPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-login-desktop.png`),
      fullPage: false,
    });
    await loginPage.close();

    const desktopContext = await loggedContext(browser, user.token, { width: 1440, height: 980 });
    const desktopPage = await desktopContext.newPage();
    await desktopPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await desktopPage.waitForSelector('.home-shell', { timeout: 15000 });
    await desktopPage.waitForTimeout(700);
    await desktopPage.locator('.home-nav button', { hasText: '聊天' }).locator('.nav-badge', { hasText: '1' }).waitFor({ timeout: 15000 });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-home-desktop.png`),
      fullPage: false,
    });

    await desktopPage.getByRole('button', { name: /聊天/ }).click();
    await desktopPage.waitForSelector('.direct-chat', { timeout: 15000 });
    await desktopPage.locator('.chat-friend-list', { hasText: 'UI Check Friend' }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.direct-messages article', { hasText: '分页私聊记录 45' }).waitFor({ timeout: 15000 });
    assert((await desktopPage.locator('.direct-messages article', { hasText: '分页私聊记录 20' }).count()) === 0, 'direct chat should initially load the newest page only');
    await desktopPage.locator('.load-more-messages').click();
    await desktopPage.locator('.direct-messages article', { hasText: '分页私聊记录 20' }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.direct-messages article', { hasText: '好友发来的未读消息' }).waitFor({ timeout: 15000 });
    await desktopPage.waitForFunction(() => {
      const chatButton = [...document.querySelectorAll('.home-nav button')].find((button) => button.textContent?.includes('聊天'));
      return !chatButton?.querySelector('.nav-badge');
    }, null, { timeout: 15000 });
    await desktopPage.locator('.direct-input textarea').fill('UI 检查：主页好友聊天发送');
    await desktopPage.locator('.direct-input textarea').press('Enter');
    await desktopPage.locator('.direct-messages article', { hasText: '主页好友聊天发送' }).waitFor({ timeout: 15000 });
    await desktopPage.getByRole('button', { name: /聊天记录/ }).click();
    await desktopPage.locator('.chat-history-panel', { hasText: /已载入/ }).waitFor({ timeout: 15000 });
    const friendDirectContext = await loggedContext(browser, friend.token, { width: 1280, height: 860 });
    const friendDirectPage = await friendDirectContext.newPage();
    await friendDirectPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await friendDirectPage.waitForSelector('.home-shell', { timeout: 15000 });
    await friendDirectPage.getByRole('button', { name: /聊天/ }).click();
    await friendDirectPage.waitForSelector('.direct-chat', { timeout: 15000 });
    await friendDirectPage.locator('.chat-friend-list', { hasText: 'UI Check User' }).waitFor({ timeout: 15000 });

    await desktopPage.locator('.chat-tools button[title="语音通话"]').click();
    await desktopPage.locator('.direct-call-banner', { hasText: /正在呼叫/ }).waitFor({ timeout: 15000 });
    await friendDirectPage.locator('.direct-call-banner', { hasText: /请求语音通话/ }).waitFor({ timeout: 15000 });
    await friendDirectPage.locator('.direct-call-banner').getByRole('button', { name: /接听/ }).click();
    await desktopPage.locator('.direct-call-banner', { hasText: /已接通/ }).waitFor({ timeout: 15000 });
    await friendDirectPage.locator('.direct-call-banner', { hasText: /已接通/ }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.direct-call-banner').getByRole('button', { name: /^静音$/ }).waitFor({ timeout: 15000 });
    await friendDirectPage.locator('.direct-call-banner').getByRole('button', { name: /^静音$/ }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.direct-call-banner').getByRole('button', { name: /^静音$/ }).click();
    await desktopPage.locator('.direct-call-banner').getByRole('button', { name: /开麦/ }).waitFor({ timeout: 15000 });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-direct-chat-desktop.png`),
      fullPage: false,
    });
    await friendDirectPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-direct-chat-friend-accepted-desktop.png`),
      fullPage: false,
    });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-direct-chat-pagination-desktop.png`),
      fullPage: false,
    });
    await desktopPage.locator('.direct-call-banner').getByRole('button', { name: /挂断/ }).click();
    await desktopPage.locator('.direct-call-banner').waitFor({ state: 'hidden', timeout: 8000 });
    await friendDirectPage.locator('.direct-call-banner').waitFor({ state: 'hidden', timeout: 8000 });
    await friendDirectContext.close();
    await desktopPage.getByRole('button', { name: /账户/ }).click();
    await desktopPage.waitForSelector('.account-overview', { timeout: 15000 });
    await desktopPage.getByTitle('账户设置').click();
    await desktopPage.locator('.file-picker input[type="file"]').setInputFiles({
      name: 'ui-avatar.png',
      mimeType: 'image/png',
      buffer: avatarPng,
    });
    await desktopPage.locator('.status-line', { hasText: '头像已载入' }).waitFor({ timeout: 15000 });
    await desktopPage.getByRole('button', { name: /保存设置/ }).click();
    await desktopPage.locator('.status-line', { hasText: '已保存' }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.account-overview .large-avatar img').waitFor({ timeout: 15000 });
    const avatarSrc = await desktopPage.locator('.account-overview .large-avatar img').getAttribute('src');
    assert(avatarSrc?.startsWith('data:image/webp'), 'saved avatar should be the compressed uploaded image');
    await desktopPage.reload({ waitUntil: 'domcontentloaded' });
    await desktopPage.waitForSelector('.home-shell', { timeout: 15000 });
    await desktopPage.getByRole('button', { name: /账户/ }).click();
    await desktopPage.waitForSelector('.account-overview .large-avatar img', { timeout: 15000 });
    const reloadedAvatarSrc = await desktopPage.locator('.account-overview .large-avatar img').getAttribute('src');
    assert(reloadedAvatarSrc?.startsWith('data:image/webp'), 'uploaded avatar should survive reload');
    await desktopPage.locator('.friend-section', { hasText: '已添加好友' }).locator('.friend-row', { hasText: 'UI Check Friend' }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.friend-section', { hasText: '已添加好友' }).getByRole('button', { name: /删除/ }).first().waitFor({ timeout: 15000 });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-account-friends-desktop.png`),
      fullPage: false,
    });
    await desktopPage.getByRole('button', { name: /^剧本$/ }).click();
    await desktopPage.waitForSelector('.script-layout', { timeout: 15000 });
    await desktopPage.getByRole('button', { name: /新建/ }).click();
    await desktopPage.waitForSelector('.script-editor .editor-nav', { timeout: 15000 });
    const scriptTitle = `UI 自动剧本 ${Date.now().toString(36)}`;
    await desktopPage.locator('.script-editor .editor-page-grid label', { hasText: '标题' }).locator('input').fill(scriptTitle);
    await desktopPage.locator('.script-editor .editor-page-grid label', { hasText: '简介' }).locator('textarea').fill('UI 检查：剧本保存后刷新重载');
    await desktopPage.locator('.editor-nav').getByRole('button', { name: /地图/ }).click();
    await desktopPage.getByRole('button', { name: /新增地图/ }).click();
    await desktopPage.locator('.resource-card', { hasText: '新地图' }).locator('input').first().fill('UI 检查地图');
    await desktopPage.locator('.script-editor .panel-title').getByRole('button', { name: /保存/ }).click();
    await desktopPage.locator('.script-editor .status-line', { hasText: '已保存' }).waitFor({ timeout: 15000 });
    await desktopPage.reload({ waitUntil: 'domcontentloaded' });
    await desktopPage.waitForSelector('.home-shell', { timeout: 15000 });
    await desktopPage.getByRole('button', { name: /^剧本$/ }).click();
    await desktopPage.waitForSelector('.script-layout', { timeout: 15000 });
    await desktopPage.locator('.script-list-item', { hasText: scriptTitle }).getByRole('button').first().click();
    await desktopPage.locator('.script-editor .panel-title', { hasText: scriptTitle }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.editor-nav').getByRole('button', { name: /地图/ }).click();
    await desktopPage.locator('.resource-card', { hasText: 'UI 检查地图' }).waitFor({ timeout: 15000 });
    for (const tabName of ['地图', '人物', '骰子', '章节']) {
      await desktopPage.locator('.editor-nav').getByRole('button', { name: new RegExp(tabName) }).click();
      await desktopPage.waitForTimeout(120);
    }
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-script-editor-desktop.png`),
      fullPage: false,
    });
    await desktopPage.getByRole('button', { name: /^大厅$/ }).click();
    await desktopPage.waitForSelector('.room-card', { timeout: 15000 });

    const roomCard = desktopPage.locator('.room-card', { hasText: room.name }).first();
    await roomCard.waitFor({ timeout: 15000 });
    await roomCard.getByRole('button', { name: /加入|重新加入/ }).click();
    await desktopPage.locator('.join-dialog', { hasText: '你的房间身份：守秘人' }).waitFor({ timeout: 15000 });
    await desktopPage.getByRole('button', { name: /进入房间/ }).click();
    await desktopPage.waitForSelector('.room-shell', { timeout: 15000 });
    await desktopPage.waitForSelector('.room-flow-panel', { timeout: 15000 });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-room-flow-desktop.png`),
      fullPage: false,
    });

    await desktopPage.locator('.room-tabs').getByRole('button', { name: /地图/ }).click();
    await desktopPage.waitForSelector('.battle-board', { timeout: 15000 });
    await sendRoomMessage(user.token, room.id, 'UI 检查：地图页消息弹窗');
    const mapToast = await assertVisibleToast(desktopPage, '.room-message-toasts article', 'room map');
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-room-map-toast-desktop.png`),
      fullPage: false,
    });

    await desktopPage.locator('.room-tabs').getByRole('button', { name: /聊天/ }).click();
    await desktopPage.waitForSelector('.chat-panel .messages', { timeout: 15000 });
    await desktopPage.locator('.load-more-messages', { hasText: /加载更早记录/ }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.load-more-messages').click();
    await desktopPage.locator('.messages').evaluate((element) => {
      element.scrollTop = 0;
    });
    await desktopPage.locator('.messages article', { hasText: 'UI 检查：历史团内记录 01' }).waitFor({ timeout: 15000 });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-room-chat-history-desktop.png`),
      fullPage: false,
    });
    await desktopPage.locator('.messages').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const chatInput = desktopPage.locator('.chat-input input');
    await chatInput.fill('UI 检查：房间聊天发送');
    await chatInput.press('Enter');
    await desktopPage.locator('.messages article', { hasText: 'UI 检查：房间聊天发送' }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.messages article').last().click();
    await desktopPage.getByRole('button', { name: /回复/ }).click();
    await chatInput.fill('UI 检查：回复定位');
    await chatInput.press('Enter');
    await desktopPage.locator('.messages article', { hasText: 'UI 检查：回复定位' }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.message-reply-link', { hasText: '房间聊天发送' }).waitFor({ timeout: 15000 });
    await desktopPage.locator('.messages article').last().click();
    await desktopPage.getByRole('button', { name: /对此掷骰/ }).click();
    await desktopPage.waitForSelector('.roll-badge', { timeout: 15000 });
    await desktopPage.locator('.messages article', { hasText: '骰子：' }).waitFor({ timeout: 15000 });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-room-chat-reply-roll-desktop.png`),
      fullPage: false,
    });

    await desktopPage.locator('.room-tabs').getByRole('button', { name: /语音/ }).click();
    await desktopPage.waitForSelector('.voice-settings', { timeout: 15000 });
    await desktopPage.getByRole('button', { name: /加入语音/ }).click();
    await desktopPage.locator('.voice-list .voice-row', { hasText: 'UI Check User' }).waitFor({ timeout: 15000 });
    await desktopPage.getByRole('button', { name: /^静音$/ }).waitFor({ timeout: 15000 });
    await desktopPage.getByRole('button', { name: /^静音$/ }).click();
    await desktopPage.getByRole('button', { name: /取消静音/ }).waitFor({ timeout: 15000 });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-room-voice-joined-desktop.png`),
      fullPage: false,
    });
    await desktopPage.getByRole('button', { name: /断开/ }).click();
    await desktopPage.locator('.voice-list .empty-state', { hasText: '等待其他玩家加入语音' }).waitFor({ timeout: 15000 });
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-room-voice-desktop.png`),
      fullPage: false,
    });
    await desktopPage.locator('.room-header > .icon-button').first().click();
    await desktopPage.waitForSelector('.home-shell .active-room-lock', { timeout: 15000 });
    await desktopPage.waitForSelector('.floating-room-dock', { timeout: 15000 });
    await sendRoomMessage(user.token, room.id, 'UI 检查：挂起房间消息弹窗');
    const floatingToast = await assertVisibleToast(desktopPage, '.floating-room-popups article', 'floating room');
    await assertNoVisibleOverlap(
      desktopPage,
      '.floating-room-popups article',
      ['.active-room-lock', '.bottom-nav'],
      'floating room toast',
    );
    await desktopPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-floating-room-toast-desktop.png`),
      fullPage: false,
    });
    await desktopContext.close();

    const diceContext = await loggedContext(browser, diceOwner.token, { width: 1280, height: 860 });
    const dicePage = await diceContext.newPage();
    await dicePage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await dicePage.waitForSelector('.home-shell', { timeout: 15000 });
    const diceRoomCard = dicePage.locator('.room-card', { hasText: diceRoom.name }).first();
    await diceRoomCard.waitFor({ timeout: 15000 });
    await diceRoomCard.getByRole('button', { name: /加入|重新加入/ }).click();
    await dicePage.locator('.join-dialog', { hasText: '你的房间身份：守秘人' }).waitFor({ timeout: 15000 });
    await dicePage.getByRole('button', { name: /进入房间/ }).click();
    await dicePage.waitForSelector('.room-shell', { timeout: 15000 });
    await dicePage.locator('.room-tabs').getByRole('button', { name: /聊天/ }).click();
    await dicePage.getByRole('button', { name: /剧本检定/ }).waitFor({ timeout: 15000 });
    await dicePage.getByRole('button', { name: /剧本检定/ }).click();
    await dicePage.locator('.messages article', { hasText: '1d100<=60' }).waitFor({ timeout: 15000 });
    await dicePage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-room-script-dice-desktop.png`),
      fullPage: false,
    });
    await diceContext.close();

    const mobileContext = await loggedContext(browser, user.token, { width: 390, height: 844 }, true);
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await mobilePage.waitForSelector('.home-shell .bottom-nav', { timeout: 15000 });
    await mobilePage.waitForTimeout(700);
    await mobilePage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-home-mobile.png`),
      fullPage: false,
    });

    await mobilePage.getByRole('button', { name: /聊天/ }).click();
    await mobilePage.waitForSelector('.direct-chat', { timeout: 15000 });
    await mobilePage.getByRole('button', { name: /好友列表/ }).click();
    await mobilePage.waitForSelector('.chat-shell.friends-open .chat-search', { timeout: 15000 });
    await mobilePage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-direct-chat-mobile-friends.png`),
      fullPage: false,
    });
    await mobilePage.getByRole('button', { name: /大厅/ }).click();
    await mobilePage.waitForSelector('.room-card', { timeout: 15000 });

    const layout = await mobilePage.evaluate(() => {
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
      };
      const nav = document.querySelector('.bottom-nav');
      const main = document.querySelector('.home-main');
      const cards = [...document.querySelectorAll('.room-card')].map(rect);
      const navRect = nav ? rect(nav) : null;
      const mainRect = main ? rect(main) : null;
      const visibleOverlaps = navRect && mainRect
        ? cards.filter((card) => {
            const visibleTop = Math.max(card.top, mainRect.top);
            const visibleBottom = Math.min(card.bottom, mainRect.bottom);
            return visibleBottom > navRect.top && visibleTop < navRect.bottom;
          })
        : [];
      return { innerHeight, navRect, mainRect, cardCount: cards.length, visibleOverlaps };
    });
    assert(layout.navRect && layout.mainRect, 'mobile layout missing nav or main');
    assert(
      Math.abs(layout.mainRect.bottom - layout.navRect.top) <= 1.5,
      `mobile main/nav gap invalid: ${JSON.stringify(layout)}`,
    );
    assert(layout.visibleOverlaps.length === 0, `bottom nav overlaps visible room cards: ${JSON.stringify(layout)}`);
    await mobileContext.close();

    const androidContext = await browser.newContext({
      viewport: { width: 900, height: 700 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; YehangPaotuanAndroid) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
    });
    await androidContext.addInitScript(({ sessionToken, configuredApiBase }) => {
      if (configuredApiBase) {
        window.__PAOTUAN_API_BASE__ = configuredApiBase;
      }
      localStorage.setItem('paotuan.session', sessionToken);
    }, { sessionToken: friend.token, configuredApiBase: apiBase === frontendUrl ? '' : apiBase });
    const androidPage = await androidContext.newPage();
    await androidPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await androidPage.waitForSelector('html.force-mobile .home-shell .bottom-nav', { timeout: 15000 });
    await androidPage.waitForTimeout(700);
    await androidPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-android-force-mobile-wide.png`),
      fullPage: false,
    });
    const androidLayout = await androidPage.evaluate(() => {
      const nav = document.querySelector('.bottom-nav');
      const sideNav = document.querySelector('.home-nav');
      const htmlForced = document.documentElement.classList.contains('force-mobile');
      const navDisplay = nav ? getComputedStyle(nav).display : '';
      const sideNavDisplay = sideNav ? getComputedStyle(sideNav).display : '';
      return { htmlForced, navDisplay, sideNavDisplay };
    });
    assert(androidLayout.htmlForced, `android shell did not force mobile class: ${JSON.stringify(androidLayout)}`);
    assert(androidLayout.navDisplay !== 'none', `android bottom nav hidden: ${JSON.stringify(androidLayout)}`);
    assert(androidLayout.sideNavDisplay === 'none', `android side nav still visible: ${JSON.stringify(androidLayout)}`);
    await androidPage.getByRole('button', { name: /聊天/ }).click();
    await androidPage.waitForSelector('html.force-mobile .home-main.home-page-chat .direct-chat', { timeout: 15000 });
    await androidPage.getByRole('button', { name: /好友列表/ }).click();
    await androidPage.waitForSelector('html.force-mobile .chat-shell.friends-open .chat-search', { timeout: 15000 });
    const androidDrawerLayout = await androidPage.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          return null;
        }
        const item = element.getBoundingClientRect();
        return { top: item.top, bottom: item.bottom, left: item.left, right: item.right, width: item.width, height: item.height };
      };
      const drawer = rect('.chat-shell.friends-open .chat-friends');
      const nav = rect('.bottom-nav');
      return {
        drawer,
        nav,
        overlapsNav: Boolean(drawer && nav && drawer.bottom > nav.top && drawer.top < nav.bottom && drawer.right > nav.left && drawer.left < nav.right),
      };
    });
    assert(androidDrawerLayout.drawer && androidDrawerLayout.nav, `android chat drawer missing layout data: ${JSON.stringify(androidDrawerLayout)}`);
    assert(!androidDrawerLayout.overlapsNav, `android chat drawer overlaps bottom nav: ${JSON.stringify(androidDrawerLayout)}`);
    await androidPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-android-direct-chat-friends-wide.png`),
      fullPage: false,
    });
    await androidPage.getByRole('button', { name: /收起好友/ }).click();
    await androidPage.locator('.direct-input textarea').fill('UI 检查：Android 主页私聊发送');
    await androidPage.locator('.direct-input textarea').press('Enter');
    await androidPage.locator('.direct-messages article', { hasText: 'Android 主页私聊发送' }).waitFor({ timeout: 15000 });
    await androidPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-android-direct-chat-wide.png`),
      fullPage: false,
    });
    await androidPage.getByRole('button', { name: /大厅/ }).click();
    await prepareRoomForRecruiting(user.token, room.id);
    await updateRoomPhase(user.token, room.id, 'recruiting');
    await androidPage.waitForSelector('.room-card', { timeout: 15000 });
    const androidRoomCard = androidPage.locator('.room-card', { hasText: room.name }).first();
    await androidRoomCard.waitFor({ timeout: 15000 });
    await androidRoomCard.getByRole('button', { name: /加入|重新加入/ }).click();
    await androidPage.locator('.join-dialog', { hasText: '你的房间身份：玩家' }).waitFor({ timeout: 15000 });
    await androidPage.getByRole('button', { name: /进入房间/ }).click();
    await androidPage.waitForSelector('html.force-mobile .room-shell', { timeout: 15000 });
    await androidPage.waitForSelector('.room-flow-panel', { timeout: 15000 });
    await androidPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-android-room-flow-wide.png`),
      fullPage: false,
    });
    await androidPage.locator('.room-tabs').getByRole('button', { name: /聊天/ }).click();
    await androidPage.waitForSelector('.room-tab-chat .messages', { timeout: 15000 });
    await androidPage.locator('.chat-input input').fill('UI 检查：Android 房间聊天发送');
    await androidPage.locator('.chat-input input').press('Enter');
    await androidPage.locator('.messages article', { hasText: 'Android 房间聊天发送' }).waitFor({ timeout: 15000 });
    await androidPage.screenshot({
      path: path.join(outputDir, `${screenshotPrefix}-android-room-chat-wide.png`),
      fullPage: false,
    });
    await androidContext.close();

    console.log(JSON.stringify({
      frontendUrl,
      apiBase,
      user: user.email,
      screenshots: [
        `${screenshotPrefix}-login-desktop.png`,
        `${screenshotPrefix}-home-desktop.png`,
        `${screenshotPrefix}-direct-chat-desktop.png`,
        `${screenshotPrefix}-direct-chat-friend-accepted-desktop.png`,
        `${screenshotPrefix}-direct-chat-pagination-desktop.png`,
        `${screenshotPrefix}-account-friends-desktop.png`,
        `${screenshotPrefix}-script-editor-desktop.png`,
        `${screenshotPrefix}-room-flow-desktop.png`,
        `${screenshotPrefix}-room-map-toast-desktop.png`,
        `${screenshotPrefix}-room-chat-history-desktop.png`,
        `${screenshotPrefix}-room-chat-reply-roll-desktop.png`,
        `${screenshotPrefix}-room-script-dice-desktop.png`,
        `${screenshotPrefix}-room-voice-joined-desktop.png`,
        `${screenshotPrefix}-room-voice-desktop.png`,
        `${screenshotPrefix}-floating-room-toast-desktop.png`,
        `${screenshotPrefix}-home-mobile.png`,
        `${screenshotPrefix}-direct-chat-mobile-friends.png`,
        `${screenshotPrefix}-android-force-mobile-wide.png`,
        `${screenshotPrefix}-android-direct-chat-friends-wide.png`,
        `${screenshotPrefix}-android-direct-chat-wide.png`,
        `${screenshotPrefix}-android-room-flow-wide.png`,
        `${screenshotPrefix}-android-room-chat-wide.png`,
      ],
      mobileLayout: layout,
      mapToast,
      floatingToast,
    }, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    for (const room of createdRooms) {
      await deleteRoom(room.cleanupToken ?? user.token, room.id);
    }
  }
}

await main();

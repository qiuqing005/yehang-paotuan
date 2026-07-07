import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const frontendUrl = process.env.WHITE_SCREEN_FRONTEND_URL ?? 'http://localhost:5173';
const apiBase = process.env.WHITE_SCREEN_API_BASE ?? 'http://localhost:8787';
const outputDir = process.env.WHITE_SCREEN_OUTPUT_DIR ?? path.join(process.cwd(), 'output', 'playwright');
const emailDomain = process.env.WHITE_SCREEN_EMAIL_DOMAIN ?? 'example.com';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, json, text };
}

function auth(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function registerUser(prefix) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const emailPrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'white-screen';
  const email = `${emailPrefix}-${suffix}@${emailDomain}`;
  const password = `pass-${suffix}`;
  const verification = await requestJson(`${apiBase}/api/auth/verification-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert(verification.response.status === 202, `/api/auth/verification-code returned ${verification.response.status}`);
  const verificationCode = verification.json?.debugCode ?? '';
  assert(/^\d{6}$/.test(verificationCode), 'verification code missing from local server response');
  const registered = await requestJson(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: prefix,
      email,
      password,
      role: 'keeper',
      verificationCode,
    }),
  });
  assert(registered.response.status === 201, `/api/auth/register returned ${registered.response.status}: ${registered.text}`);
  return { account: registered.json.account, email, token: registered.json.token };
}

async function createScript(token, title) {
  const result = await requestJson(`${apiBase}/api/scripts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      title,
      system: 'COC 7th',
      visibility: 'public',
      summary: 'white screen navigation fixture',
      tags: ['ui'],
      coverUrl: '',
      maps: [
        {
          id: 'map-fixture',
          name: '测试地图',
          width: 12,
          height: 8,
          notes: '',
          features: [],
          tokens: [],
        },
      ],
      characters: [
        {
          id: 'char-fixture',
          name: '测试调查员',
          count: 2,
          occupation: '记者',
          publicSummary: '公开人设',
          privateBrief: '',
          parameters: '',
          story: '用于页面进入/返回巡检',
          recommendedSkills: [],
        },
      ],
      diceProfiles: [
        { id: 'dice-fixture', label: '侦查', formula: '1d100<=60', probability: 0.6 },
      ],
      chapters: [
        {
          id: 'chapter-fixture',
          title: '第一章',
          blocks: [
            { id: 'block-text', type: 'narrative', title: '开场', markdown: '测试剧情' },
            { id: 'block-map', type: 'map', title: '地图', mapId: 'map-fixture', notes: '' },
            { id: 'block-character', type: 'character', title: '人物', characterId: 'char-fixture', notes: '' },
            {
              id: 'block-check',
              type: 'check',
              title: '判定',
              diceId: 'dice-fixture',
              difficulty: 60,
              onPass: '成功',
              onFail: '失败',
            },
          ],
        },
      ],
    }),
  });
  assert(result.response.status === 201, `/api/scripts returned ${result.response.status}: ${result.text}`);
  return result.json;
}

async function createRoom(token, name, scriptId) {
  const result = await requestJson(`${apiBase}/api/rooms`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name, system: 'COC 7th', visibility: 'public', scriptId }),
  });
  assert(result.response.status === 201, `/api/rooms returned ${result.response.status}: ${result.text}`);
  return result.json;
}

async function loggedContext(browser, token, viewport, userAgent) {
  const context = await browser.newContext({ viewport, userAgent });
  await context.addInitScript(
    ({ configuredApiBase, sessionToken }) => {
      window.__PAOTUAN_API_BASE__ = configuredApiBase;
      localStorage.setItem('paotuan.session', sessionToken);
    },
    { configuredApiBase: apiBase, sessionToken: token },
  );
  return context;
}

async function corruptDataContext(browser, viewport, userAgent) {
  const token = 'legacy-token';
  const account = {
    id: 'legacy-account',
    email: 'legacy@example.com',
    displayName: '旧数据用户',
    avatar: '',
    role: 'keeper',
    createdAt: '',
    lastSeenAt: '',
  };
  const legacyRoom = {
    id: 'legacy-room',
    name: '旧数据房间',
    ownerId: account.id,
    ownerName: account.displayName,
    phase: 'module_locked',
    visibility: 'public',
    scene: {},
    voice: {},
  };
  const legacyMember = {
    accountId: account.id,
    displayName: account.displayName,
    avatar: '',
    role: 'keeper',
    joinedAt: '',
    lastSeenAt: '',
  };
  let roomJoined = false;
  const joinedLegacyRoom = () => ({
    ...legacyRoom,
    players: 1,
    memberIds: [account.id],
    members: [legacyMember],
    participantIds: [account.id],
    participants: [legacyMember],
    rosterIds: [account.id],
    roster: [legacyMember],
    rosterHistoryIds: [account.id],
  });
  const legacyScript = {
    id: 'legacy-script',
    title: '旧数据剧本',
    ownerId: account.id,
    ownerName: account.displayName,
    maps: [{ id: 'legacy-map' }],
    characters: [{ id: 'legacy-character' }],
    diceProfiles: [{ id: 'legacy-dice' }],
    chapters: [{ id: 'legacy-chapter', blocks: [{ id: 'legacy-block' }] }],
  };
  const context = await browser.newContext({ viewport, userAgent });
  await context.addInitScript(
    ({ configuredApiBase, sessionToken }) => {
      window.__PAOTUAN_DISABLE_REALTIME__ = true;
      window.__PAOTUAN_API_BASE__ = configuredApiBase;
      localStorage.setItem('paotuan.session', sessionToken);
    },
    { configuredApiBase: apiBase, sessionToken: token },
  );
  await context.route(`${apiBase}/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (url.pathname === '/api/auth/session') {
      await json(account);
      return;
    }
    if (url.pathname === '/api/friends') {
      await json([{}]);
      return;
    }
    if (url.pathname === '/api/rooms') {
      await json(url.searchParams.get('status') === 'closed' ? [] : [roomJoined ? joinedLegacyRoom() : legacyRoom]);
      return;
    }
    if (url.pathname === '/api/scripts') {
      await json([{ id: legacyScript.id, title: legacyScript.title }]);
      return;
    }
    if (url.pathname === `/api/scripts/${legacyScript.id}`) {
      await json(legacyScript);
      return;
    }
    if (url.pathname === `/api/rooms/${legacyRoom.id}/join` && method === 'POST') {
      roomJoined = true;
      await json(joinedLegacyRoom());
      return;
    }
    if (url.pathname === `/api/rooms/${legacyRoom.id}`) {
      await json(roomJoined ? joinedLegacyRoom() : legacyRoom);
      return;
    }
    await json({ ok: true });
  });
  return context;
}

async function assertNotWhite(page, label) {
  await page.waitForTimeout(100);
  const state = await page.evaluate(() => {
    const root = document.querySelector('#root');
    const text = root?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const bodyText = document.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const rootBox = root?.getBoundingClientRect();
    return {
      bodyTextLength: bodyText.length,
      rootText: text.slice(0, 300),
      rootTextLength: text.length,
      rootVisible: Boolean(rootBox && rootBox.width > 0 && rootBox.height > 0),
    };
  });
  assert(state.rootVisible, `${label}: #root is not visible: ${JSON.stringify(state)}`);
  assert(state.rootTextLength > 20, `${label}: page looks blank: ${JSON.stringify(state)}`);
  assert(!/Application error|TypeError|ReferenceError|Cannot read properties/i.test(state.rootText), `${label}: error text visible: ${state.rootText}`);
}

function attachErrorCapture(page, label, failures) {
  page.on('pageerror', (error) => failures.push(`${label} pageerror: ${error.stack || error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`${label} console error: ${message.text()}`);
    }
  });
}

async function clickAndAssert(page, locator, label) {
  try {
    await locator.click();
    await assertNotWhite(page, label);
  } catch (error) {
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'failure';
    await page.screenshot({ path: path.join(outputDir, `white-screen-${safeLabel}-failure.png`), fullPage: false }).catch(() => undefined);
    const state = await page.evaluate(() => ({
      url: window.location.href,
      rootText: document.querySelector('#root')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 800) ?? '',
      hasHomeShell: Boolean(document.querySelector('.home-shell')),
      hasRoomShell: Boolean(document.querySelector('.room-shell')),
      hasRoomHeader: Boolean(document.querySelector('.room-header')),
      hasMembersMenu: Boolean(document.querySelector('.room-members-menu')),
      buttons: [...document.querySelectorAll('button')].map((button) => ({
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        title: button.getAttribute('title') ?? '',
        aria: button.getAttribute('aria-label') ?? '',
        className: typeof button.className === 'string' ? button.className : '',
        visible: Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
      })).slice(0, 80),
    })).catch(() => null);
    throw new Error(`${label}: click/assert failed: ${error.message}\n${JSON.stringify(state, null, 2)}`);
  }
}

async function exerciseHomeNavigation(page, label) {
  await page.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-shell', { timeout: 15000 });
  await assertNotWhite(page, `${label}: home`);
  await clickAndAssert(page, page.getByRole('button', { name: /聊天/ }).first(), `${label}: chat`);
  await clickAndAssert(page, page.getByRole('button', { name: /账户/ }).first(), `${label}: account`);
  await clickAndAssert(page, page.getByTitle('账户设置'), `${label}: account settings open`);
  await page.evaluate(() => window.__PAOTUAN_HANDLE_NATIVE_BACK__?.());
  await assertNotWhite(page, `${label}: account settings native back`);
  await clickAndAssert(page, page.getByRole('button', { name: /剧本/ }).first(), `${label}: scripts`);
  await clickAndAssert(page, page.getByRole('button', { name: /新建/ }), `${label}: script new`);
  for (const name of ['地图', '人物', '骰子', '章节', '概览']) {
    await clickAndAssert(page, page.locator('.editor-nav').getByRole('button', { name: new RegExp(name) }), `${label}: script ${name}`);
  }
  await clickAndAssert(page, page.getByRole('button', { name: /大厅/ }).first(), `${label}: lobby back`);
}

async function exerciseRoomNavigation(page, roomName, label) {
  await page.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-shell', { timeout: 15000 });
  const roomCard = page.locator('.room-card', { hasText: roomName }).first();
  await roomCard.getByRole('button', { name: /加入|重新加入|返回房间|进入/ }).first().click();
  const roleDialog = page.locator('.join-dialog');
  if (await roleDialog.isVisible({ timeout: 3000 }).catch(() => false)) {
    const keeperButton = roleDialog.getByRole('button', { name: /守秘人/ });
    if (await keeperButton.count()) {
      await keeperButton.first().click();
    } else {
      await roleDialog.getByRole('button', { name: /玩家|旁观|加入|进入/ }).first().click();
    }
  }
  await page.waitForSelector('.room-shell', { timeout: 15000 });
  await assertNotWhite(page, `${label}: room entered`);
  for (const name of ['流程', '地图', '聊天', '角色', '语音']) {
    const button = page.locator('.room-tabs').getByRole('button', { name: new RegExp(name) }).first();
    if (await button.count()) {
      await clickAndAssert(page, button, `${label}: room tab ${name}`);
    }
  }
  await clickAndAssert(page, page.locator('.room-members-menu .icon-button').first(), `${label}: room members open`);
  try {
    await page.waitForSelector('.room-members-popover', { timeout: 5000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      rootText: document.querySelector('#root')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 800) ?? '',
      hasRoomShell: Boolean(document.querySelector('.room-shell')),
      membersButtonCount: document.querySelectorAll('.room-members-menu .icon-button').length,
      membersMenuText: document.querySelector('.room-members-menu')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      activeTab: document.querySelector('.room-tabs button.active')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    })).catch(() => null);
    throw new Error(`${label}: room members popover did not open: ${error.message}\n${JSON.stringify(state, null, 2)}`);
  }
  await page.evaluate(() => window.__PAOTUAN_HANDLE_NATIVE_BACK__?.());
  await page.waitForTimeout(100);
  await assertNotWhite(page, `${label}: room members native back`);
  await clickAndAssert(page, page.locator('.room-header .icon-button').first(), `${label}: room header back`);
  await page.waitForSelector('.home-shell', { timeout: 15000 });
  await assertNotWhite(page, `${label}: room suspended to lobby`);
  await clickAndAssert(page, page.locator('.floating-room-dock').first(), `${label}: floating room return`);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const suffix = Date.now().toString(36);
  const owner = await registerUser(`White Screen ${suffix}`);
  const script = await createScript(owner.token, `White Screen Script ${suffix}`);
  const room = await createRoom(owner.token, `White Screen Room ${suffix}`, script.id);
  const failures = [];
  const browser = await chromium.launch();
  try {
    const desktopContext = await loggedContext(browser, owner.token, { width: 1360, height: 900 });
    const desktopPage = await desktopContext.newPage();
    attachErrorCapture(desktopPage, 'desktop', failures);
    await exerciseHomeNavigation(desktopPage, 'desktop');
    await exerciseRoomNavigation(desktopPage, room.name, 'desktop');
    await desktopPage.screenshot({ path: path.join(outputDir, 'white-screen-desktop-final.png'), fullPage: false });
    await desktopContext.close();

    const androidContext = await loggedContext(
      browser,
      owner.token,
      { width: 390, height: 844 },
      'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 YehangPaotuanAndroid/1.0',
    );
    const androidPage = await androidContext.newPage();
    attachErrorCapture(androidPage, 'android', failures);
    await exerciseHomeNavigation(androidPage, 'android');
    await exerciseRoomNavigation(androidPage, room.name, 'android');
    await androidPage.screenshot({ path: path.join(outputDir, 'white-screen-android-final.png'), fullPage: false });
    await androidContext.close();

    const corruptContext = await corruptDataContext(
      browser,
      { width: 390, height: 844 },
      'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 YehangPaotuanAndroid/1.0',
    );
    const corruptPage = await corruptContext.newPage();
    attachErrorCapture(corruptPage, 'corrupt-data', failures);
    await corruptPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await corruptPage.waitForSelector('.home-shell', { timeout: 15000 });
    await assertNotWhite(corruptPage, 'corrupt-data: home');
    await clickAndAssert(corruptPage, corruptPage.getByRole('button', { name: /聊天/ }).first(), 'corrupt-data: chat');
    await clickAndAssert(corruptPage, corruptPage.getByRole('button', { name: /剧本/ }).first(), 'corrupt-data: scripts');
    await clickAndAssert(corruptPage, corruptPage.locator('.script-list-item').getByRole('button').first(), 'corrupt-data: legacy script');
    await clickAndAssert(corruptPage, corruptPage.locator('.editor-nav').getByRole('button', { name: /地图/ }), 'corrupt-data: legacy script maps');
    await clickAndAssert(corruptPage, corruptPage.getByRole('button', { name: /大厅/ }).first(), 'corrupt-data: lobby');
    await exerciseRoomNavigation(corruptPage, '旧数据房间', 'corrupt-data');
    await corruptPage.screenshot({ path: path.join(outputDir, 'white-screen-corrupt-data-final.png'), fullPage: false });
    await corruptContext.close();
  } finally {
    await browser.close();
  }
  assert(failures.length === 0, `captured page errors:\n${failures.join('\n')}`);
  console.log(JSON.stringify({ ok: true, owner: owner.email, room: room.name }, null, 2));
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});

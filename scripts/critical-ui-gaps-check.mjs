import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const frontendUrl = process.env.CRITICAL_UI_FRONTEND_URL ?? 'http://localhost:5173';
const apiBase = process.env.CRITICAL_UI_API_BASE ?? 'http://localhost:8787';
const outputDir = process.env.CRITICAL_UI_OUTPUT_DIR ?? path.join(process.cwd(), 'output', 'playwright');
const screenshotPrefix = process.env.CRITICAL_UI_SCREENSHOT_PREFIX ?? 'critical-ui';
const emailDomain = process.env.CRITICAL_UI_EMAIL_DOMAIN ?? 'example.com';
const avatarPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8Dwn4GBgYGJAQoAABXgAv5q5x7aAAAAAElFTkSuQmCC',
  'base64',
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function requestJson(url, options = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status !== 429 || typeof json?.retryAfterSeconds !== 'number' || attempt === 5) {
      return { response, json };
    }
    const retryAfterMs = Math.max(1, Math.ceil(json.retryAfterSeconds)) * 1000 + 50;
    await sleep(retryAfterMs);
  }
  throw new Error(`rate-limited request did not resolve: ${url}`);
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function registerUiUser(displayName, role = 'player') {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `critical-${suffix}@${emailDomain}`;
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
      role,
      verificationCode: verification.json.debugCode,
    }),
  });
  assert(registered.response.status === 201, `/api/auth/register returned ${registered.response.status}`);
  return { account: registered.json.account, email, token: registered.json.token };
}

async function createRoom(token, name, visibility = 'public', scriptId) {
  const created = await requestJson(`${apiBase}/api/rooms`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name, system: 'COC 7th', visibility, ...(scriptId ? { scriptId } : {}) }),
  });
  assert(
    created.response.status === 201,
    `/api/rooms "${name}" returned ${created.response.status}: ${JSON.stringify(created.json)}`,
  );
  return created.json;
}

async function updateRoomPhase(token, roomId, phase) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/phase`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ phase }),
  });
  assert(
    result.response.status === 200,
    `/api/rooms/${roomId}/phase ${phase} returned ${result.response.status}: ${JSON.stringify(result.json)}`,
  );
  return result.json;
}

async function expectRoomPhaseBlocked(token, roomId, phase, expectedErrorText) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/phase`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ phase }),
  });
  assert(
    result.response.status !== 200,
    `/api/rooms/${roomId}/phase ${phase} should be blocked but returned 200`,
  );
  assert(
    String(result.json?.error ?? '').includes(expectedErrorText),
    `/api/rooms/${roomId}/phase ${phase} returned unexpected error ${result.response.status}: ${JSON.stringify(result.json)}`,
  );
}

async function prepareRoomForRecruiting(token, roomId) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/preparation`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({
      summary: 'UI 检查公开剧情：玩家加入前应能看到模组前提和调查目标。',
      scriptCharacters: [
        {
          id: 'critical-ui-investigator',
          name: 'UI 检查调查员',
          count: 4,
          occupation: '记者',
          publicSummary: '负责追查异常事件的公开人设。',
          story: '与委托人存在公开关系，适合车卡后提交 KP 审核。',
          parameters: '',
          privateBrief: '',
          recommendedSkills: [],
        },
      ],
    }),
  });
  assert(result.response.status === 200, `/api/rooms/:id/preparation returned ${result.response.status}`);
  return result.json;
}

async function joinRoom(token, roomId, role = 'player') {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ role }),
  });
  assert(result.response.status === 200, `/api/rooms/:id/join returned ${result.response.status}`);
  return result.json;
}

function validSheetInput(name, options = {}) {
  return {
    scriptCharacterId: options.scriptCharacterId,
    name,
    occupation: '记者',
    age: 30,
    sex: '',
    residence: '',
    birthplace: '',
    attributes: { str: 50, con: 50, siz: 60, dex: 50, app: 50, int: 60, pow: 50, edu: 60, luck: 50 },
    skills: [
      { key: 'spotHidden', name: '侦查', base: 25, occupation: 20, interest: 0, growth: 0 },
      { key: 'listen', name: '聆听', base: 20, occupation: 0, interest: 20, growth: 0 },
      { key: 'libraryUse', name: '图书馆使用', base: 20, occupation: 30, interest: 0, growth: 0 },
      { key: 'persuade', name: '说服', base: 10, occupation: 20, interest: 0, growth: 0 },
      { key: 'psychology', name: '心理学', base: 10, occupation: 20, interest: 0, growth: 0 },
      { key: 'creditRating', name: '信用评级', base: 0, occupation: 15, interest: 0, growth: 0 },
      { key: 'dodge', name: '闪避', base: 25, occupation: 0, interest: 10, growth: 0 },
      { key: 'nativeLanguage', name: '母语', base: 60, occupation: 10, interest: 0, growth: 0 },
    ],
    background: {
      description: '调查记者，受雇追查异常失踪。',
      ideology: '',
      significantPeople: '',
      locations: '',
      possessions: '',
      traits: '',
    },
  };
}

async function submitCharacterSheet(token, roomId, sheet) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/character-sheets/me/submit`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(sheet),
  });
  assert([200, 201].includes(result.response.status), `/api/rooms/:id/character-sheets/me/submit returned ${result.response.status}`);
  return result.json;
}

async function reviewCharacterSheet(token, roomId, sheetId, status = 'approved') {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/character-sheets/${sheetId}/review`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ status }),
  });
  assert(result.response.status === 200, `/api/rooms/:id/character-sheets/:sheetId/review returned ${result.response.status}`);
  return result.json;
}

async function confirmCharacterSheet(token, roomId) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/character-sheets/me/confirm`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  assert(result.response.status === 200, `/api/rooms/:id/character-sheets/me/confirm returned ${result.response.status}`);
  return result.json;
}

async function createScript(token, title) {
  const result = await requestJson(`${apiBase}/api/scripts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      title,
      visibility: 'private',
      diceProfiles: [{ id: 'critical-dice', label: '侦查检定', formula: '1d100<=60', probability: 0.6 }],
    }),
  });
  assert(result.response.status === 201, `/api/scripts returned ${result.response.status}`);
  return result.json;
}

async function createRuntimeScript(token, title) {
  const result = await requestJson(`${apiBase}/api/scripts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      title,
      visibility: 'private',
      summary: 'UI 主持运行房：KP 公开剧情后玩家应只看到公开内容。',
      maps: [
        {
          id: 'critical-runtime-map-hall',
          name: '运行大厅',
          width: 10,
          height: 8,
          notes: '第一幕默认地图。',
          tokens: [
            { id: 'critical-runtime-token-player', characterId: 'critical-runtime-investigator', label: '调', color: '#187a6d', x: 3, y: 4, status: 'ready' },
          ],
        },
        {
          id: 'critical-runtime-map-archive',
          name: '档案室',
          width: 8,
          height: 6,
          notes: '旧档案柜挡住了墙角。',
          features: [{ id: 'critical-runtime-door', type: 'door', label: '侧门', x: 2, y: 2, w: 1, h: 1 }],
          tokens: [
            { id: 'critical-runtime-token-player-2', characterId: 'critical-runtime-investigator', label: '调', color: '#187a6d', x: 2, y: 3, status: 'ready' },
            { id: 'critical-runtime-token-hidden', characterId: 'critical-runtime-shadow', label: '?', color: '#4f5565', x: 7, y: 5, status: 'hidden' },
          ],
        },
      ],
      characters: [
        {
          id: 'critical-runtime-investigator',
          name: '运行调查员',
          count: 1,
          occupation: '记者',
          parameters: 'HP 11 / SAN 50',
          publicSummary: '负责追查档案室失踪记录的公开人设。',
          story: '与委托人存在公开关系。',
          privateBrief: '玩家不应在公开剧情页看到这条秘密。',
        },
        {
          id: 'critical-runtime-shadow',
          name: '档案室影子',
          count: 1,
          parameters: '',
          publicSummary: '传闻在档案室出现。',
          story: '',
          privateBrief: '隐藏 NPC。',
        },
      ],
      diceProfiles: [{ id: 'critical-runtime-dice', label: '侦查', formula: '1d100<=60', probability: 0.6 }],
      chapters: [
        {
          id: 'critical-runtime-chapter',
          title: '第一幕',
          blocks: [
            {
              id: 'critical-runtime-opening',
              type: 'narrative',
              title: '抵达运行台',
              markdown: '玩家抵达档案馆，门缝里透出反复闪烁的绿色灯光。',
            },
            {
              id: 'critical-runtime-map-block',
              type: 'map',
              title: '进入档案室',
              mapId: 'critical-runtime-map-archive',
              notes: '空气里有旧纸和铁锈味。',
            },
            {
              id: 'critical-runtime-check',
              type: 'check',
              title: '寻找档案',
              diceId: 'critical-runtime-dice',
              difficulty: 60,
              onPass: 'KP 私密成功叙述不应直接泄露。',
              onFail: 'KP 私密失败叙述不应直接泄露。',
            },
          ],
        },
      ],
    }),
  });
  assert(result.response.status === 201, `/api/scripts runtime returned ${result.response.status}`);
  return result.json;
}

async function deleteRoom(token, roomId) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  assert(result.response.status === 200 || result.response.status === 404, `/api/rooms/:id DELETE returned ${result.response.status}`);
}

async function deleteScript(token, scriptId) {
  const result = await requestJson(`${apiBase}/api/scripts/${scriptId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  assert(result.response.status === 204 || result.response.status === 404, `/api/scripts/:id DELETE returned ${result.response.status}`);
}

async function requestFriend(token, email) {
  const result = await requestJson(`${apiBase}/api/friends`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ email }),
  });
  assert(result.response.status === 201, `/api/friends returned ${result.response.status}`);
  return result.json;
}

async function acceptFriend(token, friendId) {
  const result = await requestJson(`${apiBase}/api/friends/${friendId}/accept`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  assert(result.response.status === 200, `/api/friends/:id/accept returned ${result.response.status}`);
  return result.json;
}

async function inviteRoomFriend(token, roomId, friendId) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/invitations`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ friendId }),
  });
  assert(result.response.status === 200, `/api/rooms/:id/invitations returned ${result.response.status}`);
  return result.json;
}

async function sendDirectMessage(token, friendId, text, options = {}) {
  const result = await requestJson(`${apiBase}/api/friends/${friendId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, ...options }),
  });
  assert(result.response.status === 201, `/api/friends/:id/messages returned ${result.response.status}`);
  return result.json;
}

async function sendRoomMessage(token, roomId, text, options = {}) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, ...options }),
  });
  assert(result.response.status === 201, `/api/rooms/:id/messages returned ${result.response.status}`);
  return result.json;
}

async function loggedContext(browser, token, viewport, userAgent) {
  const context = await browser.newContext({ viewport, permissions: ['microphone'], ...(userAgent ? { userAgent } : {}) });
  await context.addInitScript((value) => localStorage.setItem('paotuan.session', value), token);
  return context;
}

async function enterRoomFromLobby(page, roomName, role) {
  await page.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-shell', { timeout: 15000 });
  const roomCard = page.locator('.room-card', { hasText: roomName }).first();
  await roomCard.waitFor({ timeout: 15000 });
  const action = roomCard.getByRole('button', { name: /加入|重新加入|返回房间|进入/ }).first();
  await action.click();
  if (await page.getByRole('button', { name: role === 'keeper' ? /守秘人/ : /玩家/ }).count()) {
    await page.getByRole('button', { name: role === 'keeper' ? /守秘人/ : /玩家/ }).click();
  }
  if (await page.getByRole('button', { name: /进入房间/ }).count()) {
    await page.getByRole('button', { name: /进入房间/ }).click();
  }
  await page.waitForSelector('.room-shell', { timeout: 15000 });
  await page.waitForSelector('.room-flow-panel, .room-host-panel, .map-grid, .chat-panel, .voice-panel', { timeout: 15000 });
}

async function assertEmojiPopoverLayout(page, label) {
  await page.waitForSelector('.emoji-popover', { timeout: 15000 });
  const emojiLayout = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const item = element.getBoundingClientRect();
      return { top: item.top, bottom: item.bottom, left: item.left, right: item.right, width: item.width, height: item.height };
    };
    const popover = rect('.emoji-popover');
    const input = rect('.direct-input');
    const nav = rect('.bottom-nav');
    const directChat = rect('.direct-chat');
    const scrollButton = rect('.scroll-to-bottom.direct');
    const overlaps = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
    const containedBy = (a, b) => Boolean(a && b && a.left >= b.left && a.top >= b.top && a.right <= b.right && a.bottom <= b.bottom);
    return {
      directChat,
      input,
      nav,
      popover,
      scrollButton,
      insideDirectChat: containedBy(popover, directChat),
      insideViewport: Boolean(popover && popover.left >= 0 && popover.top >= 0 && popover.right <= innerWidth && popover.bottom <= innerHeight),
      overlapsInput: overlaps(popover, input),
      overlapsNav: overlaps(popover, nav),
      overlapsScrollButton: overlaps(popover, scrollButton),
    };
  });
  assert(emojiLayout.popover && emojiLayout.insideViewport, `${label} emoji popover should stay inside viewport: ${JSON.stringify(emojiLayout)}`);
  assert(emojiLayout.insideDirectChat, `${label} emoji popover is clipped by direct chat bounds: ${JSON.stringify(emojiLayout)}`);
  assert(!emojiLayout.overlapsInput, `${label} emoji popover overlaps direct input: ${JSON.stringify(emojiLayout)}`);
  assert(!emojiLayout.overlapsNav, `${label} emoji popover overlaps bottom nav: ${JSON.stringify(emojiLayout)}`);
  assert(!emojiLayout.overlapsScrollButton, `${label} emoji popover overlaps scroll-to-bottom button: ${JSON.stringify(emojiLayout)}`);
}

async function assertNoHorizontalOverflow(page, selector, label) {
  const overflow = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  let offenders = [];
  if (overflow.scrollWidth > overflow.clientWidth + 2) {
    offenders = await page.locator(selector).evaluate((root) => {
      const rootRect = root.getBoundingClientRect();
      return [...root.querySelectorAll('*')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const className = typeof element.className === 'string' ? element.className : '';
          return {
            tag: element.tagName.toLowerCase(),
            className,
            text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) ?? '',
            left: Math.round(rect.left - rootRect.left),
            right: Math.round(rect.right - rootRect.left),
            width: Math.round(rect.width),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            display: style.display,
            overflowX: style.overflowX,
          };
        })
        .filter((item) => item.right > root.clientWidth + 2 || item.scrollWidth > item.clientWidth + 2)
        .sort((a, b) => Math.max(b.right - root.clientWidth, b.scrollWidth - b.clientWidth) - Math.max(a.right - root.clientWidth, a.scrollWidth - a.clientWidth))
        .slice(0, 8);
    });
  }
  assert(
    overflow.scrollWidth <= overflow.clientWidth + 2,
    `${label} has horizontal overflow: ${JSON.stringify({ ...overflow, offenders })}`,
  );
}

async function dragFloatingDockToBottomRight(page, label) {
  const dock = page.locator('.floating-room-dock');
  await dock.waitFor({ state: 'visible', timeout: 15000 });
  const box = await dock.boundingBox();
  assert(box, `${label} floating dock missing bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(500, 900, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const dock = document.querySelector('.floating-room-dock')?.getBoundingClientRect();
    const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
    if (!dock || !nav) {
      return false;
    }
    return dock.bottom <= nav.top - 4 && dock.left >= 0 && dock.right <= innerWidth;
  }, null, { timeout: 15000 });
  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const item = element.getBoundingClientRect();
      return { top: item.top, bottom: item.bottom, left: item.left, right: item.right, width: item.width, height: item.height };
    };
    const dock = rect('.floating-room-dock');
    const nav = rect('.bottom-nav');
    const overlaps = Boolean(dock && nav && dock.left < nav.right && dock.right > nav.left && dock.top < nav.bottom && dock.bottom > nav.top);
    return { dock, nav, overlaps };
  });
  assert(!layout.overlaps, `${label} floating dock overlaps bottom nav after drag: ${JSON.stringify(layout)}`);
}

async function assertSmallScriptEditorLayout(page) {
  const layout = await page.evaluate(() => {
    const nav = document.querySelector('.editor-nav');
    const navButtons = [...document.querySelectorAll('.editor-nav button')];
    const rowTops = new Set(navButtons.map((button) => Math.round(button.getBoundingClientRect().top)));
    const editor = document.querySelector('.script-editor');
    const diceMini = document.querySelector('.dice-mini');
    return {
      diceMiniColumns: diceMini ? getComputedStyle(diceMini).gridTemplateColumns.split(' ').length : 0,
      editorClientWidth: editor?.clientWidth ?? 0,
      editorScrollWidth: editor?.scrollWidth ?? 0,
      navButtons: navButtons.length,
      navClientWidth: nav?.clientWidth ?? 0,
      navRows: rowTops.size,
      navScrollWidth: nav?.scrollWidth ?? 0,
    };
  });
  assert(layout.navButtons >= 5, `small script editor should render all nav buttons: ${JSON.stringify(layout)}`);
  assert(layout.navRows >= 2, `small script editor nav should wrap instead of forcing five cramped columns: ${JSON.stringify(layout)}`);
  assert(layout.diceMiniColumns === 1, `small script dice editor should collapse to one column: ${JSON.stringify(layout)}`);
  assert(layout.navScrollWidth <= layout.navClientWidth + 2, `small script nav overflows horizontally: ${JSON.stringify(layout)}`);
  assert(layout.editorScrollWidth <= layout.editorClientWidth + 2, `small script editor overflows horizontally: ${JSON.stringify(layout)}`);
}

async function expectButtonVisibleAndClickable(page, locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  const metrics = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const centerElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      bottom: rect.bottom,
      covered: !(centerElement && (centerElement === element || element.contains(centerElement))),
      disabled: element instanceof HTMLButtonElement ? element.disabled : false,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
    };
  });
  assert(!metrics.disabled, `${label} button should be enabled: ${JSON.stringify(metrics)}`);
  assert(!metrics.covered, `${label} button is covered: ${JSON.stringify(metrics)}`);
  assert(
    metrics.left >= 0 &&
      metrics.right <= metrics.viewportWidth &&
      metrics.top >= 0 &&
      metrics.bottom <= metrics.viewportHeight &&
      metrics.width > 24 &&
      metrics.height > 24,
    `${label} button should be inside viewport: ${JSON.stringify(metrics)}`,
  );
}

async function assertFocusedInputClearOfBottomChrome(page, inputSelector, blockerSelector, label) {
  await page.locator(inputSelector).focus();
  await page.waitForTimeout(250);
  await page.waitForFunction(
    ({ inputSelector: targetInputSelector, blockerSelector: targetBlockerSelector }) => {
      const input = document.querySelector(targetInputSelector)?.getBoundingClientRect();
      const blocker = document.querySelector(targetBlockerSelector)?.getBoundingClientRect();
      const active = document.activeElement;
      return Boolean(
        input &&
          blocker &&
          active?.matches?.(targetInputSelector) &&
          input.top >= 0 &&
          input.left >= 0 &&
          input.right <= innerWidth &&
          input.bottom <= blocker.top + 1,
      );
    },
    { inputSelector, blockerSelector },
    { timeout: 15000 },
  );
  const metrics = await page.evaluate(
    ({ inputSelector: targetInputSelector, blockerSelector: targetBlockerSelector }) => {
      const input = document.querySelector(targetInputSelector)?.getBoundingClientRect();
      const blocker = document.querySelector(targetBlockerSelector)?.getBoundingClientRect();
      const active = document.activeElement;
      return {
        activeTag: active?.tagName,
        focused: Boolean(active?.matches?.(targetInputSelector)),
        input: input ? { bottom: input.bottom, left: input.left, right: input.right, top: input.top } : null,
        blocker: blocker ? { top: blocker.top } : null,
        width: innerWidth,
      };
    },
    { inputSelector, blockerSelector },
  );
  assert(metrics.focused, `${label} input should keep focus: ${JSON.stringify(metrics)}`);
}

async function assertSmallRoomFlowLayout(page) {
  await page.waitForSelector('html.force-mobile .room-flow-panel .sheet-editor', { timeout: 15000 });
  const layout = await page.evaluate(() => {
    const content = document.querySelector('.room-content');
    const panel = document.querySelector('.room-flow-panel');
    const sheet = document.querySelector('.sheet-editor');
    const skill = document.querySelector('.skill-table');
    const side = document.querySelector('.flow-side');
    const contentRect = content?.getBoundingClientRect();
    const sheetRect = sheet?.getBoundingClientRect();
    const skillRect = skill?.getBoundingClientRect();
    const sideRect = side?.getBoundingClientRect();
    const sideOverlapsSheet = Boolean(
      sideRect &&
        sheetRect &&
        sideRect.left < sheetRect.right &&
        sideRect.right > sheetRect.left &&
        sideRect.top < sheetRect.bottom &&
        sideRect.bottom > sheetRect.top,
    );
    return {
      contentClientWidth: content?.clientWidth ?? 0,
      contentScrollWidth: content?.scrollWidth ?? 0,
      panelClientWidth: panel?.clientWidth ?? 0,
      panelScrollWidth: panel?.scrollWidth ?? 0,
      sheetClientWidth: sheet?.clientWidth ?? 0,
      sheetScrollWidth: sheet?.scrollWidth ?? 0,
      sideBottom: sideRect?.bottom ?? 0,
      sideOverlapsSheet,
      sideTop: sideRect?.top ?? 0,
      skillClientWidth: skill?.clientWidth ?? 0,
      skillContained: Boolean(contentRect && skillRect && skillRect.left >= contentRect.left - 1 && skillRect.right <= contentRect.right + 1),
      skillScrollWidth: skill?.scrollWidth ?? 0,
    };
  });
  assert(layout.contentScrollWidth <= layout.contentClientWidth + 2, `small flow content overflows horizontally: ${JSON.stringify(layout)}`);
  assert(layout.panelScrollWidth <= layout.panelClientWidth + 2, `small flow panel overflows horizontally: ${JSON.stringify(layout)}`);
  assert(layout.sheetScrollWidth <= layout.sheetClientWidth + 2, `small sheet editor overflows horizontally: ${JSON.stringify(layout)}`);
  assert(layout.skillContained, `small flow skill table escapes its container: ${JSON.stringify(layout)}`);
  assert(layout.skillScrollWidth >= layout.skillClientWidth, `small skill table should keep horizontal overflow inside itself: ${JSON.stringify(layout)}`);
  assert(!layout.sideOverlapsSheet, `small flow side panel overlaps the sheet editor: ${JSON.stringify(layout)}`);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const suffix = Date.now().toString(36);
  const cleanupRooms = [];
  const cleanupScripts = [];
  const screenshots = [];
  let emptyRecruitOwner;
  let owner;
  let player;
  let browser;
  let testError;
  const cleanupErrors = [];
  try {
    emptyRecruitOwner = await registerUiUser('Critical Empty Keeper', 'keeper');
    owner = await registerUiUser('Critical UI Keeper', 'keeper');
    player = await registerUiUser('Critical UI Player', 'player');
    const smallPlayer = await registerUiUser('Critical Small Player', 'player');
    const accessVisitor = await registerUiUser('Critical Access Visitor', 'player');
    const confirmOwner = await registerUiUser('Critical Confirm Keeper', 'keeper');
    const confirmPlayer = await registerUiUser('Critical Confirm Player', 'player');
    const runtimeOwner = await registerUiUser('Critical Runtime Keeper', 'keeper');
    const runtimePlayer = await registerUiUser('Critical Runtime Player', 'player');
    const chatFriend = await registerUiUser('Critical Chat Friend', 'player');
    const chatAltFriend = await registerUiUser('Critical Chat Alt', 'player');
    const emptyRecruitRoom = await createRoom(emptyRecruitOwner.token, `Critical Empty Recruit ${suffix}`);
    cleanupRooms.push({ token: emptyRecruitOwner.token, roomId: emptyRecruitRoom.id });
    await prepareRoomForRecruiting(emptyRecruitOwner.token, emptyRecruitRoom.id);
    await updateRoomPhase(emptyRecruitOwner.token, emptyRecruitRoom.id, 'recruiting');
    await expectRoomPhaseBlocked(
      emptyRecruitOwner.token,
      emptyRecruitRoom.id,
      'chargen',
      '进入车卡前至少需要 1 名已加入名单的玩家。',
    );
    const room = await createRoom(owner.token, `Critical Flow ${suffix}`);
    cleanupRooms.push({ token: owner.token, roomId: room.id });
    await prepareRoomForRecruiting(owner.token, room.id);
    await updateRoomPhase(owner.token, room.id, 'recruiting');
    await joinRoom(player.token, room.id, 'player');
    await joinRoom(smallPlayer.token, room.id, 'player');
    await updateRoomPhase(owner.token, room.id, 'chargen');
    await requestFriend(owner.token, accessVisitor.email);
    await acceptFriend(accessVisitor.token, owner.account.id);
    await inviteRoomFriend(owner.token, room.id, accessVisitor.account.id);
    await joinRoom(accessVisitor.token, room.id, 'player');
    const script = await createScript(owner.token, `Critical Dice ${suffix}`);
    cleanupScripts.push({ token: owner.token, scriptId: script.id });
    const confirmRoom = await createRoom(confirmOwner.token, `Critical Confirm ${suffix}`);
    cleanupRooms.push({ token: confirmOwner.token, roomId: confirmRoom.id });
    await prepareRoomForRecruiting(confirmOwner.token, confirmRoom.id);
    await updateRoomPhase(confirmOwner.token, confirmRoom.id, 'recruiting');
    await joinRoom(confirmPlayer.token, confirmRoom.id, 'player');
    await updateRoomPhase(confirmOwner.token, confirmRoom.id, 'chargen');
    const confirmSubmitted = await submitCharacterSheet(confirmPlayer.token, confirmRoom.id, validSheetInput('Critical Confirm Investigator'));
    await updateRoomPhase(confirmOwner.token, confirmRoom.id, 'review');
    await reviewCharacterSheet(confirmOwner.token, confirmRoom.id, confirmSubmitted.sheet.id, 'approved');
    const runtimeScript = await createRuntimeScript(runtimeOwner.token, `Critical Runtime ${suffix}`);
    cleanupScripts.push({ token: runtimeOwner.token, scriptId: runtimeScript.id });
    const runtimeRoom = await createRoom(runtimeOwner.token, `Critical Runtime ${suffix}`, 'public', runtimeScript.id);
    cleanupRooms.push({ token: runtimeOwner.token, roomId: runtimeRoom.id });
    await updateRoomPhase(runtimeOwner.token, runtimeRoom.id, 'recruiting');
    await joinRoom(runtimePlayer.token, runtimeRoom.id, 'player');
    await updateRoomPhase(runtimeOwner.token, runtimeRoom.id, 'chargen');
    const runtimeSubmitted = await submitCharacterSheet(runtimePlayer.token, runtimeRoom.id, validSheetInput('Critical Runtime Investigator', {
      scriptCharacterId: 'critical-runtime-investigator',
    }));
    await updateRoomPhase(runtimeOwner.token, runtimeRoom.id, 'review');
    await reviewCharacterSheet(runtimeOwner.token, runtimeRoom.id, runtimeSubmitted.sheet.id, 'approved');
    await confirmCharacterSheet(runtimePlayer.token, runtimeRoom.id);
    await updateRoomPhase(runtimeOwner.token, runtimeRoom.id, 'casting');
    await updateRoomPhase(runtimeOwner.token, runtimeRoom.id, 'playing');
    await requestFriend(owner.token, chatFriend.email);
    await acceptFriend(chatFriend.token, owner.account.id);
    await requestFriend(owner.token, chatAltFriend.email);
    await acceptFriend(chatAltFriend.token, owner.account.id);
    const directReplyAnchor = await sendDirectMessage(owner.token, chatFriend.account.id, 'Critical direct reply anchor 01');
    for (let index = 2; index <= 45; index += 1) {
      await sendDirectMessage(owner.token, chatFriend.account.id, `Critical direct scroll ${String(index).padStart(2, '0')}`);
    }
    await sendDirectMessage(owner.token, chatFriend.account.id, 'Critical direct reply to oldest anchor', { replyToId: directReplyAnchor.id });
    await sendDirectMessage(chatFriend.token, owner.account.id, 'Critical direct latest incoming');

    const roomSeedMessages = [];
    for (let index = 1; index <= 60; index += 1) {
      roomSeedMessages.push(
        await sendRoomMessage(owner.token, room.id, `Critical room older anchor ${String(index).padStart(2, '0')}`),
      );
    }
    const replyAnchor = roomSeedMessages[0];
    await sendRoomMessage(owner.token, room.id, 'Critical room reply to older anchor', { replyToId: replyAnchor.id });

    browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });

    const emptyRecruitContext = await loggedContext(browser, emptyRecruitOwner.token, { width: 1440, height: 980 });
    const emptyRecruitPage = await emptyRecruitContext.newPage();
    await enterRoomFromLobby(emptyRecruitPage, `Critical Empty Recruit ${suffix}`, 'keeper');
    await emptyRecruitPage.locator('.flow-blocker', { hasText: '至少需要 1 名玩家加入名单' }).first().waitFor({ timeout: 15000 });
    await emptyRecruitPage.locator('.flow-side', { hasText: '名单 0' }).waitFor({ timeout: 15000 });
    assert(await emptyRecruitPage.getByRole('button', { name: /关闭报名，进入车卡/ }).isDisabled(), 'chargen button should be disabled before any PL joins');
    screenshots.push(`${screenshotPrefix}-flow-blocker-recruiting-empty-roster-desktop.png`);
    await emptyRecruitPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await emptyRecruitContext.close();

    const ownerContext = await loggedContext(browser, owner.token, { width: 1440, height: 980 });
    const ownerPage = await ownerContext.newPage();
    await enterRoomFromLobby(ownerPage, `Critical Flow ${suffix}`, 'keeper');
    await ownerPage.locator('.flow-blocker', { hasText: '至少需要 1 张已提交角色卡' }).first().waitFor({ timeout: 15000 });
    await ownerPage.getByRole('button', { name: /进入集中审核/ }).waitFor({ state: 'visible', timeout: 15000 });
    assert(await ownerPage.getByRole('button', { name: /进入集中审核/ }).isDisabled(), 'review button should be disabled before any submitted sheet is visible to KP');
    screenshots.push(`${screenshotPrefix}-flow-blocker-chargen-no-submit-desktop.png`);
    await ownerPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });

    await ownerPage.locator('.room-tabs').getByRole('button', { name: /聊天/ }).click();
    await ownerPage.waitForSelector('.chat-panel .messages', { timeout: 15000 });
    assert(
      await ownerPage.locator(`.messages article[data-message-id="${replyAnchor.id}"]`).count() === 0,
      'reply target should not be in the initial room message DOM before cross-page locate',
    );
    await ownerPage.locator('.message-reply-link', { hasText: 'Critical room older anchor 01' }).first().click();
    await ownerPage.waitForFunction(
      (messageId) => {
        const container = document.querySelector('.messages');
        const target = document.querySelector(`.messages article[data-message-id="${CSS.escape(messageId)}"]`);
        if (!container || !target || !target.classList.contains('selected')) {
          return false;
        }
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        return targetRect.top >= containerRect.top && targetRect.bottom <= containerRect.bottom;
      },
      replyAnchor.id,
      { timeout: 15000 },
    );
    screenshots.push(`${screenshotPrefix}-room-reply-locate-older-desktop.png`);
    await ownerPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await ownerContext.close();

    const accessContext = await loggedContext(browser, accessVisitor.token, { width: 390, height: 844 });
    const accessPage = await accessContext.newPage();
    await enterRoomFromLobby(accessPage, `Critical Flow ${suffix}`, 'player');
    if (await accessPage.locator('.room-tabs').getByRole('button', { name: /流程/ }).count()) {
      await accessPage.locator('.room-tabs').getByRole('button', { name: /流程/ }).click();
    }
    await accessPage.locator('.room-flow-panel', { hasText: '旁观访问' }).waitFor({ timeout: 15000 });
    assert(await accessPage.locator('.sheet-editor').count() === 0, 'access-only visitor should not see character sheet editor');
    screenshots.push(`${screenshotPrefix}-access-only-room-flow-mobile.png`);
    await accessPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await accessContext.close();

    const runtimeOwnerContext = await loggedContext(browser, runtimeOwner.token, { width: 1440, height: 980 });
    const runtimeOwnerPage = await runtimeOwnerContext.newPage();
    await enterRoomFromLobby(runtimeOwnerPage, `Critical Runtime ${suffix}`, 'keeper');
    await runtimeOwnerPage.waitForSelector('.room-host-panel .host-block-list', { timeout: 15000 });
    await assertNoHorizontalOverflow(runtimeOwnerPage, '.room-host-panel', 'Desktop KP host panel');
    await runtimeOwnerPage.locator('.host-block-list article', { hasText: '抵达运行台' }).getByRole('button', { name: /^公开$/ }).click();
    await runtimeOwnerPage.locator('.public-story-item', { hasText: '抵达运行台' }).waitFor({ timeout: 15000 });
    await runtimeOwnerPage.locator('.host-block-list article', { hasText: '进入档案室' }).getByRole('button', { name: /切换并公开/ }).click();
    await runtimeOwnerPage.locator('.public-story-item.map', { hasText: '进入档案室' }).waitFor({ timeout: 15000 });
    await runtimeOwnerPage.locator('.host-block-list article', { hasText: '寻找档案' }).getByRole('button', { name: /^公开$/ }).click();
    await runtimeOwnerPage.locator('.public-story-item.check', { hasText: '寻找档案' }).waitFor({ timeout: 15000 });
    assert(
      await runtimeOwnerPage.getByText('KP 私密成功叙述不应直接泄露').count() === 0,
      'private check success text should not render in KP public feed',
    );
    screenshots.push(`${screenshotPrefix}-playing-kp-host-desktop.png`);
    await runtimeOwnerPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await runtimeOwnerContext.close();

    const runtimePlayerContext = await loggedContext(
      browser,
      runtimePlayer.token,
      { width: 390, height: 844 },
      'Mozilla/5.0 (Linux; Android 13; Runtime Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    );
    const runtimePlayerPage = await runtimePlayerContext.newPage();
    await enterRoomFromLobby(runtimePlayerPage, `Critical Runtime ${suffix}`, 'player');
    await runtimePlayerPage.waitForSelector('html.force-mobile .room-host-panel .public-story-item', { timeout: 15000 });
    await runtimePlayerPage.locator('.public-story-item', { hasText: '抵达运行台' }).waitFor({ timeout: 15000 });
    await runtimePlayerPage.locator('.public-story-item.map', { hasText: '进入档案室' }).waitFor({ timeout: 15000 });
    assert(await runtimePlayerPage.locator('.host-block-list').count() === 0, 'player should not see KP host block list');
    assert(await runtimePlayerPage.getByText('玩家不应在公开剧情页看到这条秘密').count() === 0, 'player should not see private character brief');
    assert(await runtimePlayerPage.getByText('KP 私密失败叙述不应直接泄露').count() === 0, 'player should not see private check failure text');
    await assertNoHorizontalOverflow(runtimePlayerPage, '.room-host-panel', 'Mobile player public story panel');
    screenshots.push(`${screenshotPrefix}-playing-player-public-mobile.png`);
    await runtimePlayerPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await runtimePlayerContext.close();

    const runtimeSmallContext = await loggedContext(
      browser,
      runtimePlayer.token,
      { width: 320, height: 568 },
      'Mozilla/5.0 (Linux; Android 13; Runtime Small Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    );
    const runtimeSmallPage = await runtimeSmallContext.newPage();
    await enterRoomFromLobby(runtimeSmallPage, `Critical Runtime ${suffix}`, 'player');
    await runtimeSmallPage.waitForSelector('html.force-mobile .room-host-panel .public-story-item', { timeout: 15000 });
    await assertNoHorizontalOverflow(runtimeSmallPage, '.room-host-panel', 'Small Android public story panel');
    const runtimeSmallTabs = await runtimeSmallPage.evaluate(() => {
      const buttons = [...document.querySelectorAll('.room-tabs button')].map((button) => button.getBoundingClientRect());
      return new Set(buttons.map((rect) => Math.round(rect.top))).size;
    });
    assert(runtimeSmallTabs === 1, `small runtime room tabs should stay on one row: ${runtimeSmallTabs}`);
    screenshots.push(`${screenshotPrefix}-android-small-playing-public-story.png`);
    await runtimeSmallPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await runtimeSmallContext.close();

    const scriptContext = await loggedContext(browser, owner.token, { width: 1440, height: 980 });
    const scriptPage = await scriptContext.newPage();
    await scriptPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await scriptPage.waitForSelector('.home-shell', { timeout: 15000 });
    await scriptPage.getByRole('button', { name: /剧本/ }).click();
    await scriptPage.getByText(script.title).first().click();
    await scriptPage.locator('.editor-nav button').nth(1).click();
    await scriptPage.waitForSelector('.script-map-preview', { timeout: 15000 });
    const featureSection = scriptPage.locator('.map-object-editor section', { hasText: '地图要素' }).first();
    await featureSection.getByRole('button', { name: /新增/ }).click();
    const featureRow = featureSection.locator('.feature-row').first();
    await featureRow.locator('input[aria-label="要素标签"]').fill('UI侧门');
    await featureRow.locator('select').selectOption('door');
    const mapNumberInputs = scriptPage.locator('.resource-card').first().locator('.mini-editor input');
    await mapNumberInputs.nth(1).fill('999');
    await mapNumberInputs.nth(2).fill('0');
    assert(await mapNumberInputs.nth(1).inputValue() === '40', 'map width should clamp to 40');
    assert(await mapNumberInputs.nth(2).inputValue() === '4', 'map height should clamp to 4');
    await featureRow.locator('input[aria-label="X"]').fill('999');
    await featureRow.locator('input[aria-label="Y"]').fill('-5');
    await featureRow.locator('input[aria-label="宽"]').fill('999');
    await featureRow.locator('input[aria-label="高"]').fill('999');
    assert(await featureRow.locator('input[aria-label="X"]').inputValue() === '40', 'feature X should clamp to map width');
    assert(await featureRow.locator('input[aria-label="Y"]').inputValue() === '1', 'feature Y should clamp to minimum');
    assert(await featureRow.locator('input[aria-label="宽"]').inputValue() === '1', 'feature width should clamp inside map bounds');
    assert(await featureRow.locator('input[aria-label="高"]').inputValue() === '4', 'feature height should clamp to map height');
    const tokenSection = scriptPage.locator('.map-object-editor section', { hasText: '棋子 / NPC' }).first();
    await tokenSection.getByRole('button', { name: /新增/ }).click();
    const tokenRow = tokenSection.locator('.token-row').first();
    await tokenRow.locator('input[aria-label="棋子标签"]').fill('UI');
    await tokenRow.locator('select').nth(1).selectOption('npc');
    await tokenRow.locator('input[aria-label="棋子X"]').fill('999');
    await tokenRow.locator('input[aria-label="棋子Y"]').fill('-5');
    assert(await tokenRow.locator('input[aria-label="棋子X"]').inputValue() === '40', 'token X should clamp to map width');
    assert(await tokenRow.locator('input[aria-label="棋子Y"]').inputValue() === '1', 'token Y should clamp to minimum');
    await scriptPage.locator('.script-map-preview .map-feature.door', { hasText: 'UI侧门' }).waitFor({ timeout: 15000 });
    await scriptPage.locator('.script-map-preview .script-map-token.npc', { hasText: 'UI' }).waitFor({ timeout: 15000 });
    await assertNoHorizontalOverflow(scriptPage, '.script-editor', 'Desktop script map editor');
    await scriptPage.getByRole('button', { name: /^保存$/ }).click();
    await scriptPage.locator('.status-line', { hasText: '已保存' }).waitFor({ timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-script-map-objects-desktop.png`);
    await scriptPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await scriptPage.locator('.editor-nav button').nth(3).click();
    await scriptPage.waitForSelector('.dice-mini input', { timeout: 15000 });
    await scriptPage.locator('.dice-mini input').nth(1).fill('spot hidden');
    await scriptPage.locator('.field-error', { hasText: '骰子公式格式错误' }).waitFor({ timeout: 15000 });
    assert(await scriptPage.locator('.resource-card.has-error').count() > 0, 'invalid dice card should be marked');
    assert(await scriptPage.locator('.dice-mini input[aria-invalid="true"]').count() > 0, 'invalid dice input should set aria-invalid');
    screenshots.push(`${screenshotPrefix}-script-dice-invalid-desktop.png`);
    await scriptPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await scriptContext.close();

    await submitCharacterSheet(player.token, room.id, validSheetInput('Critical Investigator'));

    const playerContext = await loggedContext(browser, player.token, { width: 390, height: 844 });
    const playerPage = await playerContext.newPage();
    await playerPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await playerPage.waitForSelector('.home-shell', { timeout: 15000 });
    const playerRoomCard = playerPage.locator('.room-card', { hasText: `Critical Flow ${suffix}` }).first();
    await playerRoomCard.waitFor({ timeout: 15000 });
    await playerRoomCard.getByRole('button', { name: /加入|重新加入|返回房间|进入/ }).first().click();
    await playerPage.locator('.join-dialog', { hasText: '你的房间身份：玩家' }).waitFor({ timeout: 15000 });
    assert(await playerPage.locator('.join-dialog').getByRole('button', { name: /^守秘人$/ }).count() === 0, 'non-owner join dialog should not offer keeper role');
    screenshots.push(`${screenshotPrefix}-player-join-role-dialog-mobile.png`);
    await playerPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await playerPage.getByRole('button', { name: /进入房间/ }).click();
    await playerPage.waitForSelector('.room-shell', { timeout: 15000 });
    await playerPage.waitForSelector('.room-flow-panel', { timeout: 15000 });
    await playerPage.locator('.sheet-lock-note', { hasText: '角色卡已提交' }).first().waitFor({ timeout: 15000 });
    const editableControls = await playerPage.locator('.sheet-editor input:not([disabled]), .sheet-editor select:not([disabled]), .sheet-editor textarea:not([disabled])').count();
    assert(editableControls === 0, `submitted sheet should lock all controls, found ${editableControls}`);
    assert(await playerPage.getByRole('button', { name: /保存草稿/ }).isDisabled(), 'save draft should be disabled after submit');
    assert(await playerPage.getByRole('button', { name: /提交KP审核/ }).isDisabled(), 'submit should be disabled after submit');
    screenshots.push(`${screenshotPrefix}-character-sheet-submitted-locked-mobile.png`);
    await playerPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await playerContext.close();

    const confirmContext = await loggedContext(browser, confirmPlayer.token, { width: 390, height: 844 });
    const confirmPage = await confirmContext.newPage();
    await enterRoomFromLobby(confirmPage, `Critical Confirm ${suffix}`, 'player');
    await confirmPage.locator('.sheet-confirm-panel', { hasText: 'KP 已通过此角色卡' }).waitFor({ timeout: 15000 });
    const confirmSheetButton = confirmPage.locator('.sheet-confirm-panel').getByRole('button', { name: /^确认使用此角色$/ });
    await expectButtonVisibleAndClickable(confirmPage, confirmSheetButton, 'approved sheet top confirm');
    screenshots.push(`${screenshotPrefix}-character-sheet-approved-confirm-mobile.png`);
    await confirmPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await confirmSheetButton.click();
    await confirmPage.locator('.sheet-lock-note', { hasText: '已确认使用此角色' }).waitFor({ timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-character-sheet-confirmed-mobile.png`);
    await confirmPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await confirmContext.close();

    const androidContext = await loggedContext(
      browser,
      owner.token,
      { width: 390, height: 844 },
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    );
    const androidPage = await androidContext.newPage();
    await androidPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await androidPage.waitForSelector('.home-shell', { timeout: 15000 });
    assert(await androidPage.locator('html.force-mobile').count() === 1, 'Android portrait should force mobile class');
    assert(await androidPage.locator('.bottom-nav').isVisible(), 'bottom nav should be visible on Android portrait');
    assert(!(await androidPage.locator('.home-nav').isVisible()), 'desktop home nav should be hidden on Android portrait');
    screenshots.push(`${screenshotPrefix}-android-force-mobile-portrait-home.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });

    await androidPage.getByRole('button', { name: /账户/ }).click();
    await androidPage.locator('.page-header', { hasText: '账户' }).waitFor({ timeout: 15000 });
    await androidPage.locator('button[title="账户设置"]').click();
    await androidPage.locator('.file-input-hidden').setInputFiles({
      name: 'android-avatar.png',
      mimeType: 'application/octet-stream',
      buffer: avatarPng,
    });
    await androidPage.locator('.status-line', { hasText: '头像已载入' }).waitFor({ timeout: 15000 });
    await androidPage.getByRole('button', { name: /保存设置/ }).click();
    await androidPage.locator('.status-line', { hasText: '已保存' }).waitFor({ timeout: 15000 });
    await androidPage.locator('.large-avatar img').waitFor({ timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-avatar-octet-upload.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });

    await androidPage.getByRole('button', { name: /聊天/ }).click();
    await androidPage.waitForSelector('html.force-mobile .direct-chat', { timeout: 15000 });
    await androidPage.locator('.direct-messages article', { hasText: 'Critical direct latest incoming' }).waitFor({ timeout: 15000 });
    await androidPage.waitForFunction(() => {
      const input = document.querySelector('.direct-input')?.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
      return Boolean(input && nav && input.bottom <= nav.top + 1);
    }, null, { timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-portrait-direct-chat-input.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await assertFocusedInputClearOfBottomChrome(androidPage, '.direct-input textarea', '.bottom-nav', 'Android portrait direct chat');
    screenshots.push(`${screenshotPrefix}-android-portrait-direct-chat-input-focused.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });

    await androidPage.locator('.direct-messages article', { hasText: 'Critical direct reply to oldest anchor' })
      .locator('.message-reply-link')
      .click();
    await androidPage.locator('.direct-messages article.selected', { hasText: 'Critical direct reply anchor 01' }).waitFor({ timeout: 15000 });
    await androidPage.locator('.direct-message-action-bar').getByRole('button', { name: /回复/ }).click();
    await androidPage.locator('.direct-reply-composer', { hasText: 'Critical direct reply anchor 01' }).waitFor({ timeout: 15000 });
    await androidPage.waitForFunction(() => {
      const input = document.querySelector('.direct-input')?.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
      const list = document.querySelector('.direct-messages');
      return Boolean(input && nav && list && input.bottom <= nav.top + 1 && list.scrollHeight > list.clientHeight);
    }, null, { timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-portrait-direct-reply-locate.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await androidPage.locator('.direct-reply-composer button[title="取消回复"]').click();

    const friendCallContext = await loggedContext(
      browser,
      chatFriend.token,
      { width: 390, height: 844 },
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    );
    const friendCallPage = await friendCallContext.newPage();
    await friendCallPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await friendCallPage.waitForSelector('.home-shell', { timeout: 15000 });

    await androidPage.locator('.chat-tools button[title="语音通话"]').click();
    await androidPage.locator('.direct-call-banner', { hasText: /正在呼叫/ }).waitFor({ timeout: 15000 });
    await friendCallPage.locator('.global-call-banner', { hasText: /请求语音通话/ }).waitFor({ timeout: 15000 });
    await friendCallPage.waitForFunction(() => {
      const banner = document.querySelector('.global-call-banner')?.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
      const root = document.documentElement;
      return Boolean(
        banner &&
          nav &&
          root.scrollWidth <= innerWidth + 2 &&
          banner.left >= 10 &&
          banner.right <= innerWidth - 10 &&
          banner.top >= 0 &&
          banner.bottom < nav.top,
      );
    }, null, { timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-portrait-direct-call-banner.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    screenshots.push(`${screenshotPrefix}-android-portrait-global-direct-call-banner.png`);
    await friendCallPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await friendCallPage.locator('.global-call-banner').getByRole('button', { name: /接听/ }).click();
    await androidPage.locator('.direct-call-banner', { hasText: /已接通/ }).waitFor({ timeout: 15000 });
    await androidPage.locator('.direct-call-banner').getByRole('button', { name: /^静音$/ }).waitFor({ timeout: 15000 });
    await androidPage.waitForFunction(() => {
      const banner = document.querySelector('.direct-call-banner')?.getBoundingClientRect();
      const list = document.querySelector('.direct-messages');
      const input = document.querySelector('.direct-input')?.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
      const root = document.documentElement;
      if (!banner || !list || !input || !nav) {
        return false;
      }
      return root.scrollWidth <= innerWidth + 2 &&
        list.scrollWidth <= list.clientWidth + 2 &&
        banner.left >= -1 &&
        banner.right <= innerWidth + 1 &&
        banner.bottom <= input.top + 1 &&
        input.bottom <= nav.top + 1;
    }, null, { timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-portrait-direct-call-accepted.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await androidPage.locator('.direct-call-banner').getByRole('button', { name: /挂断/ }).click();
    await androidPage.locator('.direct-call-banner').waitFor({ state: 'hidden', timeout: 8000 });
    await friendCallPage.locator('.global-call-banner').waitFor({ state: 'hidden', timeout: 8000 });
    await friendCallContext.close();

    const directInputTopBeforeScroll = await androidPage.locator('.direct-input').evaluate((element) => element.getBoundingClientRect().top);
    await androidPage.locator('.direct-messages').evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await androidPage.locator('.scroll-to-bottom.direct').waitFor({ state: 'visible', timeout: 15000 });
    const directInputTopAfterScroll = await androidPage.locator('.direct-input').evaluate((element) => element.getBoundingClientRect().top);
    assert(
      Math.abs(directInputTopAfterScroll - directInputTopBeforeScroll) <= 1.5,
      `direct input moved with message scroll: before=${directInputTopBeforeScroll}, after=${directInputTopAfterScroll}`,
    );
    screenshots.push(`${screenshotPrefix}-direct-chat-mobile-scroll-bottom.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await androidPage.locator('.scroll-to-bottom.direct').click();
    await androidPage.waitForFunction(() => {
      const list = document.querySelector('.direct-messages');
      return Boolean(list && list.scrollHeight - list.scrollTop - list.clientHeight <= 4);
    }, null, { timeout: 15000 });

    await androidPage.getByRole('button', { name: 'emoji' }).click();
    await assertEmojiPopoverLayout(androidPage, 'Android portrait');
    screenshots.push(`${screenshotPrefix}-direct-chat-mobile-emoji.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });

    await enterRoomFromLobby(androidPage, `Critical Flow ${suffix}`, 'keeper');
    await androidPage.locator('.room-tabs').getByRole('button', { name: /聊天/ }).click();
    await androidPage.waitForSelector('html.force-mobile .room-tab-chat .messages', { timeout: 15000 });
    await androidPage.locator('.messages article', { hasText: 'Critical room reply to older anchor' }).waitFor({ timeout: 15000 });
    await androidPage.waitForFunction(() => {
      const input = document.querySelector('.chat-input')?.getBoundingClientRect();
      const tabs = document.querySelector('.room-tabs')?.getBoundingClientRect();
      const status = document.querySelector('.room-chat-status')?.getBoundingClientRect();
      const sendButton = document.querySelector('.chat-input button[type="submit"]')?.getBoundingClientRect();
      if (!input || !tabs || !sendButton) {
        return false;
      }
      const buttonCenterX = sendButton.left + sendButton.width / 2;
      const buttonCenterY = sendButton.top + sendButton.height / 2;
      const centerElement = document.elementFromPoint(buttonCenterX, buttonCenterY);
      const sendButtonVisible = Boolean(centerElement && (centerElement.closest?.('.chat-input button[type="submit"]') || centerElement.closest?.('.chat-input')));
      const clearOfStatus = !status || input.top >= status.bottom - 1 || input.bottom <= status.top + 1;
      return input.left >= 0 &&
        input.right <= innerWidth &&
        input.top >= 0 &&
        input.bottom <= tabs.top + 1 &&
        clearOfStatus &&
        sendButtonVisible;
    }, null, { timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-portrait-room-chat-input.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await assertFocusedInputClearOfBottomChrome(androidPage, '.chat-input input', '.room-tabs', 'Android portrait room chat');
    screenshots.push(`${screenshotPrefix}-android-portrait-room-chat-input-focused.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });

    const selectedRoomActionText = 'Critical room older anchor 60';
    const androidRoomReplyArticle = androidPage.locator('.messages article', { hasText: selectedRoomActionText }).first();
    await androidRoomReplyArticle.click();
    await androidPage.locator('.message-action-bar', { hasText: /对此掷骰/ }).waitFor({ timeout: 15000 });
    await androidPage.locator('.message-action-bar').getByRole('button', { name: /回复/ }).click();
    await androidPage.locator('.reply-composer', { hasText: selectedRoomActionText }).waitFor({ timeout: 15000 });
    await androidPage.locator('.reply-composer > button').nth(1).click();
    await androidRoomReplyArticle.click();
    await androidPage.locator('.message-action-bar').getByRole('button', { name: /对此掷骰/ }).click();
    const selectedRoomDiceMessage = androidPage.locator('.messages article', { hasText: '1d100<=50 =' }).last();
    await selectedRoomDiceMessage.locator('.message-reply-link', { hasText: selectedRoomActionText }).waitFor({ timeout: 15000 });
    await selectedRoomDiceMessage.locator('.roll-badge').waitFor({ timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-portrait-room-selected-dice.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    const nativeBackHandled = await androidPage.evaluate(() => Boolean(window.__PAOTUAN_HANDLE_NATIVE_BACK__?.()));
    assert(nativeBackHandled, 'native back handler should consume room page back');
    await androidPage.waitForSelector('html.force-mobile .home-shell .bottom-nav', { timeout: 15000 });
    await androidPage.locator('.floating-room-dock').waitFor({ timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-portrait-native-back-room-suspended.png`);
    await androidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await androidContext.close();

    const smallAndroidContext = await loggedContext(
      browser,
      owner.token,
      { width: 320, height: 568 },
      'Mozilla/5.0 (Linux; Android 13; Small Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    );
    const smallAndroidPage = await smallAndroidContext.newPage();
    await smallAndroidPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await smallAndroidPage.waitForSelector('html.force-mobile .home-shell .bottom-nav', { timeout: 15000 });
    await smallAndroidPage.getByRole('button', { name: /聊天/ }).click();
    await smallAndroidPage.waitForSelector('html.force-mobile .direct-chat', { timeout: 15000 });
    const chatFriendButton = smallAndroidPage.locator('.chat-friends button[title="Critical Chat Friend"]');
    const chatAltFriendButton = smallAndroidPage.locator('.chat-friends button[title="Critical Chat Alt"]');
    await chatFriendButton.click();
    await smallAndroidPage.locator('.direct-messages article', { hasText: 'Critical direct latest incoming' }).waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.direct-input textarea').fill('draft for critical chat friend');
    await chatAltFriendButton.click();
    await smallAndroidPage.locator('.direct-input textarea').fill('draft for critical chat alt');
    await chatFriendButton.click();
    assert(
      await smallAndroidPage.locator('.direct-input textarea').inputValue() === 'draft for critical chat friend',
      'direct chat draft should be isolated for first friend',
    );
    await chatAltFriendButton.click();
    assert(
      await smallAndroidPage.locator('.direct-input textarea').inputValue() === 'draft for critical chat alt',
      'direct chat draft should be isolated for second friend',
    );

    let releaseBlockedDirectFailure;
    let directFailureRequestStarted;
    let directFailureFulfilled;
    const directFailureReleased = new Promise((resolve) => {
      releaseBlockedDirectFailure = resolve;
    });
    const directFailureRequest = new Promise((resolve) => {
      directFailureRequestStarted = resolve;
    });
    const directFailureDone = new Promise((resolve) => {
      directFailureFulfilled = resolve;
    });
    const directFailureRoute = async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() === 'POST' &&
        url.pathname === `/api/friends/${chatFriend.account.id}/messages`
      ) {
        const body = request.postDataJSON();
        assert(body.replyToId === directReplyAnchor.id, `direct retry failure request lost replyToId: ${JSON.stringify(body)}`);
        directFailureRequestStarted();
        await directFailureReleased;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'forced direct chat failure' }),
        });
        directFailureFulfilled();
        return;
      }
      await route.continue();
    };
    await smallAndroidPage.route('**/api/friends/*/messages', directFailureRoute);
    await chatFriendButton.click();
    await smallAndroidPage.locator('.direct-messages article', { hasText: 'Critical direct reply to oldest anchor' })
      .locator('.message-reply-link')
      .click();
    await smallAndroidPage.locator('.direct-messages article.selected', { hasText: 'Critical direct reply anchor 01' }).waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.direct-message-action-bar').getByRole('button', { name: /回复/ }).click();
    await smallAndroidPage.locator('.direct-reply-composer', { hasText: 'Critical direct reply anchor 01' }).waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.direct-input textarea').fill('critical isolated direct failure');
    await smallAndroidPage.locator('.direct-input .primary-action').click();
    await withTimeout(directFailureRequest, 10000, 'direct failure request');
    await chatAltFriendButton.click();
    assert(
      !(await smallAndroidPage.locator('.direct-input .primary-action').isDisabled()),
      'direct chat send button for second friend should not be disabled by first friend pending send',
    );
    releaseBlockedDirectFailure();
    await withTimeout(directFailureDone, 10000, 'direct failure response');
    assert(
      await smallAndroidPage.locator('.chat-status', { hasText: /发送失败/ }).count() === 0,
      'direct chat failure from first friend should not be shown in second friend thread',
    );
    await chatFriendButton.click();
    await smallAndroidPage.locator('.chat-status', { hasText: /发送失败/ }).waitFor({ timeout: 15000 });
    assert(
      await smallAndroidPage.locator('.direct-input textarea').inputValue() === 'critical isolated direct failure',
      'direct chat failed draft should be restored only in the original friend thread',
    );
    await smallAndroidPage.unroute('**/api/friends/*/messages', directFailureRoute);
    await smallAndroidPage.locator('.direct-input .primary-action').click();
    await smallAndroidPage.locator('.direct-messages article', { hasText: 'critical isolated direct failure' })
      .locator('.message-reply-link', { hasText: 'Critical direct reply anchor 01' })
      .waitFor({ timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-direct-chat-failure-isolated-mobile.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await chatAltFriendButton.click();

    const chatPageCallerContext = await loggedContext(
      browser,
      chatFriend.token,
      { width: 390, height: 844 },
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    );
    const chatPageCaller = await chatPageCallerContext.newPage();
    await chatPageCaller.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await chatPageCaller.waitForSelector('.home-shell', { timeout: 15000 });
    await chatPageCaller.getByRole('button', { name: /聊天/ }).click();
    await chatPageCaller.waitForSelector('.direct-chat', { timeout: 15000 });
    await chatPageCaller.locator('.chat-tools button[title="语音通话"]').click();
    await smallAndroidPage.locator('.global-call-banner.chat-page-call-banner', { hasText: /请求语音通话/ }).waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.global-call-banner.chat-page-call-banner').getByRole('button', { name: /拒绝/ }).click();
    await smallAndroidPage.locator('.global-call-banner.chat-page-call-banner').waitFor({ state: 'hidden', timeout: 8000 });
    await chatPageCallerContext.close();
    await chatFriendButton.click();
    await smallAndroidPage.locator('.direct-messages article', { hasText: 'Critical direct latest incoming' }).waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.direct-messages').evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await smallAndroidPage.locator('.scroll-to-bottom.direct').waitFor({ state: 'visible', timeout: 15000 });
    await smallAndroidPage.getByRole('button', { name: 'emoji' }).click();
    await assertEmojiPopoverLayout(smallAndroidPage, 'Small Android');
    screenshots.push(`${screenshotPrefix}-android-small-direct-chat-emoji.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });

    await enterRoomFromLobby(smallAndroidPage, `Critical Flow ${suffix}`, 'keeper');
    await smallAndroidPage.locator('.room-close-button').waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.room-tabs').getByRole('button', { name: /聊天/ }).click();
    await smallAndroidPage.waitForSelector('html.force-mobile .room-tab-chat .messages', { timeout: 15000 });
    await smallAndroidPage.locator('.messages article', { hasText: 'Critical room reply to older anchor' }).waitFor({ timeout: 15000 });
    const smallRoomChatLayout = await smallAndroidPage.evaluate(() => {
      const input = document.querySelector('.chat-input')?.getBoundingClientRect();
      const tabs = document.querySelector('.room-tabs')?.getBoundingClientRect();
      const tabButtons = [...document.querySelectorAll('.room-tabs button')].map((button) => button.getBoundingClientRect());
      const tabRows = new Set(tabButtons.map((rect) => Math.round(rect.top)));
      const sendButton = document.querySelector('.chat-input button[type="submit"]')?.getBoundingClientRect();
      const centerElement = sendButton
        ? document.elementFromPoint(sendButton.left + sendButton.width / 2, sendButton.top + sendButton.height / 2)
        : null;
      return {
        input: input ? { bottom: input.bottom, left: input.left, right: input.right, top: input.top } : null,
        sendButtonVisible: Boolean(centerElement && (centerElement.closest?.('.chat-input button[type="submit"]') || centerElement.closest?.('.chat-input'))),
        tabs: tabs ? { height: tabs.height, top: tabs.top } : null,
        tabRows: tabRows.size,
        width: innerWidth,
      };
    });
    assert(smallRoomChatLayout.input && smallRoomChatLayout.tabs, `small room chat layout missing elements: ${JSON.stringify(smallRoomChatLayout)}`);
    assert(smallRoomChatLayout.tabRows === 1, `small room tabs should stay on one row: ${JSON.stringify(smallRoomChatLayout)}`);
    assert(smallRoomChatLayout.input.bottom <= smallRoomChatLayout.tabs.top + 1, `small room chat input overlaps tabs: ${JSON.stringify(smallRoomChatLayout)}`);
    assert(smallRoomChatLayout.input.left >= 0 && smallRoomChatLayout.input.right <= smallRoomChatLayout.width, `small room chat input overflows viewport: ${JSON.stringify(smallRoomChatLayout)}`);
    assert(smallRoomChatLayout.sendButtonVisible, `small room chat send button is covered: ${JSON.stringify(smallRoomChatLayout)}`);
    screenshots.push(`${screenshotPrefix}-android-small-room-chat-input.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await assertFocusedInputClearOfBottomChrome(smallAndroidPage, '.chat-input input', '.room-tabs', 'Small Android room chat');
    screenshots.push(`${screenshotPrefix}-android-small-room-chat-input-focused.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });

    await smallAndroidPage.locator('.room-header .icon-button').first().click();
    await smallAndroidPage.waitForSelector('html.force-mobile .home-shell .bottom-nav', { timeout: 15000 });
    await dragFloatingDockToBottomRight(smallAndroidPage, 'Small Android');
    screenshots.push(`${screenshotPrefix}-android-small-floating-dock-clamped.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await smallAndroidPage.getByRole('button', { name: /正式退出/ }).click();
    await smallAndroidPage.locator('.active-room-confirm', { hasText: /确认后会离开当前房间与语音/ }).waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.active-room-confirm', { hasText: /不能保证自助重新加入/ }).waitFor({ timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-small-formal-leave-confirm.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    let blockedLeaveOnce = true;
    const leaveFailureRoute = async (route) => {
      if (blockedLeaveOnce) {
        blockedLeaveOnce = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'simulated leave failure' }),
        });
        return;
      }
      await route.fallback();
    };
    await smallAndroidPage.route('**/api/rooms/*/leave', leaveFailureRoute);
    await smallAndroidPage.locator('.active-room-confirm').getByRole('button', { name: /确认退出名单/ }).click();
    await smallAndroidPage.getByText('正式退出失败，请检查网络后重试。').waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.active-room-lock').waitFor({ timeout: 15000 });
    screenshots.push(`${screenshotPrefix}-android-small-formal-leave-failure.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await smallAndroidPage.unroute('**/api/rooms/*/leave', leaveFailureRoute);
    await smallAndroidPage.locator('.active-room-confirm').getByRole('button', { name: /取消/ }).click();
    await smallAndroidPage.locator('.floating-room-dock').waitFor({ timeout: 15000 });

    const dockCallerContext = await loggedContext(
      browser,
      chatFriend.token,
      { width: 390, height: 844 },
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    );
    const dockCallerPage = await dockCallerContext.newPage();
    await dockCallerPage.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await dockCallerPage.waitForSelector('.home-shell', { timeout: 15000 });
    await dockCallerPage.getByRole('button', { name: /聊天/ }).click();
    await dockCallerPage.waitForSelector('.direct-chat', { timeout: 15000 });
    await dockCallerPage.locator('.chat-tools button[title="语音通话"]').click();
    await smallAndroidPage.locator('.global-call-banner', { hasText: /请求语音通话/ }).waitFor({ timeout: 15000 });
    const callBannerDockLayer = await smallAndroidPage.evaluate(() => {
      const banner = document.querySelector('.global-call-banner');
      const dock = document.querySelector('.floating-room-dock');
      const rejectButton = banner?.querySelector('button');
      const rejectRect = rejectButton?.getBoundingClientRect();
      const hit = rejectRect
        ? document.elementFromPoint(rejectRect.left + rejectRect.width / 2, rejectRect.top + rejectRect.height / 2)
        : null;
      return {
        bannerZ: banner ? Number(getComputedStyle(banner).zIndex || 0) : 0,
        dockZ: dock ? Number(getComputedStyle(dock).zIndex || 0) : 0,
        hasBanner: Boolean(banner),
        hasDock: Boolean(dock),
        rejectButtonVisible: Boolean(hit && hit.closest?.('.global-call-banner button')),
      };
    });
    assert(
      callBannerDockLayer.hasBanner && callBannerDockLayer.hasDock,
      `global call banner or floating dock missing: ${JSON.stringify(callBannerDockLayer)}`,
    );
    assert(
      callBannerDockLayer.bannerZ > callBannerDockLayer.dockZ,
      `global call banner must layer above floating dock: ${JSON.stringify(callBannerDockLayer)}`,
    );
    assert(
      callBannerDockLayer.rejectButtonVisible,
      `global call banner action is covered by floating dock: ${JSON.stringify(callBannerDockLayer)}`,
    );
    screenshots.push(`${screenshotPrefix}-android-small-floating-dock-call-banner.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await smallAndroidPage.locator('.global-call-banner').getByRole('button', { name: /拒绝/ }).click();
    await smallAndroidPage.locator('.global-call-banner').waitFor({ state: 'hidden', timeout: 8000 });
    await dockCallerContext.close();

    await smallAndroidPage.getByRole('button', { name: /剧本/ }).click();
    await smallAndroidPage.getByText(script.title).first().click();
    await smallAndroidPage.waitForSelector('html.force-mobile .script-editor', { timeout: 15000 });
    await smallAndroidPage.waitForFunction(() => {
      const editor = document.querySelector('.script-editor')?.getBoundingClientRect();
      return Boolean(editor && editor.top < innerHeight - 80 && editor.bottom > 80);
    }, null, { timeout: 15000 });
    await smallAndroidPage.locator('.editor-nav button').nth(1).click();
    await smallAndroidPage.locator('.script-map-preview .map-feature.door', { hasText: 'UI侧门' }).waitFor({ timeout: 15000 });
    await smallAndroidPage.locator('.script-map-preview .script-map-token.npc', { hasText: 'UI' }).waitFor({ timeout: 15000 });
    await assertNoHorizontalOverflow(smallAndroidPage, '.script-editor', 'Small Android script map editor');
    await smallAndroidPage.locator('.map-object-editor').scrollIntoViewIfNeeded();
    screenshots.push(`${screenshotPrefix}-android-small-script-editor-map-objects.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await smallAndroidPage.locator('.editor-nav button').nth(3).click();
    await smallAndroidPage.waitForSelector('html.force-mobile .dice-mini', { timeout: 15000 });
    await assertNoHorizontalOverflow(smallAndroidPage, '.script-editor', 'Small Android script editor');
    await assertSmallScriptEditorLayout(smallAndroidPage);
    screenshots.push(`${screenshotPrefix}-android-small-script-editor-dice.png`);
    await smallAndroidPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await smallAndroidContext.close();

    const smallFlowContext = await loggedContext(
      browser,
      smallPlayer.token,
      { width: 320, height: 568 },
      'Mozilla/5.0 (Linux; Android 13; Small Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    );
    const smallFlowPage = await smallFlowContext.newPage();
    await enterRoomFromLobby(smallFlowPage, `Critical Flow ${suffix}`, 'player');
    await assertSmallRoomFlowLayout(smallFlowPage);
    await smallFlowPage.locator('.room-content').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const saveSheetButton = smallFlowPage.getByRole('button', { name: /保存草稿/ }).first();
    const submitSheetButton = smallFlowPage.getByRole('button', { name: /提交KP审核/ }).first();
    await smallFlowPage.locator('.sheet-validation.warning', { hasText: '信用评级必须在 9-30 之间' }).waitFor({ timeout: 15000 });
    assert(await submitSheetButton.isDisabled(), 'small flow submit should stay disabled while local sheet validation fails');
    const creditRatingRow = smallFlowPage.locator('.skill-table div', { hasText: '信用评级' }).first();
    await creditRatingRow.locator('input').first().fill('9');
    await smallFlowPage.locator('.sheet-validation.ready', { hasText: '已满足提交条件' }).waitFor({ timeout: 15000 });
    await saveSheetButton.scrollIntoViewIfNeeded();
    await submitSheetButton.scrollIntoViewIfNeeded();
    await expectButtonVisibleAndClickable(smallFlowPage, saveSheetButton, 'small flow save sheet');
    await expectButtonVisibleAndClickable(smallFlowPage, submitSheetButton, 'small flow submit sheet');
    screenshots.push(`${screenshotPrefix}-android-small-room-flow-sheet.png`);
    await smallFlowPage.screenshot({ path: path.join(outputDir, screenshots.at(-1)), fullPage: false });
    await smallFlowContext.close();

    console.log(JSON.stringify({ apiBase, frontendUrl, screenshots, owner: owner.email, player: player.email }, null, 2));
  } catch (error) {
    testError = error;
  } finally {
    if (browser) {
      await browser.close().catch((error) => cleanupErrors.push(error));
    }
    for (const script of [...cleanupScripts].reverse()) {
      await deleteScript(script.token, script.scriptId).catch((error) => cleanupErrors.push(error));
    }
    for (const room of [...cleanupRooms].reverse()) {
      await deleteRoom(room.token, room.roomId).catch((error) => cleanupErrors.push(error));
    }
  }

  if (cleanupErrors.length > 0) {
    const message = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
    if (testError) {
      console.error(`critical UI cleanup failed after test error: ${message}`);
    } else {
      throw new Error(`critical UI cleanup failed: ${message}`);
    }
  }
  if (testError) {
    throw testError;
  }
}

await main();

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const frontendUrl = process.env.FLOW_FAILURE_FRONTEND_URL ?? 'http://localhost:5173';
const apiBase = process.env.FLOW_FAILURE_API_BASE ?? 'http://localhost:8787';
const outputDir = process.env.FLOW_FAILURE_OUTPUT_DIR ?? path.join(process.cwd(), 'output', 'playwright');
const emailDomain = process.env.FLOW_FAILURE_EMAIL_DOMAIN ?? 'example.com';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { response, json };
}

function auth(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function registerUser(prefix = 'flow-check') {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@${emailDomain}`;
  const password = `pass-${suffix}`;
  const verification = await requestJson(`${apiBase}/api/auth/verification-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert(verification.response.status === 202, `/api/auth/verification-code returned ${verification.response.status}`);
  const verificationCode = verification.json?.debugCode ?? '';
  assert(/^\d{6}$/.test(verificationCode), 'verification code missing from local test server');

  const registered = await requestJson(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Flow Failure Check',
      email,
      password,
      role: 'keeper',
      verificationCode,
    }),
  });
  assert(registered.response.status === 201, `/api/auth/register returned ${registered.response.status}`);
  assert(typeof registered.json?.token === 'string', 'register missing token');
  return { account: registered.json.account, email, token: registered.json.token };
}

async function createRoom(token, name) {
  const created = await requestJson(`${apiBase}/api/rooms`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name, system: 'COC 7th', visibility: 'public' }),
  });
  assert(created.response.status === 201, `/api/rooms returned ${created.response.status}`);
  return created.json;
}

async function deleteRoom(token, roomId) {
  const result = await requestJson(`${apiBase}/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  assert(result.response.status === 200 || result.response.status === 404, `/api/rooms/:id DELETE returned ${result.response.status}`);
}

async function deleteScript(token, scriptId) {
  const result = await requestJson(`${apiBase}/api/scripts/${scriptId}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  assert(result.response.status === 204 || result.response.status === 404, `/api/scripts/:id DELETE returned ${result.response.status}`);
}

async function updateScript(token, scriptId, patch) {
  const updated = await requestJson(`${apiBase}/api/scripts/${scriptId}`, {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(patch),
  });
  return updated;
}

async function loggedContext(browser, token) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addInitScript(
    ({ sessionToken, configuredApiBase }) => {
      if (configuredApiBase) {
        window.__PAOTUAN_API_BASE__ = configuredApiBase;
      }
      localStorage.setItem('paotuan.session', sessionToken);
    },
    { configuredApiBase: apiBase === frontendUrl ? '' : apiBase, sessionToken: token },
  );
  return context;
}

async function waitForExactStatus(page, text) {
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('.status-line')].some((element) => element.textContent?.trim() === expected),
    text,
    { timeout: 15000 },
  );
}

async function waitForStatusContaining(page, text) {
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('.status-line')].some((element) => element.textContent?.includes(expected)),
    text,
    { timeout: 15000 },
  );
}

async function isDisabled(locator) {
  return locator.evaluate((element) => Boolean(element.disabled));
}

function scriptTitleInput(page) {
  return page.locator('.script-editor .editor-page-grid label', { hasText: '标题' }).locator('input');
}

function scriptSummaryInput(page) {
  return page.locator('.script-editor .editor-page-grid label', { hasText: '简介' }).locator('textarea');
}

async function openScriptsPage(page) {
  await page.getByRole('button', { name: /^剧本$/ }).click();
  await page.waitForSelector('.script-layout', { timeout: 15000 });
}

async function createScriptInEditor(page, title, summary) {
  await openScriptsPage(page);
  await page.getByRole('button', { name: /新建/ }).click();
  await page.waitForSelector('.script-editor .editor-nav', { timeout: 15000 });
  await scriptTitleInput(page).fill(title);
  await scriptSummaryInput(page).fill(summary);
  await page.locator('.script-editor .panel-title').getByRole('button', { name: /保存/ }).click();
  await waitForExactStatus(page, '已保存');
  await page.locator('.script-editor .panel-title', { hasText: title }).waitFor({ timeout: 15000 });
}

async function findScriptByTitle(token, title) {
  const listed = await requestJson(`${apiBase}/api/scripts`, {
    headers: auth(token),
  });
  assert(listed.response.status === 200, `/api/scripts returned ${listed.response.status}`);
  const script = listed.json?.find?.((item) => item.title === title);
  assert(script?.id && typeof script.version === 'number', `script ${title} not found in API list`);
  return script;
}

async function checkScriptSaveRace(page, token, cleanupScripts) {
  await openScriptsPage(page);
  await page.getByRole('button', { name: /新建/ }).click();
  await page.waitForSelector('.script-editor .editor-nav', { timeout: 15000 });

  const initialTitle = `竞态旧标题 ${Date.now().toString(36)}`;
  const editedTitle = `竞态新标题 ${Date.now().toString(36)}`;
  const titleInput = scriptTitleInput(page);
  const summaryInput = scriptSummaryInput(page);
  await titleInput.fill(initialTitle);
  await summaryInput.fill('保存请求未返回时继续编辑，不能被旧响应覆盖。');

  const createGate = deferred();
  let createRequests = 0;
  let updateRequests = 0;
  await page.route('**/api/scripts', async (route) => {
    if (route.request().method() === 'POST') {
      createRequests += 1;
      await createGate.promise;
    }
    await route.continue();
  });
  await page.route('**/api/scripts/*', async (route) => {
    if (route.request().method() === 'PUT') {
      updateRequests += 1;
      const body = JSON.parse(route.request().postData() ?? '{}');
      assert(typeof body.version === 'number', 'script update request must include numeric version');
    }
    await route.continue();
  });

  await page.locator('.script-editor .panel-title').getByRole('button', { name: /保存/ }).click();
  await page.locator('.script-editor .panel-title').getByRole('button', { name: /保存中/ }).waitFor({ timeout: 15000 });
  await titleInput.fill(editedTitle);
  createGate.resolve();
  await waitForStatusContaining(page, '保存期间的新编辑已保留');
  assert((await titleInput.inputValue()) === editedTitle, 'script editor lost edits made while create request was pending');

  await page.locator('.script-editor .panel-title').getByRole('button', { name: /保存/ }).click();
  await waitForExactStatus(page, '已保存');
  await page.locator('.script-editor .panel-title', { hasText: editedTitle }).waitFor({ timeout: 15000 });
  assert((await titleInput.inputValue()) === editedTitle, 'script editor should still show the saved script after update');
  assert(createRequests === 1, `expected one create request, got ${createRequests}`);
  assert(updateRequests >= 1, 'second save should update the server script instead of creating another local script');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-shell', { timeout: 15000 });
  await page.getByRole('button', { name: /^剧本$/ }).click();
  await page.waitForSelector('.script-layout', { timeout: 15000 });
  const savedScriptItem = page.locator('.script-list-item', { hasText: editedTitle });
  await savedScriptItem.waitFor({ timeout: 15000 });
  await savedScriptItem.getByRole('button').first().click();
  await page.locator('.script-editor .panel-title', { hasText: editedTitle }).waitFor({ timeout: 15000 });
  const savedScript = await findScriptByTitle(token, editedTitle);
  cleanupScripts.push({ token, scriptId: savedScript.id });
  await page.locator('.script-editor .editor-page-grid label', { hasText: '简介' }).locator('textarea').waitFor({ timeout: 15000 });
  assert(
    (await page.locator('.script-editor .editor-page-grid label', { hasText: '简介' }).locator('textarea').inputValue()).includes('保存请求未返回时继续编辑'),
    'reloaded script editor did not preserve saved summary',
  );
  await page.screenshot({ path: path.join(outputDir, 'flow-failure-script-save-race.png'), fullPage: false });
  await page.unroute('**/api/scripts');
  await page.unroute('**/api/scripts/*');
}

async function createAndLoadConflictScript(page, token, label, cleanupScripts) {
  const baseTitle = `冲突剧本 ${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  await createScriptInEditor(page, baseTitle, '冲突测试初始版本');
  const script = await findScriptByTitle(token, baseTitle);
  cleanupScripts.push({ token, scriptId: script.id });
  return { baseTitle, script };
}

async function checkScriptConflictRecovery(page, token, cleanupScripts) {
  const reloadFixture = await createAndLoadConflictScript(page, token, 'reload', cleanupScripts);
  const localReloadTitle = `${reloadFixture.baseTitle} 本地草稿`;
  const localReloadSummary = '本地草稿不能被 409 响应覆盖';
  const serverReloadTitle = `${reloadFixture.baseTitle} 服务器版本`;
  const serverReloadSummary = '服务器已经保存到 v2';
  await scriptTitleInput(page).fill(localReloadTitle);
  await scriptSummaryInput(page).fill(localReloadSummary);
  assert((await scriptTitleInput(page).inputValue()) === localReloadTitle, 'local title draft was not visible before conflict save');
  assert(
    (await scriptSummaryInput(page).inputValue()) === localReloadSummary,
    'local summary draft was not visible before conflict save',
  );

  const serverUpdate = await updateScript(token, reloadFixture.script.id, {
    title: serverReloadTitle,
    summary: serverReloadSummary,
    version: reloadFixture.script.version,
  });
  assert(serverUpdate.response.status === 200, `server-side script update returned ${serverUpdate.response.status}`);
  assert(serverUpdate.json?.version === reloadFixture.script.version + 1, 'server-side update did not advance script version');

  await page.locator('.script-editor .panel-title').getByRole('button', { name: /保存/ }).click();
  await waitForStatusContaining(page, '保存冲突');
  await page.waitForSelector('.script-conflict-panel', { timeout: 15000 });
  const titleAfterConflict = await scriptTitleInput(page).inputValue();
  const summaryAfterConflict = await scriptSummaryInput(page).inputValue();
  assert(
    titleAfterConflict === localReloadTitle,
    `409 conflict overwrote local title draft: expected ${localReloadTitle}, got ${titleAfterConflict}`,
  );
  assert(
    summaryAfterConflict === localReloadSummary,
    `409 conflict overwrote local summary draft: expected ${localReloadSummary}, got ${summaryAfterConflict}`,
  );
  assert(
    await isDisabled(page.locator('.script-editor .panel-title').getByRole('button', { name: /^保存$/ })),
    'plain save button should be disabled while a script conflict is unresolved',
  );
  await page.screenshot({ path: path.join(outputDir, 'flow-failure-script-conflict-pending.png'), fullPage: false });

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /重新加载服务器版本/ }).click();
  await waitForStatusContaining(page, '已加载服务器版本');
  await page.locator('.script-conflict-panel').waitFor({ state: 'detached', timeout: 15000 });
  assert((await scriptTitleInput(page).inputValue()) === serverReloadTitle, 'reload action did not load server title');
  assert((await scriptSummaryInput(page).inputValue()) === serverReloadSummary, 'reload action did not load server summary');

  const copyFixture = await createAndLoadConflictScript(page, token, 'copy', cleanupScripts);
  const localCopyTitle = `${copyFixture.baseTitle} 本地保留`;
  const localCopySummary = '这段草稿应该进入副本';
  const serverCopyTitle = `${copyFixture.baseTitle} 服务器已改`;
  await scriptTitleInput(page).fill(localCopyTitle);
  await scriptSummaryInput(page).fill(localCopySummary);

  const serverCopyUpdate = await updateScript(token, copyFixture.script.id, {
    title: serverCopyTitle,
    summary: '原剧本保持服务器版本',
    version: copyFixture.script.version,
  });
  assert(serverCopyUpdate.response.status === 200, `server copy fixture update returned ${serverCopyUpdate.response.status}`);

  await page.locator('.script-editor .panel-title').getByRole('button', { name: /保存/ }).click();
  await waitForStatusContaining(page, '保存冲突');
  await page.getByRole('button', { name: /另存为副本/ }).click();
  await waitForExactStatus(page, '已另存为副本');
  await page.locator('.script-conflict-panel').waitFor({ state: 'detached', timeout: 15000 });
  assert((await scriptTitleInput(page).inputValue()) === `${localCopyTitle} 副本`, 'copy action did not preserve local title');
  assert((await scriptSummaryInput(page).inputValue()) === localCopySummary, 'copy action did not preserve local summary');
  const original = await requestJson(`${apiBase}/api/scripts/${copyFixture.script.id}`, {
    headers: auth(token),
  });
  assert(original.response.status === 200, `original script reload returned ${original.response.status}`);
  assert(original.json?.title === serverCopyTitle, 'copy action overwrote the original server script');
  const copiedScript = await findScriptByTitle(token, `${localCopyTitle} 副本`);
  cleanupScripts.push({ token, scriptId: copiedScript.id });
  await page.screenshot({ path: path.join(outputDir, 'flow-failure-script-conflict.png'), fullPage: false });
}

async function checkClosedActiveRoomRestore(browser, user) {
  const context = await loggedContext(browser, user.token);
  await context.addInitScript(
    ({ accountId }) => {
      localStorage.setItem(
        'paotuan.activeRoom',
        JSON.stringify({
          accountId,
          minimized: false,
          role: 'player',
          roomId: 'closed-active-room',
        }),
      );
    },
    { accountId: user.account.id },
  );
  const page = await context.newPage();
  let joinAttempts = 0;
  await page.route('**/api/rooms/closed-active-room', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        id: 'closed-active-room',
        name: 'Closed Active Room',
        online: false,
        phase: 'closed',
        members: [],
        participants: [{ accountId: user.account.id, displayName: user.account.displayName, role: 'player' }],
        scene: { name: '空白地图', width: 12, height: 8, features: [], tokens: [] },
        messages: [],
        characters: [],
        characterSheets: [],
        scriptCharacters: [],
        voice: { livekitConfigured: false, participants: [] },
      }),
    });
  });
  await page.route('**/api/rooms/closed-active-room/join', async (route) => {
    joinAttempts += 1;
    await route.fulfill({
      contentType: 'application/json',
      status: 500,
      body: JSON.stringify({ error: 'closed room should not be auto-joined' }),
    });
  });
  await page.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-shell', { timeout: 15000 });
  await page.waitForTimeout(700);
  assert(joinAttempts === 0, 'closed active room restore attempted to auto-join and reopen the room');
  const stored = await page.evaluate(() => localStorage.getItem('paotuan.activeRoom'));
  assert(stored === null, 'closed active room restore did not clear local active room storage');
  await page.screenshot({ path: path.join(outputDir, 'flow-failure-closed-active-restore.png'), fullPage: false });
  await context.close();
}

async function enterRoomAsKeeper(page, roomName) {
  await page.getByRole('button', { name: /^大厅$/ }).click();
  await page.waitForSelector('.room-card', { timeout: 15000 });
  const card = page.locator('.room-card', { hasText: roomName }).first();
  await card.waitFor({ timeout: 15000 });
  await card.getByRole('button', { name: /加入|重新加入/ }).click();
  if (await page.getByRole('button', { name: /守秘人/ }).count()) {
    await page.getByRole('button', { name: /守秘人/ }).click();
  }
  if (await page.getByRole('button', { name: /进入房间/ }).count()) {
    await page.getByRole('button', { name: /进入房间/ }).click();
  }
  await page.waitForSelector('.room-shell', { timeout: 15000 });
  await page.waitForSelector('.room-flow-panel', { timeout: 15000 });
}

async function checkFlowFailureRecovery(page, room) {
  const phaseFailureGate = deferred();
  let failedPhaseRequests = 0;
  await page.route(`**/api/rooms/${room.id}/phase`, async (route) => {
    if (route.request().method() === 'PATCH' && failedPhaseRequests === 0) {
      failedPhaseRequests += 1;
      await phaseFailureGate.promise;
      await route.fulfill({
        contentType: 'application/json',
        status: 500,
        body: JSON.stringify({ error: 'forced phase failure' }),
      });
      return;
    }
    await route.continue();
  });

  const editButton = page.getByRole('button', { name: /修改人设剧情/ });
  await editButton.click();
  await page.getByRole('button', { name: /确认模组并招募/ }).waitFor({ state: 'attached', timeout: 15000 });
  assert(await isDisabled(editButton), 'phase button should be disabled while phase request is pending');
  phaseFailureGate.resolve();
  await waitForStatusContaining(page, '进入「模组编辑」失败');
  assert(!(await isDisabled(editButton)), 'phase button should be re-enabled after failure');

  await editButton.click();
  await page.waitForSelector('.module-prep-editor', { timeout: 15000 });

  const prepFailureGate = deferred();
  let prepRequests = 0;
  await page.route(`**/api/rooms/${room.id}/preparation`, async (route) => {
    if (route.request().method() === 'PATCH') {
      prepRequests += 1;
      await prepFailureGate.promise;
      await route.fulfill({
        contentType: 'application/json',
        status: 500,
        body: JSON.stringify({ error: 'forced preparation failure' }),
      });
      return;
    }
    await route.continue();
  });

  const summary = page.locator('.module-prep-editor label', { hasText: '公开剧情' }).locator('textarea');
  const draftText = '失败态保留这段公开剧情草稿';
  await summary.fill(draftText);
  const saveButton = page.getByRole('button', { name: /保存设定/ }).first();
  await saveButton.click();
  await page.waitForFunction(() => {
    const textarea = document.querySelector('.module-prep-editor textarea');
    return textarea instanceof HTMLTextAreaElement && textarea.disabled;
  });
  assert(await isDisabled(saveButton), 'preparation save button should be disabled while request is pending');
  prepFailureGate.resolve();
  await waitForStatusContaining(page, '保存模组设定失败');
  assert((await summary.inputValue()) === draftText, 'preparation draft should survive failed save');
  assert(!(await isDisabled(saveButton)), 'preparation save button should be re-enabled after failure');
  assert(prepRequests === 1, `expected one preparation request, got ${prepRequests}`);

  await page.screenshot({ path: path.join(outputDir, 'flow-failure-room-recovery.png'), fullPage: false });
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const cleanupRooms = [];
  const cleanupScripts = [];
  const cleanupErrors = [];
  let browser;
  let testError;
  const user = await registerUser();
  const room = await createRoom(user.token, `Flow Failure Room ${Date.now().toString(36)}`);
  cleanupRooms.push({ token: user.token, roomId: room.id });
  try {
    browser = await chromium.launch({ headless: true });
    const context = await loggedContext(browser, user.token);
    const page = await context.newPage();
    await page.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-shell', { timeout: 15000 });

    await checkClosedActiveRoomRestore(browser, user);
    await checkScriptSaveRace(page, user.token, cleanupScripts);
    await checkScriptConflictRecovery(page, user.token, cleanupScripts);
    await enterRoomAsKeeper(page, room.name);
    await checkFlowFailureRecovery(page, room);
    await context.close();
  } catch (error) {
    testError = error;
  } finally {
    if (browser) {
      await browser.close().catch((error) => cleanupErrors.push(error));
    }
    for (const script of [...cleanupScripts].reverse()) {
      await deleteScript(script.token, script.scriptId).catch((error) => cleanupErrors.push(error));
    }
    for (const cleanupRoom of [...cleanupRooms].reverse()) {
      await deleteRoom(cleanupRoom.token, cleanupRoom.roomId).catch((error) => cleanupErrors.push(error));
    }
  }

  if (cleanupErrors.length > 0) {
    const message = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
    if (testError) {
      console.error(`flow failure cleanup failed after test error: ${message}`);
    } else {
      throw new Error(`flow failure cleanup failed: ${message}`);
    }
  }
  if (testError) {
    throw testError;
  }

  console.log(
    JSON.stringify(
      {
        apiBase,
        frontendUrl,
        screenshots: [
          'flow-failure-script-save-race.png',
          'flow-failure-script-conflict-pending.png',
          'flow-failure-script-conflict.png',
          'flow-failure-closed-active-restore.png',
          'flow-failure-room-recovery.png',
        ],
        user: user.email,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

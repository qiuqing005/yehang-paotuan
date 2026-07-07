import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { Account, ChatMessage, DirectCallEvent, DirectMessage, FriendSummary, RoomState, VoiceTokenResponse } from './types.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-'));
process.env.DATA_DIR = dataDir;

const { store } = await import('./store.js');
const livekit = await import('./livekit.js');
const { server } = await import('./index.js');

const fetchBlockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045,
  4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

async function withServer<T>(run: (baseUrl: string) => Promise<T>) {
  let address: AddressInfo;
  do {
    await new Promise<void>((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        resolve();
      });
    });
    address = server.address() as AddressInfo;
    if (fetchBlockedPorts.has(address.port)) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } while (fetchBlockedPorts.has(address.port));

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function api(
  baseUrl: string,
  pathName: string,
  init: RequestInit & { token?: string } = {},
) {
  const { token, ...requestInit } = init;
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...requestInit,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...requestInit.headers,
    },
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  return { status: response.status, body };
}

function emitAck<T>(socket: ClientSocket, event: string, payload: unknown) {
  return new Promise<T>((resolve) => {
    socket.emit(event, payload, (response: T) => resolve(response));
  });
}

function waitForSocketEvent<T>(socket: ClientSocket, event: string) {
  return new Promise<T>((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });
}

function closeSocket(socket: ClientSocket | null | undefined) {
  return new Promise<void>((resolve) => {
    if (!socket || socket.disconnected) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 500);
    socket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.disconnect();
    socket.io.engine.close();
  });
}

function waitForNoSocketEvent<T>(socket: ClientSocket, event: string, windowMs = 150) {
  return new Promise<T | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const handler = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, windowMs);
    socket.once(event, handler);
  });
}

function decodeJwtPayload(token: string) {
  const [, payload] = token.split('.');
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as Record<string, unknown>;
}

const liveKitEnvKeys = ['LIVEKIT_URL', 'LIVEKIT_API_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;

function saveLiveKitEnv() {
  return Object.fromEntries(liveKitEnvKeys.map((key) => [key, process.env[key]])) as Record<
    (typeof liveKitEnvKeys)[number],
    string | undefined
  >;
}

function restoreLiveKitEnv(saved: ReturnType<typeof saveLiveKitEnv>) {
  liveKitEnvKeys.forEach((key) => {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
}

function configureLiveKitForTests() {
  process.env.LIVEKIT_URL = 'wss://livekit.example.test';
  process.env.LIVEKIT_API_URL = 'http://127.0.0.1:1';
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'devsecret';
}

function clearLiveKitEnv() {
  liveKitEnvKeys.forEach((key) => {
    delete process.env[key];
  });
}

function persistedDirectCall(callId: string) {
  store.flushPersistState();
  const state = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as {
    directCallSessions?: Array<Record<string, unknown>>;
  };
  return state.directCallSessions?.find((session) => session.callId === callId) ?? null;
}

function validSheetInput(name: string, options: { scriptCharacterId?: string; background?: string } = {}) {
  return {
    scriptCharacterId: options.scriptCharacterId,
    name,
    occupation: '记者',
    age: 32,
    sex: 'M',
    residence: 'Shanghai',
    birthplace: 'Ningbo',
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
      description: options.background ?? 'A reporter with a clear investigation hook.',
      ideology: '',
      significantPeople: '',
      locations: '',
      possessions: '',
      traits: '',
    },
  };
}

function enterRecruiting(roomId: string, owner: Account) {
  const current = store.getRoom(roomId, owner);
  const alreadyReady = Boolean(
    current?.summary.trim() &&
    current.scriptCharacters.some(
      (character) => character.name.trim() && (character.publicSummary ?? '').trim(),
    ),
  );
  if (!alreadyReady) {
    const prepared = store.updateRoomPreparation(roomId, owner, {
      summary: '公开招募剧情：调查员将围绕一桩异常事件展开调查。',
      scriptCharacters: [
        {
          name: '调查员人设',
          count: 6,
          publicSummary: '适合加入本模组的调查员，需要有明确调查动机。',
          story: '与事件发生地或委托人存在公开关系。',
          occupation: '记者',
          parameters: '',
          privateBrief: '',
          recommendedSkills: [],
        },
      ],
    });
    expect(prepared.ok).toBe(true);
  }
  return store.updateRoomPhase(roomId, owner, 'recruiting');
}

async function connectSocket(baseUrl: string, token?: string) {
  const socket = ioClient(baseUrl, { auth: token ? { token } : undefined, transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

function createImportedCoc7Room(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerSession = store.registerAccount({
    email: `${prefix}-owner-${suffix}@example.com`,
    displayName: `${prefix} KP`,
    password: '123456',
    role: 'keeper',
  })!;
  const playerSession = store.registerAccount({
    email: `${prefix}-player-${suffix}@example.com`,
    displayName: `${prefix} Player`,
    password: '123456',
    role: 'player',
  })!;
  const otherSession = store.registerAccount({
    email: `${prefix}-other-${suffix}@example.com`,
    displayName: `${prefix} Other`,
    password: '123456',
    role: 'player',
  })!;
  const room = store.createRoom({
    owner: ownerSession.account,
    name: `${prefix} room`,
    system: 'COC 7th',
  });

  expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
  expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);
  expect(store.updateRoomPhase(room.id, ownerSession.account, 'chargen').ok).toBe(true);

  const draft = store.upsertCharacterSheet(room.id, playerSession.account, validSheetInput(`${prefix} Investigator`));
  expect(draft.ok).toBe(true);
  expect(draft.validation.ok).toBe(true);

  const submitted = store.submitCharacterSheet(room.id, playerSession.account, draft.sheet);
  expect(submitted.ok).toBe(true);
  expect(store.updateRoomPhase(room.id, ownerSession.account, 'review').ok).toBe(true);
  const reviewed = store.reviewCharacterSheet(room.id, ownerSession.account, submitted.sheet.id, { status: 'approved' });
  expect(reviewed.ok).toBe(true);
  expect(store.confirmCharacterSheet(room.id, playerSession.account).ok).toBe(true);
  expect(store.updateRoomPhase(room.id, ownerSession.account, 'casting').ok).toBe(true);
  const imported = store.importApprovedSheets(room.id, ownerSession.account);
  expect(imported.ok).toBe(true);
  const importedCharacter = imported.room.characters.find((character) => character.accountId === playerSession.account.id);
  expect(importedCharacter).toBeDefined();

  return {
    ownerSession,
    playerSession,
    otherSession,
    room: imported.room,
    character: importedCharacter!,
  };
}

function createRuntimeScriptRoom(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerSession = store.registerAccount({
    email: `${prefix}-runtime-owner-${suffix}@example.com`,
    displayName: `${prefix} Runtime KP`,
    password: '123456',
    role: 'keeper',
  })!;
  const playerSession = store.registerAccount({
    email: `${prefix}-runtime-player-${suffix}@example.com`,
    displayName: `${prefix} Runtime Player`,
    password: '123456',
    role: 'player',
  })!;
  const otherSession = store.registerAccount({
    email: `${prefix}-runtime-other-${suffix}@example.com`,
    displayName: `${prefix} Runtime Other`,
    password: '123456',
    role: 'player',
  })!;
  const script = store.createScript(ownerSession.account, {
    title: `${prefix} Runtime Script`,
    visibility: 'private',
    summary: '公开招募剧情：调查员来到一座关闭的旧车站。',
    maps: [
      {
        id: 'runtime-map-lobby',
        name: '旧车站大厅',
        width: 10,
        height: 8,
        notes: '大厅中央有售票窗口。',
        tokens: [
          { id: 'runtime-token-hero', characterId: 'runtime-sc-investigator', label: '调', color: '#187a6d', x: 3, y: 4, status: 'ready' },
        ],
      },
      {
        id: 'runtime-map-basement',
        name: '地下候车室',
        width: 8,
        height: 6,
        notes: '地下室潮湿且有回声。',
        features: [{ id: 'runtime-door', type: 'door', label: '铁门', x: 2, y: 2, w: 1, h: 1 }],
        tokens: [
          { id: 'runtime-token-hero-2', characterId: 'runtime-sc-investigator', label: '调', color: '#187a6d', x: 2, y: 3, status: 'ready' },
          { id: 'runtime-token-visible-npc', characterId: 'runtime-sc-shadow', label: '影', color: '#4f5d9f', x: 6, y: 4, status: 'npc' },
          { id: 'runtime-token-hidden', characterId: 'runtime-sc-shadow', label: '?', color: '#4f5565', x: 7, y: 5, status: 'hidden' },
        ],
      },
    ],
    characters: [
      {
        id: 'runtime-sc-investigator',
        name: '调查员人设',
        count: 1,
        occupation: '记者',
        parameters: 'HP 11 / SAN 50',
        publicSummary: '受雇调查旧车站失踪案。',
        story: '公开背景：与委托人有联系。',
        privateBrief: '真正委托人是邪教成员。',
      },
      {
        id: 'runtime-sc-shadow',
        name: '地下影子',
        count: 1,
        parameters: '',
        publicSummary: '传闻中的影子。',
        story: '',
        privateBrief: '只在地下候车室出现。',
      },
    ],
    diceProfiles: [{ id: 'runtime-dice-spot', label: '侦查', formula: '1d100<=55', probability: 0.55 }],
    chapters: [
      {
        id: 'runtime-chapter-1',
        title: '第一幕',
        blocks: [
          {
            id: 'runtime-block-opening',
            type: 'narrative',
            title: '抵达车站',
            markdown: '你们抵达车站时，站内广播仍在播放一段重复的录音。',
          },
          {
            id: 'runtime-block-map',
            type: 'map',
            title: '进入地下候车室',
            mapId: 'runtime-map-basement',
            notes: '潮湿空气里有铁锈味。',
          },
          {
            id: 'runtime-block-character',
            type: 'character',
            title: '公开调查员关系',
            characterId: 'runtime-sc-investigator',
            notes: '委托人要求你们不要报警。',
          },
          {
            id: 'runtime-block-check',
            type: 'check',
            title: '寻找广播源',
            diceId: 'runtime-dice-spot',
            difficulty: 55,
            onPass: '发现扩音器背后的符号。',
            onFail: '只听见噪音。',
          },
        ],
      },
    ],
  });
  const room = store.createRoom({
    owner: ownerSession.account,
    name: `${prefix} Runtime Room`,
    system: 'COC 7th',
    visibility: 'public',
    scriptId: script.id,
  });
  expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
  expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);
  expect(store.updateRoomPhase(room.id, ownerSession.account, 'chargen').ok).toBe(true);
  const draft = store.upsertCharacterSheet(room.id, playerSession.account, validSheetInput(`${prefix} Investigator`, {
    scriptCharacterId: 'runtime-sc-investigator',
  }));
  expect(draft.ok).toBe(true);
  expect(draft.validation.ok).toBe(true);
  const submitted = store.submitCharacterSheet(room.id, playerSession.account, draft.sheet);
  expect(submitted.ok).toBe(true);
  expect(store.updateRoomPhase(room.id, ownerSession.account, 'review').ok).toBe(true);
  const reviewed = store.reviewCharacterSheet(room.id, ownerSession.account, submitted.sheet.id, { status: 'approved' });
  expect(reviewed.ok).toBe(true);
  expect(store.confirmCharacterSheet(room.id, playerSession.account).ok).toBe(true);
  expect(store.updateRoomPhase(room.id, ownerSession.account, 'casting').ok).toBe(true);
  const imported = store.importApprovedSheets(room.id, ownerSession.account);
  expect(imported.ok).toBe(true);

  return {
    ownerSession,
    playerSession,
    otherSession,
    script,
    room: imported.room,
  };
}

describe('server store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers, logs in, and persists email accounts', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `tester-${suffix}@example.com`;

    const session = store.registerAccount({
      email,
      displayName: '测试玩家',
      password: '123456',
    });

    expect(session?.account).toMatchObject({
      email,
      displayName: '测试玩家',
      role: 'player',
    });
    expect(session?.token).toHaveLength(64);
    expect(store.loginAccount({ email, password: '123456' })?.account.email).toBe(email);
    expect(existsSync(path.join(dataDir, 'state.json'))).toBe(true);

    const state = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as {
      accounts: Array<{ email: string; passwordHash: string }>;
      sessions: Array<[string, { accountId: string; expiresAt: string }]>;
    };
    expect(state.accounts.find((account) => account.email === email)?.passwordHash).toMatch(/^scrypt:/);
    expect(state.sessions.some(([tokenKey]) => tokenKey === session?.token)).toBe(false);
    expect(state.sessions.every(([tokenKey]) => tokenKey.startsWith('sha256:'))).toBe(true);
    expect(state.sessions.every(([, stored]) => typeof stored.expiresAt === 'string')).toBe(true);
    expect(store.getAccountByToken(session?.token)?.email).toBe(email);

    const secondEmail = `tester-second-${suffix}@example.com`;
    const secondSession = store.registerAccount({
      email: secondEmail,
      displayName: '第二位测试玩家',
      password: '123456',
    });
    expect(secondSession?.account.email).toBe(secondEmail);

    const nextState = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as {
      accounts: Array<{ email: string; passwordHash: string }>;
    };
    const backupState = JSON.parse(readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8')) as {
      accounts: Array<{ email: string }>;
    };
    expect(nextState.accounts.some((account) => account.email === secondEmail)).toBe(true);
    expect(backupState.accounts.some((account) => account.email === email)).toBe(true);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('issues and consumes registration email verification codes', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `verify-${suffix}@example.com`;

    const issued = store.issueRegistrationCode(email, '123456');
    expect(issued.ok).toBe(true);
    expect(issued.ok ? issued.email : '').toBe(email);
    expect(store.canRequestRegistrationCode(email).ok).toBe(false);
    expect(store.verifyRegistrationCode(email, '000000').ok).toBe(false);
    expect(store.verifyRegistrationCode(email, '123456').ok).toBe(true);
    expect(store.verifyRegistrationCode(email, '123456').ok).toBe(false);
  });

  it('does not replace an active registration code during cooldown', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `cooldown-${suffix}@example.com`;

    expect(store.issueRegistrationCode(email, '123456').ok).toBe(true);
    const blocked = store.issueRegistrationCode(email, '654321');

    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? null : blocked.error).toBe('Verification code requested too frequently');
    expect(store.verifyRegistrationCode(email, '654321').ok).toBe(false);
    expect(store.verifyRegistrationCode(email, '123456').ok).toBe(true);
  });

  it('resets passwords with an email verification code', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `reset-${suffix}@example.com`;

    expect(store.registerAccount({
      email,
      displayName: 'Reset User',
      password: 'old-pass',
    })).not.toBeNull();
    expect(store.issuePasswordResetCode(email, '654321').ok).toBe(true);
    expect(store.resetPassword({ email, password: 'new-pass', verificationCode: '000000' }).ok).toBe(false);
    expect(store.resetPassword({ email, password: 'new-pass', verificationCode: '654321' }).ok).toBe(true);
    expect(store.loginAccount({ email, password: 'old-pass' })).toBeNull();
    expect(store.loginAccount({ email, password: 'new-pass' })?.account.email).toBe(email);
  });

  it('keeps public health minimal and protects detailed diagnostics', async () => {
    await withServer(async (baseUrl) => {
      const health = await api(baseUrl, '/health');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ ok: true, service: 'paotuan-server' });
      expect(health.body).not.toHaveProperty('emailDelivery');

      const blockedDetails = await api(baseUrl, '/api/health/details');
      expect(blockedDetails.status).toBe(401);

      const session = store.registerAccount({
        email: `health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        displayName: 'Health User',
        password: '123456',
      })!;
      const details = await api(baseUrl, '/api/health/details', { token: session.token });
      expect(details.status).toBe(200);
      expect(details.body).toMatchObject({
        ok: true,
        service: 'paotuan-server',
        emailDeliveryEnabled: expect.any(Boolean),
        livekitEnabled: expect.any(Boolean),
        livekit: {
          enabled: expect.any(Boolean),
          adminConfigured: expect.any(Boolean),
          clientUrlConfigured: expect.any(Boolean),
          cleanup: {
            attemptedCount: expect.any(Number),
            failedCount: expect.any(Number),
            notFoundCount: expect.any(Number),
            pendingCount: expect.any(Number),
            skippedCount: expect.any(Number),
            successCount: expect.any(Number),
          },
        },
      });
      if (details.body.livekit.cleanup.lastFailure) {
        expect(details.body.livekit.cleanup.lastFailure).not.toHaveProperty('roomName');
        expect(details.body.livekit.cleanup.lastFailure).not.toHaveProperty('accountId');
      }
    });
  }, 15_000);

  it('rate limits repeated login failures', async () => {
    await withServer(async (baseUrl) => {
      const email = `limited-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

      for (let index = 0; index < 10; index += 1) {
        const response = await api(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password: 'wrong-password' }),
        });
        expect(response.status).toBe(401);
      }

      const blocked = await api(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'wrong-password' }),
      });
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ error: 'Too many login attempts' });
    });
  }, 15_000);

  it('does not count successful logins against the failure limit', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const email = `login-ok-${suffix}@example.com`;
      store.registerAccount({
        email,
        displayName: 'Login OK',
        password: 'correct-password',
      });

      for (let index = 0; index < 12; index += 1) {
        const response = await api(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password: 'correct-password' }),
        });
        expect(response.status).toBe(200);
      }
    });
  });

  it('requires the current password before changing password and revokes old sessions', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const email = `password-${suffix}@example.com`;
      const initial = store.registerAccount({
        email,
        displayName: 'Password User',
        password: 'old-pass',
      })!;
      const secondSession = store.loginAccount({ email, password: 'old-pass' })!;

      const missingCurrentPassword = await api(baseUrl, '/api/profile', {
        method: 'PATCH',
        token: initial.token,
        body: JSON.stringify({ password: 'new-pass' }),
      });
      expect(missingCurrentPassword.status).toBe(400);

      const wrongCurrentPassword = await api(baseUrl, '/api/profile', {
        method: 'PATCH',
        token: initial.token,
        body: JSON.stringify({ password: 'new-pass', currentPassword: 'bad-pass' }),
      });
      expect(wrongCurrentPassword.status).toBe(403);

      const changed = await api(baseUrl, '/api/profile', {
        method: 'PATCH',
        token: initial.token,
        body: JSON.stringify({ password: 'new-pass', currentPassword: 'old-pass' }),
      });
      expect(changed.status).toBe(200);

      expect((await api(baseUrl, '/api/auth/session', { token: initial.token })).status).toBe(200);
      expect((await api(baseUrl, '/api/auth/session', { token: secondSession.token })).status).toBe(401);
      expect(store.loginAccount({ email, password: 'old-pass' })).toBeNull();
      expect(store.loginAccount({ email, password: 'new-pass' })?.account.email).toBe(email);
    });
  });

  it('logs out by revoking the current session token', async () => {
    await withServer(async (baseUrl) => {
      const session = store.registerAccount({
        email: `logout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        displayName: 'Logout User',
        password: '123456',
      })!;

      const logout = await api(baseUrl, '/api/auth/logout', {
        method: 'POST',
        token: session.token,
      });
      expect(logout.status).toBe(204);
      expect((await api(baseUrl, '/api/auth/session', { token: session.token })).status).toBe(401);
    });
  });

  it('supports friends and private room access', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `owner-${suffix}@example.com`,
      displayName: '房主',
      password: '123456',
      role: 'keeper',
    })!.account;
    const friend = store.registerAccount({
      email: `friend-${suffix}@example.com`,
      displayName: '好友',
      password: '123456',
      role: 'player',
    })!.account;
    const outsider = store.registerAccount({
      email: `outsider-${suffix}@example.com`,
      displayName: '路人',
      password: '123456',
      role: 'player',
    })!.account;

    const request = store.requestFriend(friend.id, owner.email);
    expect(request?.direction).toBe('outgoing');
    expect(store.acceptFriend(owner.id, friend.id)?.status).toBe('accepted');

    const room = store.createRoom({
      owner,
      name: '私密团',
      system: 'COC 7th',
      visibility: 'private',
    });

    expect(store.joinRoom(room.id, friend, 'player')).toMatchObject({
      ok: false,
      error: 'Room is not recruiting new players',
    });
    expect(store.listRooms(friend).find((item) => item.id === room.id)).toMatchObject({
      canJoin: false,
      visibility: 'private',
    });
    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    const joined = store.joinRoom(room.id, friend, 'player');
    expect(joined.ok).toBe(true);
    expect(joined.ok ? joined.room.voice.participants : []).toEqual([]);
    const voiceJoined = store.joinVoice(room.id, friend, { muted: false });
    expect(voiceJoined.ok ? voiceJoined.room.voice.participants.map((participant) => participant.id) : []).toEqual([friend.id]);
    expect(store.getRoomVoiceLiveKitTargetsForAccount(friend.id)).toEqual([
      { roomId: room.id, roomName: store.getRoomLiveKitVoiceRoomName(room.id) },
    ]);
    const friendVoiceRoomName = store.getRoomLiveKitVoiceRoomName(room.id);
    expect(store.leaveVoice(room.id, friend.id)).toMatchObject({
      ok: true,
      liveKitRoomName: friendVoiceRoomName,
    });
    expect(store.getRoomVoiceLiveKitTargetsForAccount(friend.id)).toEqual([]);
    expect(store.joinRoom(room.id, outsider).ok).toBe(false);
    expect(store.listRooms(outsider).some((item) => item.id === room.id)).toBe(false);
    expect(store.listRooms(friend).find((item) => item.id === room.id)).toMatchObject({
      canJoin: true,
      visibility: 'private',
    });

    const message = store.addDirectMessage(friend.id, owner.id, '今晚开团吗？');
    expect(message?.text).toBe('今晚开团吗？');
    expect(store.listDirectMessages(owner.id, friend.id)?.map((item) => item.text)).toContain('今晚开团吗？');
    expect(store.listDirectMessages(owner.id, outsider.id)).toBeNull();

    expect(store.inviteRoomFriend(room.id, owner, friend.id).ok).toBe(true);
    expect(store.inviteRoomFriend(room.id, owner, outsider.id).ok).toBe(false);
  });

  it('rotates voice rooms when volatile room presence is recovered after restart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T05:00:00.000Z'));
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `voice-recover-${suffix}@example.com`,
      displayName: 'Voice Recover KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Voice recovery room',
      system: 'COC 7th',
    });
    const beforeVoiceRoomName = store.getVoiceRoomName(room.id, owner);
    expect(beforeVoiceRoomName).toMatch(`${room.id}:`);
    expect(store.joinVoice(room.id, owner, { muted: false }).ok).toBe(true);

    store.recoverVolatileRoomPresenceAfterRestart();
    expect(store.drainStartupLiveKitRoomCleanupRooms()).toEqual(expect.arrayContaining([beforeVoiceRoomName]));
    expect(store.drainStartupLiveKitRoomCleanupRooms()).toEqual([]);

    const recovered = store.getRoom(room.id, owner);
    expect(recovered?.members).toEqual([]);
    expect(recovered?.voice.participants).toEqual([]);
    expect(recovered?.voice.epoch).not.toBe(room.voice.epoch);
    expect(recovered?.closeAt).toBe('2026-05-19T05:05:00.000Z');

    const rejoined = store.joinRoom(room.id, owner, 'keeper');
    expect(rejoined.ok).toBe(true);
    const afterVoiceRoomName = store.getVoiceRoomName(room.id, owner);
    expect(afterVoiceRoomName).toMatch(`${room.id}:`);
    expect(afterVoiceRoomName).not.toBe(beforeVoiceRoomName);
  });

  it('queues persisted direct voice rooms for LiveKit cleanup after restart recovery', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const caller = store.registerAccount({
      email: `direct-cleanup-caller-${suffix}@example.com`,
      displayName: 'Direct Cleanup Caller',
      password: '123456',
    })!.account;
    const friend = store.registerAccount({
      email: `direct-cleanup-friend-${suffix}@example.com`,
      displayName: 'Direct Cleanup Friend',
      password: '123456',
    })!.account;
    expect(store.requestFriend(caller.id, friend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friend.id, caller.id)?.status).toBe('accepted');
    expect(store.createDirectCall(caller.id, friend.id, 'restart-direct-cleanup').ok).toBe(true);
    expect(store.acceptDirectCall(friend.id, caller.id, 'restart-direct-cleanup').ok).toBe(true);
    expect(store.markDirectCallVoiceTokenIssued(caller.id, friend.id, 'restart-direct-cleanup').ok).toBe(true);
    expect(store.markDirectCallVoiceReady(caller.id, friend.id, 'restart-direct-cleanup').ok).toBe(true);
    const staleDirectRoomName = store.getDirectCallLiveKitRoomName('restart-direct-cleanup');
    expect(staleDirectRoomName).toMatch(/^direct:[a-f0-9]{32}$/);

    store.recoverVolatileRoomPresenceAfterRestart();

    const recoveredDirectRoomName = store.getDirectCallLiveKitRoomName('restart-direct-cleanup');
    expect(recoveredDirectRoomName).toMatch(/^direct:[a-f0-9]{32}$/);
    expect(recoveredDirectRoomName).not.toBe(staleDirectRoomName);
    expect(store.markDirectCallVoiceReady(caller.id, friend.id, 'restart-direct-cleanup')).toMatchObject({
      ok: false,
      error: 'Join direct voice first',
    });
    expect(store.markDirectCallVoiceTokenIssued(caller.id, friend.id, 'restart-direct-cleanup').ok).toBe(true);
    expect(store.markDirectCallVoiceReady(caller.id, friend.id, 'restart-direct-cleanup').ok).toBe(true);
    const queuedLiveKitCleanups = store.drainStartupLiveKitRoomCleanupRooms();
    expect(queuedLiveKitCleanups).toContain(staleDirectRoomName);
    expect(queuedLiveKitCleanups).not.toContain(recoveredDirectRoomName);
    expect(store.drainStartupLiveKitRoomCleanupRooms()).toEqual([]);
  });

  it('keeps private room invitations controlled by the owner friendship policy', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `private-invite-owner-${suffix}@example.com`,
      displayName: 'Private Invite Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const member = store.registerAccount({
      email: `private-invite-member-${suffix}@example.com`,
      displayName: 'Private Invite Member',
      password: '123456',
    })!.account;
    const invitee = store.registerAccount({
      email: `private-invite-guest-${suffix}@example.com`,
      displayName: 'Private Invite Guest',
      password: '123456',
    })!.account;

    expect(store.requestFriend(member.id, owner.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(owner.id, member.id)?.status).toBe('accepted');
    expect(store.requestFriend(member.id, invitee.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(invitee.id, member.id)?.status).toBe('accepted');

    const privateRoom = store.createRoom({
      owner,
      name: 'Owner controlled private room',
      system: 'COC 7th',
      visibility: 'private',
    });
    expect(enterRecruiting(privateRoom.id, owner).ok).toBe(true);
    expect(store.joinRoom(privateRoom.id, member, 'player').ok).toBe(true);

    const memberInvite = store.inviteRoomFriend(privateRoom.id, member, invitee.id);
    expect(memberInvite).toMatchObject({
      ok: false,
      error: 'Only the room owner can invite friends to a private room',
    });
    expect(store.joinRoom(privateRoom.id, invitee, 'player')).toMatchObject({
      ok: false,
      error: 'Private room requires friendship with the owner',
    });
    expect(store.inviteRoomFriend(privateRoom.id, owner, invitee.id)).toMatchObject({
      ok: false,
      error: 'Invitee must be your friend',
    });
  });

  it('does not allow inviting new participants into closed history rooms', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T23:00:00.000Z'));
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `closed-invite-owner-${suffix}@example.com`,
      displayName: 'Closed Invite Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const invitee = store.registerAccount({
      email: `closed-invite-guest-${suffix}@example.com`,
      displayName: 'Closed Invite Guest',
      password: '123456',
    })!.account;
    expect(store.requestFriend(owner.id, invitee.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(invitee.id, owner.id)?.status).toBe('accepted');

    const room = store.createRoom({
      owner,
      name: 'Closed Invite History Room',
      system: 'COC 7th',
      visibility: 'private',
    });
    expect(store.leaveRoom(room.id, owner.id).ok).toBe(true);
    vi.advanceTimersByTime(300_001);
    store.sweepExpiredRooms();
    expect(store.getRoom(room.id, owner)?.online).toBe(false);

    expect(store.inviteRoomFriend(room.id, owner, invitee.id)).toMatchObject({
      ok: false,
      error: 'Room is closed',
    });
    expect(store.listRooms(invitee, { status: 'closed' }).some((item) => item.id === room.id)).toBe(false);
    expect(store.getRoom(room.id, invitee)).toBeNull();
  });

  it('still lets public room members invite their own friends', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `public-invite-owner-${suffix}@example.com`,
      displayName: 'Public Invite Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const member = store.registerAccount({
      email: `public-invite-member-${suffix}@example.com`,
      displayName: 'Public Invite Member',
      password: '123456',
    })!.account;
    const invitee = store.registerAccount({
      email: `public-invite-guest-${suffix}@example.com`,
      displayName: 'Public Invite Guest',
      password: '123456',
    })!.account;

    expect(store.requestFriend(member.id, invitee.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(invitee.id, member.id)?.status).toBe('accepted');
    const publicRoom = store.createRoom({
      owner,
      name: 'Member invitational public room',
      system: 'COC 7th',
      visibility: 'public',
    });
    expect(enterRecruiting(publicRoom.id, owner).ok).toBe(true);
    expect(store.joinRoom(publicRoom.id, member, 'player').ok).toBe(true);

    const invited = store.inviteRoomFriend(publicRoom.id, member, invitee.id);
    expect(invited.ok).toBe(true);
    expect(invited.ok ? invited.room.participantIds : []).toContain(invitee.id);
  });

  it('rejects outsider leave and voice leave attempts without exposing private room state', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `leave-owner-${suffix}@example.com`,
        displayName: 'Leave Owner',
        password: '123456',
        role: 'keeper',
      })!;
      const outsiderSession = store.registerAccount({
        email: `leave-outsider-${suffix}@example.com`,
        displayName: 'Leave Outsider',
        password: '123456',
        role: 'player',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Private Leave Room',
        system: 'COC 7th',
        visibility: 'private',
      });
      expect(store.addMessage(room.id, {
        author: 'Leave Owner',
        role: 'keeper',
        text: 'private clue',
      })).toBeTruthy();

      const directLeave = store.leaveRoom(room.id, outsiderSession.account.id);
      expect(directLeave).toMatchObject({ ok: false });
      expect(directLeave).not.toHaveProperty('room');

      const directVoiceLeave = store.leaveVoice(room.id, outsiderSession.account.id);
      expect(directVoiceLeave).toMatchObject({ ok: false });
      expect(directVoiceLeave).not.toHaveProperty('room');

      const restLeave = await api(baseUrl, `/api/rooms/${room.id}/leave`, {
        method: 'POST',
        token: outsiderSession.token,
      });
      expect(restLeave.status).toBe(403);
      expect(restLeave.body).not.toHaveProperty('room');
      expect(restLeave.body).not.toHaveProperty('messages');
      expect(restLeave.body).not.toHaveProperty('characterSheets');
      expect(restLeave.body).not.toHaveProperty('voice');
      expect(JSON.stringify(restLeave.body)).not.toContain('private clue');

      const socket = await connectSocket(baseUrl);
      try {
        const socketLeave = await emitAck<{ ok: false; error: string }>(socket, 'room:leave', {
          roomId: room.id,
          token: outsiderSession.token,
        });
        expect(socketLeave).toMatchObject({ ok: false });
        expect(socketLeave).not.toHaveProperty('room');
        expect(JSON.stringify(socketLeave)).not.toContain('private clue');

        const voiceLeave = await emitAck<{ ok: false; error: string }>(socket, 'voice:leave', {
          roomId: room.id,
          token: outsiderSession.token,
        });
        expect(voiceLeave).toMatchObject({ ok: false });
        expect(voiceLeave).not.toHaveProperty('room');
        expect(JSON.stringify(voiceLeave)).not.toContain('private clue');
      } finally {
        socket.close();
      }
    });
  });

  it('binds each socket connection to one account token', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionA = store.registerAccount({
        email: `socket-a-${suffix}@example.com`,
        displayName: 'Socket A',
        password: '123456',
        role: 'keeper',
      })!;
      const sessionB = store.registerAccount({
        email: `socket-b-${suffix}@example.com`,
        displayName: 'Socket B',
        password: '123456',
        role: 'keeper',
      })!;
      const roomA = store.createRoom({
        owner: sessionA.account,
        name: 'Socket A Room',
        system: 'COC 7th',
      });
      const roomB = store.createRoom({
        owner: sessionB.account,
        name: 'Socket B Room',
        system: 'COC 7th',
      });

      const socket = await connectSocket(baseUrl);
      try {
        const joinedA = await emitAck<{ ok: true; room: { id: string } }>(socket, 'room:join', {
          roomId: roomA.id,
          token: sessionA.token,
          role: 'keeper',
        });
        expect(joinedA).toMatchObject({ ok: true, room: { id: roomA.id } });

        const rejectedB = await emitAck<{ ok: false; error: string }>(socket, 'room:join', {
          roomId: roomB.id,
          token: sessionB.token,
          role: 'keeper',
        });
        expect(rejectedB).toMatchObject({ ok: false, error: 'Socket account mismatch' });
      } finally {
        socket.close();
      }
    });
  }, 15_000);

  it('paginates direct messages from newest to older batches', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `dm-owner-${suffix}@example.com`,
      displayName: 'Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const friend = store.registerAccount({
      email: `dm-friend-${suffix}@example.com`,
      displayName: 'Friend',
      password: '123456',
      role: 'player',
    })!.account;

    expect(store.requestFriend(owner.id, friend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friend.id, owner.id)?.status).toBe('accepted');
    for (let index = 1; index <= 25; index += 1) {
      expect(store.addDirectMessage(owner.id, friend.id, `message-${String(index).padStart(2, '0')}`)).toBeTruthy();
    }

    const latest = store.listDirectMessagePage(owner.id, friend.id, { limit: 20 });
    expect(latest?.messages).toHaveLength(20);
    expect(latest?.messages[0].text).toBe('message-06');
    expect(latest?.messages.at(-1)?.text).toBe('message-25');
    expect(latest?.hasMore).toBe(true);

    const older = store.listDirectMessagePage(owner.id, friend.id, {
      limit: 20,
      before: latest!.messages[0].id,
    });
    expect(older?.messages.map((message) => message.text)).toEqual([
      'message-01',
      'message-02',
      'message-03',
      'message-04',
      'message-05',
    ]);
    expect(older?.hasMore).toBe(false);
  });

  it('stores direct message reply references only inside the same friend conversation', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `dm-reply-owner-${suffix}@example.com`,
      displayName: 'Owner Reply',
      password: '123456',
    })!.account;
    const friend = store.registerAccount({
      email: `dm-reply-friend-${suffix}@example.com`,
      displayName: 'Friend Reply',
      password: '123456',
    })!.account;
    const otherFriend = store.registerAccount({
      email: `dm-reply-other-${suffix}@example.com`,
      displayName: 'Other Reply',
      password: '123456',
    })!.account;

    expect(store.requestFriend(owner.id, friend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friend.id, owner.id)?.status).toBe('accepted');
    expect(store.requestFriend(owner.id, otherFriend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(otherFriend.id, owner.id)?.status).toBe('accepted');

    const anchor = store.addDirectMessage(owner.id, friend.id, '这是一条需要回复的私聊消息');
    expect(anchor).toBeTruthy();
    const reference = store.getDirectMessageReference(friend.id, owner.id, anchor!.id);
    expect(reference).toMatchObject({
      ok: true,
      replyTo: {
        id: anchor!.id,
        author: 'Owner Reply',
        text: '这是一条需要回复的私聊消息',
      },
    });

    const reply = store.addDirectMessage(
      friend.id,
      owner.id,
      '收到，我回复这条。',
      'dm-reply-once',
      reference.ok ? reference.replyTo : undefined,
    );
    expect(reply).toMatchObject({
      clientMessageId: 'dm-reply-once',
      replyTo: {
        id: anchor!.id,
        author: 'Owner Reply',
        text: '这是一条需要回复的私聊消息',
      },
    });
    expect(store.listDirectMessagePage(owner.id, friend.id, { limit: 20 })?.messages.at(-1)).toMatchObject({
      text: '收到，我回复这条。',
      replyTo: expect.objectContaining({ id: anchor!.id }),
    });
    const forgedPreview = store.addDirectMessage(friend.id, owner.id, '伪造摘要会被纠正', undefined, {
      id: anchor!.id,
      author: '伪造作者',
      text: '伪造内容',
    });
    expect(forgedPreview).toMatchObject({
      text: '伪造摘要会被纠正',
      replyTo: {
        id: anchor!.id,
        author: 'Owner Reply',
        text: '这是一条需要回复的私聊消息',
      },
    });

    expect(store.getDirectMessageReference(owner.id, otherFriend.id, anchor!.id)).toMatchObject({
      ok: false,
      error: 'Reply target not found',
    });
    expect(
      store.addDirectMessage(owner.id, otherFriend.id, '跨会话引用不应该保存', undefined, {
        id: anchor!.id,
        author: 'Owner Reply',
        text: '这是一条需要回复的私聊消息',
      }),
    ).toBeNull();
  });

  it('tracks direct unread summaries and read cursors per friend', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `dm-unread-owner-${suffix}@example.com`,
      displayName: 'Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const friend = store.registerAccount({
      email: `dm-unread-friend-${suffix}@example.com`,
      displayName: 'Friend',
      password: '123456',
      role: 'player',
    })!.account;

    expect(store.requestFriend(owner.id, friend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friend.id, owner.id)?.status).toBe('accepted');

    const first = store.addDirectMessage(owner.id, friend.id, '第一条未读');
    expect(first).toBeTruthy();
    const friendSummaryAfterFirst = store.listFriends(friend.id).find((item) => item.id === owner.id);
    expect(friendSummaryAfterFirst).toMatchObject({
      direction: 'friend',
      unreadCount: 1,
      lastMessage: expect.objectContaining({ text: '第一条未读' }),
    });
    expect(store.listFriends(owner.id).find((item) => item.id === friend.id)?.unreadCount).toBe(0);

    expect(store.markDirectMessagesRead(friend.id, owner.id)).toMatchObject({
      id: owner.id,
      unreadCount: 0,
    });
    expect(store.listFriends(friend.id).find((item) => item.id === owner.id)?.unreadCount).toBe(0);

    const second = store.addDirectMessage(owner.id, friend.id, '第二条未读');
    expect(second).toBeTruthy();
    expect(store.listFriends(friend.id).find((item) => item.id === owner.id)).toMatchObject({
      unreadCount: 1,
      lastMessage: expect.objectContaining({ text: '第二条未读' }),
    });
  });

  it('marks direct messages read only up to the client visible message', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `dm-cursor-owner-${suffix}@example.com`,
      displayName: 'Owner',
      password: '123456',
    })!.account;
    const friend = store.registerAccount({
      email: `dm-cursor-friend-${suffix}@example.com`,
      displayName: 'Friend',
      password: '123456',
    })!.account;

    expect(store.requestFriend(owner.id, friend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friend.id, owner.id)?.status).toBe('accepted');
    const visible = store.addDirectMessage(owner.id, friend.id, '用户已经看到');
    const notYetVisible = store.addDirectMessage(owner.id, friend.id, '用户还没看到');
    expect(visible).toBeTruthy();
    expect(notYetVisible).toBeTruthy();

    expect(store.markDirectMessagesRead(friend.id, owner.id, visible!.id)).toMatchObject({
      unreadCount: 1,
    });
    expect(store.listFriends(friend.id).find((item) => item.id === owner.id)?.unreadCount).toBe(1);
    expect(store.markDirectMessagesRead(friend.id, owner.id, notYetVisible!.id)).toMatchObject({
      unreadCount: 0,
    });
  });

  it('does not roll direct read cursors back for same-millisecond read acknowledgements', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-19T02:00:00.000Z'));
    try {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const owner = store.registerAccount({
        email: `dm-same-ms-owner-${suffix}@example.com`,
        displayName: 'Owner',
        password: '123456',
      })!.account;
      const friend = store.registerAccount({
        email: `dm-same-ms-friend-${suffix}@example.com`,
        displayName: 'Friend',
        password: '123456',
      })!.account;

      expect(store.requestFriend(owner.id, friend.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friend.id, owner.id)?.status).toBe('accepted');
      const first = store.addDirectMessage(owner.id, friend.id, '同毫秒第一条');
      const second = store.addDirectMessage(owner.id, friend.id, '同毫秒第二条');
      expect(first?.createdAt).toBe(second?.createdAt);

      expect(store.markDirectMessagesRead(friend.id, owner.id, second!.id)).toMatchObject({
        unreadCount: 0,
        lastReadMessageId: second!.id,
      });
      expect(store.markDirectMessagesRead(friend.id, owner.id, first!.id)).toMatchObject({
        unreadCount: 0,
        lastReadMessageId: second!.id,
      });
      expect(store.listFriends(friend.id).find((item) => item.id === owner.id)).toMatchObject({
        unreadCount: 0,
        lastReadMessageId: second!.id,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects self direct messages because they are not a friend conversation', () => {
    const account = store.registerAccount({
      email: `dm-self-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      displayName: 'Self DM',
      password: '123456',
    })!.account;

    expect(store.requestFriend(account.id, account.email)).toBeNull();
    expect(store.addDirectMessage(account.id, account.id, 'note to self')).toBeNull();
    expect(store.listDirectMessages(account.id, account.id)).toBeNull();
    expect(store.listDirectMessagePage(account.id, account.id)).toBeNull();
    expect(store.markDirectMessagesRead(account.id, account.id)).toBeNull();
  });

  it('keeps direct history archived across friend removal and restores it after re-accepting', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `dm-archive-owner-${suffix}@example.com`,
      displayName: 'Owner',
      password: '123456',
    })!.account;
    const friend = store.registerAccount({
      email: `dm-archive-friend-${suffix}@example.com`,
      displayName: 'Friend',
      password: '123456',
    })!.account;

    expect(store.requestFriend(owner.id, friend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friend.id, owner.id)?.status).toBe('accepted');
    expect(store.addDirectMessage(owner.id, friend.id, '解除前历史')).toBeTruthy();
    expect(store.addDirectMessage(friend.id, owner.id, '解除前回复')).toBeTruthy();
    expect(store.markDirectMessagesRead(owner.id, friend.id)).toMatchObject({ unreadCount: 0 });
    expect(store.removeFriend(owner.id, friend.id)).toBe(true);
    expect(store.listDirectMessages(owner.id, friend.id)).toBeNull();
    expect(store.addDirectMessage(owner.id, friend.id, '解除后不能发送')).toBeNull();
    expect(store.markDirectMessagesRead(friend.id, owner.id)).toBeNull();

    expect(store.requestFriend(friend.id, owner.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(owner.id, friend.id)?.status).toBe('accepted');
    expect(store.listDirectMessages(owner.id, friend.id)?.map((message) => message.text)).toEqual(['解除前历史', '解除前回复']);
    expect(store.listFriends(friend.id).find((item) => item.id === owner.id)?.unreadCount).toBe(1);
    expect(store.listFriends(owner.id).find((item) => item.id === friend.id)?.unreadCount).toBe(1);
  });

  it('accepts direct message replies over REST and rejects references outside the conversation', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `dm-rest-reply-owner-${suffix}@example.com`,
        displayName: 'Rest Reply Owner',
        password: '123456',
      })!;
      const friendSession = store.registerAccount({
        email: `dm-rest-reply-friend-${suffix}@example.com`,
        displayName: 'Rest Reply Friend',
        password: '123456',
      })!;
      const otherSession = store.registerAccount({
        email: `dm-rest-reply-other-${suffix}@example.com`,
        displayName: 'Rest Reply Other',
        password: '123456',
      })!;

      expect(store.requestFriend(ownerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, ownerSession.account.id)?.status).toBe('accepted');
      expect(store.requestFriend(ownerSession.account.id, otherSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(otherSession.account.id, ownerSession.account.id)?.status).toBe('accepted');

      const anchorResponse = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({ text: 'REST 私聊原消息', clientMessageId: 'rest-dm-anchor' }),
      });
      expect(anchorResponse.status).toBe(201);
      const anchor = anchorResponse.body as DirectMessage;

      const tooLongDirect = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({ text: 'x'.repeat(2001) }),
      });
      expect(tooLongDirect.status).toBe(400);
      expect(tooLongDirect.body).toEqual({ error: '消息内容需为 1-2000 个字符。' });

      const replyResponse = await api(baseUrl, `/api/friends/${ownerSession.account.id}/messages`, {
        method: 'POST',
        token: friendSession.token,
        body: JSON.stringify({
          text: 'REST 私聊回复',
          clientMessageId: 'rest-dm-reply',
          replyToId: anchor.id,
        }),
      });
      expect(replyResponse.status).toBe(201);
      expect(replyResponse.body).toMatchObject({
        text: 'REST 私聊回复',
        replyTo: {
          id: anchor.id,
          author: 'Rest Reply Owner',
          text: 'REST 私聊原消息',
        },
      });
      const retryWithInvalidReply = await api(baseUrl, `/api/friends/${ownerSession.account.id}/messages`, {
        method: 'POST',
        token: friendSession.token,
        body: JSON.stringify({
          text: 'REST 私聊回复重试不应另存',
          clientMessageId: 'rest-dm-reply',
          replyToId: 'missing-retry-target',
        }),
      });
      expect(retryWithInvalidReply.status).toBe(201);
      expect(retryWithInvalidReply.body).toMatchObject({
        text: 'REST 私聊回复',
        clientMessageId: 'rest-dm-reply',
        replyTo: {
          id: anchor.id,
          author: 'Rest Reply Owner',
          text: 'REST 私聊原消息',
        },
      });
      expect(
        store
          .listDirectMessages(ownerSession.account.id, friendSession.account.id)
          ?.filter((message) => message.clientMessageId === 'rest-dm-reply'),
      ).toHaveLength(1);

      const invalidResponse = await api(baseUrl, `/api/friends/${otherSession.account.id}/messages`, {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({
          text: '跨会话引用',
          clientMessageId: 'rest-dm-invalid-reply',
          replyToId: anchor.id,
        }),
      });
      expect(invalidResponse.status).toBe(400);
      expect(invalidResponse.body).toMatchObject({ error: 'Reply target not found' });
    });
  });

  it('rebroadcasts idempotent direct message retries to account sockets', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `dm-retry-owner-${suffix}@example.com`,
        displayName: 'Owner',
        password: '123456',
        role: 'keeper',
      })!;
      const friendSession = store.registerAccount({
        email: `dm-retry-friend-${suffix}@example.com`,
        displayName: 'Friend',
        password: '123456',
        role: 'player',
      })!;

      expect(store.requestFriend(ownerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, ownerSession.account.id)?.status).toBe('accepted');

      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { token: friendSession.token },
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });

      try {
        const firstMessageEvent = waitForSocketEvent<DirectMessage>(socket, 'direct:message');
        const firstFriendEvent = waitForSocketEvent<FriendSummary[]>(socket, 'friends:changed');
        const firstResponse = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: '这条消息会重试', clientMessageId: 'same-dm' }),
        });
        expect(firstResponse.status).toBe(201);
        const firstMessage = await firstMessageEvent;
        expect(firstMessage).toMatchObject({ text: '这条消息会重试', clientMessageId: 'same-dm' });
        expect((await firstFriendEvent).find((item) => item.id === ownerSession.account.id)?.unreadCount).toBe(1);

        const retryMessageEvent = waitForSocketEvent<DirectMessage>(socket, 'direct:message');
        const retryFriendEvent = waitForSocketEvent<FriendSummary[]>(socket, 'friends:changed');
        const retryResponse = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: '这条重试不应另存', clientMessageId: 'same-dm' }),
        });
        expect(retryResponse.status).toBe(201);
        const retryMessage = await retryMessageEvent;
        expect(retryMessage.id).toBe(firstMessage.id);
        expect(retryMessage.text).toBe('这条消息会重试');
        expect((await retryFriendEvent).find((item) => item.id === ownerSession.account.id)?.unreadCount).toBe(1);
        expect(store.listDirectMessages(ownerSession.account.id, friendSession.account.id)?.filter((message) => message.clientMessageId === 'same-dm')).toHaveLength(1);
      } finally {
        socket.close();
      }
    });
  }, 15_000);

  it('rate limits REST direct messages, room chat, and room dice without blocking idempotent retries', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const directSession = store.registerAccount({
        email: `rest-limit-direct-${suffix}@example.com`,
        displayName: 'REST Limit Direct',
        password: '123456',
        role: 'keeper',
      })!;
      const friendSession = store.registerAccount({
        email: `rest-limit-friend-${suffix}@example.com`,
        displayName: 'REST Limit Friend',
        password: '123456',
        role: 'player',
      })!;
      const outsiderSession = store.registerAccount({
        email: `rest-limit-outsider-${suffix}@example.com`,
        displayName: 'REST Limit Outsider',
        password: '123456',
        role: 'player',
      })!;
      expect(store.requestFriend(directSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, directSession.account.id)?.status).toBe('accepted');

      let firstDirectMessageId = '';
      for (let index = 0; index < 30; index += 1) {
        const response = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
          method: 'POST',
          token: directSession.token,
          body: JSON.stringify({ text: `direct-${index}`, clientMessageId: `rest-limit-direct-${index}` }),
        });
        expect(response.status).toBe(201);
        if (index === 0) {
          firstDirectMessageId = response.body.id;
        }
      }
      const blockedDirect = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
        method: 'POST',
        token: directSession.token,
        body: JSON.stringify({ text: 'direct-blocked', clientMessageId: 'rest-limit-direct-blocked' }),
      });
      expect(blockedDirect.status).toBe(429);
      expect(blockedDirect.body).toMatchObject({
        error: '发送过于频繁，请稍后再试。',
        retryAfterSeconds: expect.any(Number),
      });
      const retriedDirect = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
        method: 'POST',
        token: directSession.token,
        body: JSON.stringify({ text: 'direct-retry', clientMessageId: 'rest-limit-direct-0' }),
      });
      expect(retriedDirect.status).toBe(201);
      expect(retriedDirect.body.id).toBe(firstDirectMessageId);

      const nonFriendDirect = await api(baseUrl, `/api/friends/${outsiderSession.account.id}/messages`, {
        method: 'POST',
        token: directSession.token,
        body: JSON.stringify({ text: 'not-friends', clientMessageId: 'rest-limit-direct-non-friend' }),
      });
      expect(nonFriendDirect.status).toBe(403);

      const chatSession = store.registerAccount({
        email: `rest-limit-chat-${suffix}@example.com`,
        displayName: 'REST Limit Chat',
        password: '123456',
        role: 'keeper',
      })!;
      const chatRoom = store.createRoom({
        owner: chatSession.account,
        name: 'REST Limit Chat Room',
        system: 'COC 7th',
      });

      let firstRoomMessageId = '';
      for (let index = 0; index < 30; index += 1) {
        const response = await api(baseUrl, `/api/rooms/${chatRoom.id}/messages`, {
          method: 'POST',
          token: chatSession.token,
          body: JSON.stringify({ text: `room-${index}`, clientMessageId: `rest-limit-room-${index}` }),
        });
        expect(response.status).toBe(201);
        if (index === 0) {
          firstRoomMessageId = response.body.id;
        }
      }
      const blockedRoom = await api(baseUrl, `/api/rooms/${chatRoom.id}/messages`, {
        method: 'POST',
        token: chatSession.token,
        body: JSON.stringify({ text: 'room-blocked', clientMessageId: 'rest-limit-room-blocked' }),
      });
      expect(blockedRoom.status).toBe(429);
      expect(blockedRoom.body).toMatchObject({
        error: '发送过于频繁，请稍后再试。',
        retryAfterSeconds: expect.any(Number),
      });
      const retriedRoom = await api(baseUrl, `/api/rooms/${chatRoom.id}/messages`, {
        method: 'POST',
        token: chatSession.token,
        body: JSON.stringify({ text: 'room-retry', clientMessageId: 'rest-limit-room-0' }),
      });
      expect(retriedRoom.status).toBe(201);
      expect(retriedRoom.body.id).toBe(firstRoomMessageId);

      const diceSession = store.registerAccount({
        email: `rest-limit-dice-${suffix}@example.com`,
        displayName: 'REST Limit Dice',
        password: '123456',
        role: 'keeper',
      })!;
      const diceRoom = store.createRoom({
        owner: diceSession.account,
        name: 'REST Limit Dice Room',
        system: 'COC 7th',
      });

      let firstDiceMessageId = '';
      for (let index = 0; index < 30; index += 1) {
        const response = await api(baseUrl, `/api/rooms/${diceRoom.id}/dice/roll`, {
          method: 'POST',
          token: diceSession.token,
          body: JSON.stringify({ formula: '1d6', clientMessageId: `rest-limit-dice-${index}` }),
        });
        expect(response.status).toBe(201);
        if (index === 0) {
          firstDiceMessageId = response.body.message.id;
        }
      }
      const blockedDice = await api(baseUrl, `/api/rooms/${diceRoom.id}/dice/roll`, {
        method: 'POST',
        token: diceSession.token,
        body: JSON.stringify({ formula: '1d6', clientMessageId: 'rest-limit-dice-blocked' }),
      });
      expect(blockedDice.status).toBe(429);
      expect(blockedDice.body).toMatchObject({
        error: '掷骰过于频繁，请稍后再试。',
        retryAfterSeconds: expect.any(Number),
      });
      const retriedDice = await api(baseUrl, `/api/rooms/${diceRoom.id}/dice/roll`, {
        method: 'POST',
        token: diceSession.token,
        body: JSON.stringify({ formula: '1d100', clientMessageId: 'rest-limit-dice-0' }),
      });
      expect(retriedDice.status).toBe(201);
      expect(retriedDice.body.message.id).toBe(firstDiceMessageId);
      expect(retriedDice.body.roll.formula).toBe('1d6');
    });
  }, 30_000);

  it('rate limits socket room chat and dice with retry hints', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const chatSession = store.registerAccount({
        email: `socket-limit-chat-${suffix}@example.com`,
        displayName: 'Socket Limit Chat',
        password: '123456',
        role: 'keeper',
      })!;
      const chatRoom = store.createRoom({
        owner: chatSession.account,
        name: 'Socket Limit Chat Room',
        system: 'COC 7th',
      });

      const socket = await connectSocket(baseUrl, chatSession.token);
      let diceSocket: ClientSocket | null = null;
      try {
        let firstChatId = '';
        for (let index = 0; index < 30; index += 1) {
          const response = await emitAck<{ ok: true; data: { id: string } }>(socket, 'chat:send', {
            roomId: chatRoom.id,
            token: chatSession.token,
            message: { text: `socket-room-${index}`, clientMessageId: `socket-limit-room-${index}` },
          });
          expect(response.ok).toBe(true);
          if (index === 0) {
            firstChatId = response.data.id;
          }
        }
        const blockedChat = await emitAck<{ ok: false; error: string; retryAfterSeconds?: number }>(socket, 'chat:send', {
          roomId: chatRoom.id,
          token: chatSession.token,
          message: { text: 'socket-room-blocked', clientMessageId: 'socket-limit-room-blocked' },
        });
        expect(blockedChat).toMatchObject({
          ok: false,
          error: '发送过于频繁，请稍后再试。',
          retryAfterSeconds: expect.any(Number),
        });
        const retriedChat = await emitAck<{ ok: true; data: { id: string; text: string } }>(socket, 'chat:send', {
          roomId: chatRoom.id,
          token: chatSession.token,
          message: { text: 'socket-room-retry', clientMessageId: 'socket-limit-room-0' },
        });
        expect(retriedChat.data.id).toBe(firstChatId);
        expect(retriedChat.data.text).toBe('socket-room-0');

        const diceSession = store.registerAccount({
          email: `socket-limit-dice-${suffix}@example.com`,
          displayName: 'Socket Limit Dice',
          password: '123456',
          role: 'keeper',
        })!;
        const diceRoom = store.createRoom({
          owner: diceSession.account,
          name: 'Socket Limit Dice Room',
          system: 'COC 7th',
        });

        diceSocket = await connectSocket(baseUrl, diceSession.token);
        let firstDiceId = '';
        for (let index = 0; index < 30; index += 1) {
          const response = await emitAck<{ ok: true; data: { message: { id: string } } }>(diceSocket, 'dice:roll', {
            roomId: diceRoom.id,
            token: diceSession.token,
            formula: '1d6',
            clientMessageId: `socket-limit-dice-${index}`,
          });
          expect(response.ok).toBe(true);
          if (index === 0) {
            firstDiceId = response.data.message.id;
          }
        }
        const blockedDice = await emitAck<{ ok: false; error: string; retryAfterSeconds?: number }>(diceSocket, 'dice:roll', {
          roomId: diceRoom.id,
          token: diceSession.token,
          formula: '1d6',
          clientMessageId: 'socket-limit-dice-blocked',
        });
        expect(blockedDice).toMatchObject({
          ok: false,
          error: '掷骰过于频繁，请稍后再试。',
          retryAfterSeconds: expect.any(Number),
        });
        const retriedDice = await emitAck<{ ok: true; data: { message: { id: string }; roll: { formula: string } } }>(
          diceSocket,
          'dice:roll',
          {
            roomId: diceRoom.id,
            token: diceSession.token,
            formula: '1d100',
            clientMessageId: 'socket-limit-dice-0',
          },
        );
        expect(retriedDice.data.message.id).toBe(firstDiceId);
        expect(retriedDice.data.roll.formula).toBe('1d6');
      } finally {
        socket.close();
        diceSocket?.close();
      }
    });
  }, 30_000);

  it('shares the interaction write budget across REST and socket writes for one account', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `shared-limit-owner-${suffix}@example.com`,
        displayName: 'Shared Limit Owner',
        password: '123456',
        role: 'keeper',
      })!;
      const friendSession = store.registerAccount({
        email: `shared-limit-friend-${suffix}@example.com`,
        displayName: 'Shared Limit Friend',
        password: '123456',
        role: 'player',
      })!;
      expect(store.requestFriend(ownerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, ownerSession.account.id)?.status).toBe('accepted');

      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Shared Limit Room',
        system: 'COC 7th',
      });

      for (let index = 0; index < 10; index += 1) {
        const response = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: `shared-direct-${index}`, clientMessageId: `shared-limit-direct-${index}` }),
        });
        expect(response.status).toBe(201);
      }
      for (let index = 0; index < 10; index += 1) {
        const response = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: `shared-room-${index}`, clientMessageId: `shared-limit-room-${index}` }),
        });
        expect(response.status).toBe(201);
      }
      for (let index = 0; index < 10; index += 1) {
        const response = await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ formula: '1d6', clientMessageId: `shared-limit-dice-${index}` }),
        });
        expect(response.status).toBe(201);
      }

      const socket = await connectSocket(baseUrl, ownerSession.token);
      try {
        const blockedSocketChat = await emitAck<{ ok: false; error: string; retryAfterSeconds?: number }>(socket, 'chat:send', {
          roomId: room.id,
          token: ownerSession.token,
          message: { text: 'shared-socket-blocked', clientMessageId: 'shared-limit-socket-blocked' },
        });
        expect(blockedSocketChat).toMatchObject({
          ok: false,
          error: '发送过于频繁，请稍后再试。',
          retryAfterSeconds: expect.any(Number),
        });
      } finally {
        socket.close();
      }
    });
  }, 30_000);

  it('signals direct friend calls and rejects non-friends', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const callerSession = store.registerAccount({
        email: `direct-call-caller-${suffix}@example.com`,
        displayName: 'Caller',
        password: '123456',
      })!;
      const friendSession = store.registerAccount({
        email: `direct-call-friend-${suffix}@example.com`,
        displayName: 'Friend',
        password: '123456',
      })!;
      const strangerSession = store.registerAccount({
        email: `direct-call-stranger-${suffix}@example.com`,
        displayName: 'Stranger',
        password: '123456',
      })!;

        expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
        expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');

        const voiceRoom = store.createRoom({
          owner: callerSession.account,
          name: `Direct Voice Conflict ${suffix}`,
          system: 'COC 7th',
          visibility: 'public',
        });
        expect(store.joinVoice(voiceRoom.id, callerSession.account, { muted: false }).ok).toBe(true);
        expect(store.getRoom(voiceRoom.id, callerSession.account)?.voice.participants.map((participant) => participant.id)).toEqual([
          callerSession.account.id,
        ]);

        const tokenBeforeInvite = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId: 'call-flow', voiceSessionId: 'caller000' }),
        });
        expect(tokenBeforeInvite.status).toBe(404);

        const strangerVoice = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: strangerSession.account.id, callId: 'stranger-call', voiceSessionId: 'caller002' }),
        });
        expect(strangerVoice.status).toBe(403);

        const savedLiveKitEnv = saveLiveKitEnv();
        const callerSocket = await connectSocket(baseUrl, callerSession.token);
        const friendSocket = await connectSocket(baseUrl, friendSession.token);
      try {
        configureLiveKitForTests();
        const inviteEvent = waitForSocketEvent<DirectCallEvent>(friendSocket, 'direct-call:invite');
        const inviteAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:invite',
          { token: callerSession.token, friendId: friendSession.account.id },
        );
        expect(inviteAck.ok).toBe(true);
        const invite = await inviteEvent;
        expect(invite.callId).toMatch(/^call-[a-f0-9]+$/);
        expect(invite).toMatchObject({
          fromId: callerSession.account.id,
          status: 'ringing',
          toId: friendSession.account.id,
        });

        const tokenBeforeAccept = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId: invite.callId, voiceSessionId: 'caller001' }),
        });
        expect(tokenBeforeAccept.status).toBe(403);

        const callerAcceptedEvent = waitForSocketEvent<DirectCallEvent>(callerSocket, 'direct-call:accepted');
        const friendAcceptedEvent = waitForSocketEvent<DirectCallEvent>(friendSocket, 'direct-call:accepted');
        const acceptAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          friendSocket,
          'direct-call:accept',
          { token: friendSession.token, friendId: callerSession.account.id, callId: invite.callId },
        );
        expect(acceptAck.ok).toBe(true);
        const acceptedPayload = {
          callId: invite.callId,
          fromId: callerSession.account.id,
          status: 'accepted',
          toId: friendSession.account.id,
        };
        if (acceptAck.ok) {
          expect(acceptAck.data).toMatchObject(acceptedPayload);
        }
        expect(await callerAcceptedEvent).toMatchObject(acceptedPayload);
        expect(await friendAcceptedEvent).toMatchObject(acceptedPayload);
        const heartbeatAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:heartbeat',
          { token: callerSession.token, friendId: friendSession.account.id, callId: invite.callId },
        );
        expect(heartbeatAck.ok).toBe(true);
        if (heartbeatAck.ok) {
          expect(heartbeatAck.data).toMatchObject(acceptedPayload);
        }
        expect(store.getRoom(voiceRoom.id, callerSession.account)?.voice.participants.map((participant) => participant.id)).toEqual([
          callerSession.account.id,
        ]);

        const restoredCallerSocket = await connectSocket(baseUrl, callerSession.token);
        try {
          const syncEvent = waitForSocketEvent<{ currentCall: DirectCallEvent | null }>(restoredCallerSocket, 'direct-call:sync');
          const restoredCallEvent = waitForSocketEvent<DirectCallEvent>(restoredCallerSocket, 'direct-call:accepted');
          const syncAck = await emitAck<{ ok: boolean; currentCall?: DirectCallEvent | null; error?: unknown }>(restoredCallerSocket, 'home:sync', {
            token: callerSession.token,
          });
          expect(syncAck.ok).toBe(true);
          expect(syncAck.currentCall).toMatchObject(acceptedPayload);
          expect(await syncEvent).toMatchObject({ currentCall: acceptedPayload });
          expect(await restoredCallEvent).toMatchObject(acceptedPayload);
        } finally {
          restoredCallerSocket.close();
        }

        const roomVoiceWhileDirect = await api(baseUrl, '/api/livekit/token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ roomId: voiceRoom.id, voiceSessionId: 'caller-room-voice' }),
        });
        expect(roomVoiceWhileDirect.status).toBe(200);
        const voiceJoinWhileDirect = await emitAck<{ ok: true; room: unknown } | { ok: false; error: unknown }>(
          callerSocket,
          'voice:join',
          { token: callerSession.token, roomId: voiceRoom.id },
        );
        expect(voiceJoinWhileDirect.ok).toBe(true);

        const readyBeforeDirectToken = await api(baseUrl, '/api/livekit/direct-ready', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId: invite.callId }),
        });
        expect(readyBeforeDirectToken.status).toBe(403);
        expect(store.getRoom(voiceRoom.id, callerSession.account)?.voice.participants.map((participant) => participant.id)).toEqual([
          callerSession.account.id,
        ]);

        const callerVoice = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId: invite.callId, voiceSessionId: 'caller001' }),
        });
        const friendVoice = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: friendSession.token,
          body: JSON.stringify({ friendId: callerSession.account.id, callId: invite.callId, voiceSessionId: 'friend001' }),
        });
        expect(callerVoice.status).toBe(200);
        expect(friendVoice.status).toBe(200);
        expect((callerVoice.body as VoiceTokenResponse).roomName).toMatch(/^direct:[a-f0-9]{32}$/);
        expect((friendVoice.body as VoiceTokenResponse).roomName).toBe((callerVoice.body as VoiceTokenResponse).roomName);
        expect((callerVoice.body as VoiceTokenResponse).identity).toContain(callerSession.account.id);
        expect((friendVoice.body as VoiceTokenResponse).identity).toContain(friendSession.account.id);

        const readyVoiceCleared = waitForSocketEvent<{ roomId: string; participants: Array<{ id: string }> }>(callerSocket, 'voice:state');
        const readyResponse = await api(baseUrl, '/api/livekit/direct-ready', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId: invite.callId }),
        });
        expect(readyResponse.status).toBe(200);
        await expect(readyVoiceCleared).resolves.toMatchObject({ roomId: voiceRoom.id, participants: [] });
        expect(store.getRoom(voiceRoom.id, callerSession.account)?.voice.participants).toEqual([]);

        const roomVoiceAfterReady = await api(baseUrl, '/api/livekit/token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ roomId: voiceRoom.id, voiceSessionId: 'caller-room-ready' }),
        });
        expect(roomVoiceAfterReady.status).toBe(403);

        const endedEvent = waitForSocketEvent<DirectCallEvent>(friendSocket, 'direct-call:ended');
        const endAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:end',
          { token: callerSession.token, friendId: friendSession.account.id, callId: invite.callId },
        );
        expect(endAck.ok).toBe(true);
        if (endAck.ok) {
          expect(endAck.data).toMatchObject({
            callId: invite.callId,
            fromId: callerSession.account.id,
            status: 'ended',
            toId: friendSession.account.id,
          });
        }
        expect(await endedEvent).toMatchObject({ callId: invite.callId, status: 'ended' });
        const heartbeatAfterEnd = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:heartbeat',
          { token: callerSession.token, friendId: friendSession.account.id, callId: invite.callId },
        );
        expect(heartbeatAfterEnd.ok).toBe(false);

        const terminalSyncSocket = await connectSocket(baseUrl, callerSession.token);
        try {
          const terminalSyncEvent = waitForSocketEvent<{ currentCall: DirectCallEvent | null }>(terminalSyncSocket, 'direct-call:sync');
          const terminalSyncAck = await emitAck<{ ok: boolean; currentCall?: DirectCallEvent | null; error?: unknown }>(terminalSyncSocket, 'home:sync', {
            token: callerSession.token,
          });
          expect(terminalSyncAck.ok).toBe(true);
          expect(terminalSyncAck.currentCall).toMatchObject({ callId: invite.callId, status: 'ended' });
          expect(await terminalSyncEvent).toMatchObject({ currentCall: { callId: invite.callId, status: 'ended' } });
        } finally {
          terminalSyncSocket.close();
        }

        const tokenAfterEnd = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId: invite.callId, voiceSessionId: 'caller003' }),
        });
        expect(tokenAfterEnd.status).toBe(403);

        const strangerAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:invite',
          { token: callerSession.token, friendId: strangerSession.account.id, callId: 'stranger-call' },
        );
        expect(strangerAck.ok).toBe(false);
      } finally {
        restoreLiveKitEnv(savedLiveKitEnv);
        await Promise.all([closeSocket(callerSocket), closeSocket(friendSocket)]);
      }
    });
  });

  it('clears both room voice participants and broadcasts voice state when direct voice is ready', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const callerSession = store.registerAccount({
        email: `direct-voice-clear-caller-${suffix}@example.com`,
        displayName: 'Voice Caller',
        password: '123456',
      })!;
      const friendSession = store.registerAccount({
        email: `direct-voice-clear-friend-${suffix}@example.com`,
        displayName: 'Voice Friend',
        password: '123456',
      })!;
      expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');

      const room = store.createRoom({
        owner: callerSession.account,
        name: `Direct voice handoff ${suffix}`,
        system: 'COC 7th',
        visibility: 'public',
      });
      expect(enterRecruiting(room.id, callerSession.account).ok).toBe(true);

      const callerSocket = await connectSocket(baseUrl, callerSession.token);
      const friendSocket = await connectSocket(baseUrl, friendSession.token);
      const savedLiveKitEnv = saveLiveKitEnv();
      try {
        configureLiveKitForTests();
        expect((await emitAck<{ ok: boolean }>(callerSocket, 'room:join', {
          roomId: room.id,
          role: 'keeper',
          token: callerSession.token,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(friendSocket, 'room:join', {
          roomId: room.id,
          role: 'player',
          token: friendSession.token,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(callerSocket, 'voice:join', {
          roomId: room.id,
          token: callerSession.token,
          muted: false,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(friendSocket, 'voice:join', {
          roomId: room.id,
          token: friendSession.token,
          muted: true,
        })).ok).toBe(true);
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants.map((participant) => participant.id).sort()).toEqual([
          callerSession.account.id,
          friendSession.account.id,
        ].sort());

        const inviteAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:invite',
          { token: callerSession.token, friendId: friendSession.account.id },
        );
        expect(inviteAck.ok).toBe(true);
        const callId = inviteAck.ok ? inviteAck.data.callId : '';
        const acceptedEvent = waitForSocketEvent<DirectCallEvent>(callerSocket, 'direct-call:accepted');

        const acceptAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          friendSocket,
          'direct-call:accept',
          { token: friendSession.token, friendId: callerSession.account.id, callId },
        );
        expect(acceptAck.ok).toBe(true);
        await expect(acceptedEvent).resolves.toMatchObject({ callId, status: 'accepted' });
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants.map((participant) => participant.id).sort()).toEqual([
          callerSession.account.id,
          friendSession.account.id,
        ].sort());

        const friendToken = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: friendSession.token,
          body: JSON.stringify({ friendId: callerSession.account.id, callId, voiceSessionId: 'friend-ready-1' }),
        });
        expect(friendToken.status).toBe(200);
        const callerSeesFriendReady = waitForSocketEvent<{ roomId: string; participants: Array<{ id: string }> }>(callerSocket, 'voice:state');
        const friendSeesFriendReady = waitForSocketEvent<{ roomId: string; participants: Array<{ id: string }> }>(friendSocket, 'voice:state');
        const readyResponse = await api(baseUrl, '/api/livekit/direct-ready', {
          method: 'POST',
          token: friendSession.token,
          body: JSON.stringify({ friendId: callerSession.account.id, callId }),
        });
        expect(readyResponse.status).toBe(200);
        await expect(callerSeesFriendReady).resolves.toMatchObject({
          roomId: room.id,
          participants: [expect.objectContaining({ id: callerSession.account.id })],
        });
        await expect(friendSeesFriendReady).resolves.toMatchObject({
          roomId: room.id,
          participants: [expect.objectContaining({ id: callerSession.account.id })],
        });
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants.map((participant) => participant.id)).toEqual([
          callerSession.account.id,
        ]);

        const callerToken = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId, voiceSessionId: 'caller-ready-1' }),
        });
        expect(callerToken.status).toBe(200);
        const callerVoiceCleared = waitForSocketEvent<{ roomId: string; participants: Array<{ id: string }> }>(callerSocket, 'voice:state');
        const friendVoiceCleared = waitForSocketEvent<{ roomId: string; participants: Array<{ id: string }> }>(friendSocket, 'voice:state');
        const callerReadyResponse = await api(baseUrl, '/api/livekit/direct-ready', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId }),
        });
        expect(callerReadyResponse.status).toBe(200);
        await expect(callerVoiceCleared).resolves.toMatchObject({ roomId: room.id, participants: [] });
        await expect(friendVoiceCleared).resolves.toMatchObject({ roomId: room.id, participants: [] });
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants).toEqual([]);

        const roomVoiceWhileDirect = await emitAck<{ ok: true; room: unknown } | { ok: false; error: unknown }>(
          callerSocket,
          'voice:join',
          { token: callerSession.token, roomId: room.id },
        );
        expect(roomVoiceWhileDirect.ok).toBe(false);
      } finally {
        restoreLiveKitEnv(savedLiveKitEnv);
        await Promise.all([closeSocket(callerSocket), closeSocket(friendSocket)]);
      }
    });
  });

  it('keeps room voice active and blocks room-token bypass while direct LiveKit is unconfigured', async () => {
    const savedLiveKitEnv = saveLiveKitEnv();
    clearLiveKitEnv();
    try {
      await withServer(async (baseUrl) => {
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const callerSession = store.registerAccount({
          email: `direct-unconfigured-caller-${suffix}@example.com`,
          displayName: 'Unconfigured Caller',
          password: '123456',
        })!;
        const friendSession = store.registerAccount({
          email: `direct-unconfigured-friend-${suffix}@example.com`,
          displayName: 'Unconfigured Friend',
          password: '123456',
        })!;
        expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
        expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');

        const room = store.createRoom({
          owner: callerSession.account,
          name: `Direct unconfigured room ${suffix}`,
          system: 'COC 7th',
          visibility: 'public',
        });
        expect(enterRecruiting(room.id, callerSession.account).ok).toBe(true);
        expect(store.joinRoom(room.id, friendSession.account, 'player').ok).toBe(true);
        expect(store.joinVoice(room.id, callerSession.account, { muted: false }).ok).toBe(true);
        expect(store.createDirectCall(callerSession.account.id, friendSession.account.id, 'unconfigured-direct').ok).toBe(true);
        expect(store.acceptDirectCall(friendSession.account.id, callerSession.account.id, 'unconfigured-direct').ok).toBe(true);

        const friendRoomVoiceBypass = await api(baseUrl, '/api/livekit/token', {
          method: 'POST',
          token: friendSession.token,
          body: JSON.stringify({ roomId: room.id, voiceSessionId: 'friend-room-bypass' }),
        });
        expect(friendRoomVoiceBypass.status).toBe(403);

        const callerRoomVoiceRenewal = await api(baseUrl, '/api/livekit/token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ roomId: room.id, voiceSessionId: 'caller-room-renew' }),
        });
        expect(callerRoomVoiceRenewal.status).toBe(200);
        expect(callerRoomVoiceRenewal.body).toMatchObject({ configured: false });

        const directToken = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({
            friendId: friendSession.account.id,
            callId: 'unconfigured-direct',
            voiceSessionId: 'caller-direct-unconfigured',
          }),
        });
        expect(directToken.status).toBe(200);
        expect(directToken.body).toMatchObject({ configured: false });

        const directReady = await api(baseUrl, '/api/livekit/direct-ready', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({
            friendId: friendSession.account.id,
            callId: 'unconfigured-direct',
          }),
        });
        expect(directReady.status).toBe(403);
        expect(directReady.body).toMatchObject({ error: 'Join direct voice first' });
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants).toEqual([
          expect.objectContaining({ id: callerSession.account.id }),
        ]);
      });
    } finally {
      restoreLiveKitEnv(savedLiveKitEnv);
    }
  });

  it('broadcasts direct call ended when only one peer keeps heartbeating', async () => {
    await withServer(async (baseUrl) => {
      const startedAt = new Date('2026-01-03T00:00:00.000Z');
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const callerSession = store.registerAccount({
        email: `direct-peer-offline-caller-${suffix}@example.com`,
        displayName: 'Peer Offline Caller',
        password: '123456',
      })!;
      const friendSession = store.registerAccount({
        email: `direct-peer-offline-friend-${suffix}@example.com`,
        displayName: 'Peer Offline Friend',
        password: '123456',
      })!;
      expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');

      let callerSocket: ClientSocket | null = null;
      let friendSocket: ClientSocket | null = null;
      let dateNowSpy: { mockReturnValue(value: number): unknown; mockRestore(): void } | null = null;
      try {
        callerSocket = await connectSocket(baseUrl, callerSession.token);
        friendSocket = await connectSocket(baseUrl, friendSession.token);
        dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt.getTime());
        const inviteAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:invite',
          { token: callerSession.token, friendId: friendSession.account.id, callId: 'peer-offline-call' },
        );
        expect(inviteAck.ok).toBe(true);
        const acceptAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          friendSocket,
          'direct-call:accept',
          { token: friendSession.token, friendId: callerSession.account.id, callId: 'peer-offline-call' },
        );
        expect(acceptAck.ok).toBe(true);

        dateNowSpy.mockReturnValue(startedAt.getTime() + 45_000);
        const callerHeartbeat = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:heartbeat',
          { token: callerSession.token, friendId: friendSession.account.id, callId: 'peer-offline-call' },
        );
        expect(callerHeartbeat.ok).toBe(true);

        const callerEnded = waitForSocketEvent<DirectCallEvent>(callerSocket, 'direct-call:ended');
        const friendEnded = waitForSocketEvent<DirectCallEvent>(friendSocket, 'direct-call:ended');
        dateNowSpy.mockReturnValue(startedAt.getTime() + 301_000);
        const lateHeartbeat = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:heartbeat',
          { token: callerSession.token, friendId: friendSession.account.id, callId: 'peer-offline-call' },
        );
        expect(lateHeartbeat.ok).toBe(false);
        await expect(callerEnded).resolves.toMatchObject({ callId: 'peer-offline-call', status: 'ended' });
        await expect(friendEnded).resolves.toMatchObject({ callId: 'peer-offline-call', status: 'ended' });
      } finally {
        dateNowSpy?.mockRestore();
        callerSocket?.close();
        friendSocket?.close();
      }
    });
  }, 15_000);

  it('uses the unified room voice handoff path when direct voice reports ready', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const callerSession = store.registerAccount({
        email: `direct-token-handoff-caller-${suffix}@example.com`,
        displayName: 'Direct Token Caller',
        password: '123456',
      })!;
      const friendSession = store.registerAccount({
        email: `direct-token-handoff-friend-${suffix}@example.com`,
        displayName: 'Direct Token Friend',
        password: '123456',
      })!;
      expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');

      const room = store.createRoom({
        owner: callerSession.account,
        name: `Direct token voice handoff ${suffix}`,
        system: 'COC 7th',
        visibility: 'public',
      });
      expect(enterRecruiting(room.id, callerSession.account).ok).toBe(true);

      const callerSocket = await connectSocket(baseUrl, callerSession.token);
      const friendSocket = await connectSocket(baseUrl, friendSession.token);
      const previousLiveKitUrl = process.env.LIVEKIT_URL;
      const previousLiveKitApiUrl = process.env.LIVEKIT_API_URL;
      const previousLiveKitKey = process.env.LIVEKIT_API_KEY;
      const previousLiveKitSecret = process.env.LIVEKIT_API_SECRET;
      try {
        expect((await emitAck<{ ok: boolean }>(callerSocket, 'room:join', {
          roomId: room.id,
          role: 'keeper',
          token: callerSession.token,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(callerSocket, 'voice:join', {
          roomId: room.id,
          token: callerSession.token,
          muted: true,
          quality: 'relay',
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(friendSocket, 'room:join', {
          roomId: room.id,
          role: 'player',
          token: friendSession.token,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(friendSocket, 'voice:join', {
          roomId: room.id,
          token: friendSession.token,
          muted: false,
          quality: 'good',
        })).ok).toBe(true);
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: callerSession.account.id, muted: true, quality: 'relay' }),
          expect.objectContaining({ id: friendSession.account.id, muted: false, quality: 'good' }),
        ]));

        expect(store.createDirectCall(callerSession.account.id, friendSession.account.id, 'rest-handoff-call').ok).toBe(true);
        expect(store.acceptDirectCall(friendSession.account.id, callerSession.account.id, 'rest-handoff-call').ok).toBe(true);
        const directCallLockedUpdate = store.updateVoiceParticipant(room.id, callerSession.account, { speaking: true });
        expect(directCallLockedUpdate).toMatchObject({ ok: true });

        process.env.LIVEKIT_URL = 'wss://livekit.example.test';
        process.env.LIVEKIT_API_URL = 'http://127.0.0.1:1';
        process.env.LIVEKIT_API_KEY = 'devkey';
        process.env.LIVEKIT_API_SECRET = 'devsecret';

        const directVoice = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({
            friendId: friendSession.account.id,
            callId: 'rest-handoff-call',
            voiceSessionId: 'rest0001',
          }),
        });
        expect(directVoice.status).toBe(200);
        expect(directVoice.body).toMatchObject({
          configured: true,
        });
        expect(directVoice.body).not.toHaveProperty('changedRoomIds');
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: callerSession.account.id }),
          expect.objectContaining({ id: friendSession.account.id }),
        ]));

        const readyVoice = await api(baseUrl, '/api/livekit/direct-ready', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({
            friendId: friendSession.account.id,
            callId: 'rest-handoff-call',
          }),
        });
        expect(readyVoice.status).toBe(200);
        expect(readyVoice.body).toMatchObject({ changedRoomIds: [room.id] });
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants).toEqual([
          expect.objectContaining({ id: friendSession.account.id }),
        ]);

        const friendDirectVoice = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: friendSession.token,
          body: JSON.stringify({
            friendId: callerSession.account.id,
            callId: 'rest-handoff-call',
            voiceSessionId: 'rest0002',
          }),
        });
        expect(friendDirectVoice.status).toBe(200);
        expect(friendDirectVoice.body).toMatchObject({
          configured: true,
        });

        const finalReadyVoice = await api(baseUrl, '/api/livekit/direct-ready', {
          method: 'POST',
          token: friendSession.token,
          body: JSON.stringify({
            friendId: callerSession.account.id,
            callId: 'rest-handoff-call',
          }),
        });
        expect(finalReadyVoice.status).toBe(200);
        expect(finalReadyVoice.body).toMatchObject({ changedRoomIds: [room.id] });
        expect(store.getRoom(room.id, callerSession.account)?.voice.participants).toEqual([]);
      } finally {
        if (previousLiveKitUrl === undefined) {
          delete process.env.LIVEKIT_URL;
        } else {
          process.env.LIVEKIT_URL = previousLiveKitUrl;
        }
        if (previousLiveKitApiUrl === undefined) {
          delete process.env.LIVEKIT_API_URL;
        } else {
          process.env.LIVEKIT_API_URL = previousLiveKitApiUrl;
        }
        if (previousLiveKitKey === undefined) {
          delete process.env.LIVEKIT_API_KEY;
        } else {
          process.env.LIVEKIT_API_KEY = previousLiveKitKey;
        }
        if (previousLiveKitSecret === undefined) {
          delete process.env.LIVEKIT_API_SECRET;
        } else {
          process.env.LIVEKIT_API_SECRET = previousLiveKitSecret;
        }
        await Promise.all([closeSocket(callerSocket), closeSocket(friendSocket)]);
      }
    });
  }, 15_000);

  it('broadcasts direct call end when friendship is removed during an active call', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const callerSession = store.registerAccount({
        email: `direct-remove-caller-${suffix}@example.com`,
        displayName: 'Remove Caller',
        password: '123456',
      })!;
      const friendSession = store.registerAccount({
        email: `direct-remove-friend-${suffix}@example.com`,
        displayName: 'Remove Friend',
        password: '123456',
      })!;
      expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');

      const callerSocket = await connectSocket(baseUrl, callerSession.token);
      const friendSocket = await connectSocket(baseUrl, friendSession.token);
      try {
        const inviteAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          callerSocket,
          'direct-call:invite',
          { token: callerSession.token, friendId: friendSession.account.id },
        );
        expect(inviteAck.ok).toBe(true);
        const callId = inviteAck.ok ? inviteAck.data.callId : '';
        const acceptedEvent = waitForSocketEvent<DirectCallEvent>(callerSocket, 'direct-call:accepted');
        const acceptAck = await emitAck<{ ok: true; data: DirectCallEvent } | { ok: false; error: unknown }>(
          friendSocket,
          'direct-call:accept',
          { token: friendSession.token, friendId: callerSession.account.id, callId },
        );
        expect(acceptAck.ok).toBe(true);
        await expect(acceptedEvent).resolves.toMatchObject({ callId, status: 'accepted' });

        const callerEnded = waitForSocketEvent<DirectCallEvent>(callerSocket, 'direct-call:ended');
        const friendEnded = waitForSocketEvent<DirectCallEvent>(friendSocket, 'direct-call:ended');
        const removeResponse = await api(baseUrl, `/api/friends/${friendSession.account.id}`, {
          method: 'DELETE',
          token: callerSession.token,
        });
        expect(removeResponse.status).toBe(204);
        await expect(callerEnded).resolves.toMatchObject({ callId, status: 'ended' });
        await expect(friendEnded).resolves.toMatchObject({ callId, status: 'ended' });

        const directTokenAfterRemoval = await api(baseUrl, '/api/livekit/direct-token', {
          method: 'POST',
          token: callerSession.token,
          body: JSON.stringify({ friendId: friendSession.account.id, callId, voiceSessionId: 'removed-call' }),
        });
        expect(directTokenAfterRemoval.status).toBe(403);
      } finally {
        callerSocket.close();
        friendSocket.close();
      }
    });
  });

  it('expires stale direct friend calls and releases the next call', () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const callerSession = store.registerAccount({
      email: `direct-expire-caller-${suffix}@example.com`,
      displayName: 'Expire Caller',
      password: '123456',
    })!;
    const friendSession = store.registerAccount({
      email: `direct-expire-friend-${suffix}@example.com`,
      displayName: 'Expire Friend',
      password: '123456',
    })!;
    expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');

    const created = store.createDirectCall(callerSession.account.id, friendSession.account.id, 'expiring-call');
    expect(created.ok).toBe(true);
    const liveKitRoomName = created.ok ? created.session.roomName : '';
    expect(store.sweepExpiredDirectCalls()).toEqual([]);

    vi.setSystemTime(new Date(startedAt.getTime() + 121_000));
    const expiredEvents = store.sweepExpiredDirectCalls();
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0]).toMatchObject({
      callId: 'expiring-call',
      fromId: callerSession.account.id,
      liveKitRoomName,
      status: 'ended',
      toId: friendSession.account.id,
    });
    expect(store.acceptDirectCall(friendSession.account.id, callerSession.account.id, 'expiring-call').ok).toBe(false);
    expect(store.createDirectCall(callerSession.account.id, friendSession.account.id, 'fresh-call').ok).toBe(true);
    expect(store.endDirectCall(callerSession.account.id, friendSession.account.id, 'fresh-call').ok).toBe(true);
  });

  it('expires accepted direct calls unless both peers keep sending heartbeat', () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-01-02T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const callerSession = store.registerAccount({
      email: `direct-lease-caller-${suffix}@example.com`,
      displayName: 'Lease Caller',
      password: '123456',
    })!;
    const friendSession = store.registerAccount({
      email: `direct-lease-friend-${suffix}@example.com`,
      displayName: 'Lease Friend',
      password: '123456',
    })!;
    expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');
    const room = store.createRoom({
      owner: callerSession.account,
      name: `Direct lease room ${suffix}`,
      system: 'COC 7th',
      visibility: 'public',
    });

    expect(store.createDirectCall(callerSession.account.id, friendSession.account.id, 'lease-timeout').ok).toBe(true);
    expect(store.acceptDirectCall(friendSession.account.id, callerSession.account.id, 'lease-timeout').ok).toBe(true);
    expect(store.joinVoice(room.id, callerSession.account).ok).toBe(false);
    expect(store.getDirectCallVoiceRoomName(callerSession.account.id, friendSession.account.id, 'lease-timeout').ok).toBe(true);

    vi.setSystemTime(new Date(startedAt.getTime() + 120_001));
    expect(store.sweepExpiredDirectCalls()).toEqual([]);
    expect(store.joinVoice(room.id, callerSession.account).ok).toBe(false);
    expect(store.getDirectCallVoiceRoomName(callerSession.account.id, friendSession.account.id, 'lease-timeout').ok).toBe(true);

    vi.setSystemTime(new Date(startedAt.getTime() + 300_001));
    const expiredEvents = store.sweepExpiredDirectCalls();
    expect(expiredEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        callId: 'lease-timeout',
        fromId: callerSession.account.id,
        status: 'ended',
        toId: friendSession.account.id,
      }),
    ]));
    expect(store.joinVoice(room.id, callerSession.account).ok).toBe(true);
    expect(store.getDirectCallVoiceRoomName(callerSession.account.id, friendSession.account.id, 'lease-timeout').ok).toBe(false);
    expect(store.leaveVoice(room.id, callerSession.account.id).ok).toBe(true);

    vi.setSystemTime(new Date(startedAt.getTime() + 70_000));
    expect(store.createDirectCall(callerSession.account.id, friendSession.account.id, 'lease-renew').ok).toBe(true);
    expect(store.acceptDirectCall(friendSession.account.id, callerSession.account.id, 'lease-renew').ok).toBe(true);
    vi.setSystemTime(new Date(startedAt.getTime() + 175_000));
    const heartbeat = store.heartbeatDirectCall(callerSession.account.id, friendSession.account.id, 'lease-renew');
    expect(heartbeat.ok).toBe(true);
    expect(store.sweepExpiredDirectCalls()).toEqual([]);
    vi.setSystemTime(new Date(startedAt.getTime() + 369_000));
    expect(store.sweepExpiredDirectCalls()).toEqual([]);
    expect(store.getDirectCallVoiceRoomName(callerSession.account.id, friendSession.account.id, 'lease-renew').ok).toBe(true);
    vi.setSystemTime(new Date(startedAt.getTime() + 371_000));
    expect(store.sweepExpiredDirectCalls()).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'lease-renew', status: 'ended' }),
    ]));
    expect(store.joinVoice(room.id, callerSession.account).ok).toBe(true);
    expect(store.getDirectCallVoiceRoomName(callerSession.account.id, friendSession.account.id, 'lease-renew').ok).toBe(false);
    expect(store.leaveVoice(room.id, callerSession.account.id).ok).toBe(true);

    vi.setSystemTime(new Date(startedAt.getTime() + 140_000));
    expect(store.createDirectCall(callerSession.account.id, friendSession.account.id, 'lease-renew-both').ok).toBe(true);
    expect(store.acceptDirectCall(friendSession.account.id, callerSession.account.id, 'lease-renew-both').ok).toBe(true);
    vi.setSystemTime(new Date(startedAt.getTime() + 245_000));
    expect(store.heartbeatDirectCall(callerSession.account.id, friendSession.account.id, 'lease-renew-both').ok).toBe(true);
    vi.setSystemTime(new Date(startedAt.getTime() + 246_000));
    expect(store.heartbeatDirectCall(friendSession.account.id, callerSession.account.id, 'lease-renew-both').ok).toBe(true);
    vi.setSystemTime(new Date(startedAt.getTime() + 544_000));
    expect(store.sweepExpiredDirectCalls()).toEqual([]);
    expect(store.joinVoice(room.id, callerSession.account).ok).toBe(false);
    expect(store.getDirectCallVoiceRoomName(callerSession.account.id, friendSession.account.id, 'lease-renew-both').ok).toBe(true);
    vi.setSystemTime(new Date(startedAt.getTime() + 546_000));
    expect(store.sweepExpiredDirectCalls()).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'lease-renew-both', status: 'ended' }),
    ]));
    expect(store.joinVoice(room.id, callerSession.account).ok).toBe(true);
    expect(store.getDirectCallVoiceRoomName(callerSession.account.id, friendSession.account.id, 'lease-renew-both').ok).toBe(false);
  });

  it('persists direct call lifecycle state for restart recovery', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const callerSession = store.registerAccount({
      email: `direct-persist-caller-${suffix}@example.com`,
      displayName: 'Persist Caller',
      password: '123456',
    })!;
    const friendSession = store.registerAccount({
      email: `direct-persist-friend-${suffix}@example.com`,
      displayName: 'Persist Friend',
      password: '123456',
    })!;
    expect(store.requestFriend(callerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friendSession.account.id, callerSession.account.id)?.status).toBe('accepted');

    const callId = `persist-call-${suffix}`;
    expect(store.createDirectCall(callerSession.account.id, friendSession.account.id, callId).ok).toBe(true);
    expect(persistedDirectCall(callId)).toMatchObject({
      callId,
      callerId: callerSession.account.id,
      calleeId: friendSession.account.id,
      status: 'ringing',
    });

    expect(store.acceptDirectCall(friendSession.account.id, callerSession.account.id, callId).ok).toBe(true);
    expect(persistedDirectCall(callId)).toMatchObject({
      callId,
      status: 'accepted',
      callerLastSeenAt: expect.any(String),
      calleeLastSeenAt: expect.any(String),
    });

    expect(store.markDirectCallVoiceTokenIssued(callerSession.account.id, friendSession.account.id, callId).ok).toBe(true);
    expect(persistedDirectCall(callId)).toMatchObject({
      callId,
      status: 'accepted',
      callerVoiceTokenIssuedAt: expect.any(String),
    });

    expect(store.markDirectCallVoiceReady(callerSession.account.id, friendSession.account.id, callId).ok).toBe(true);
    expect(persistedDirectCall(callId)).toMatchObject({
      callId,
      status: 'accepted',
      callerVoiceReadyAt: expect.any(String),
    });

    expect(store.endDirectCall(callerSession.account.id, friendSession.account.id, callId).ok).toBe(true);
    expect(persistedDirectCall(callId)).toMatchObject({
      callId,
      status: 'ended',
    });
  });

  it('disconnects revoked account sockets so logged-out sessions stop receiving direct messages', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `revoked-socket-owner-${suffix}@example.com`,
        displayName: 'Owner',
        password: '123456',
      })!;
      const friendSession = store.registerAccount({
        email: `revoked-socket-friend-${suffix}@example.com`,
        displayName: 'Friend',
        password: '123456',
      })!;

      expect(store.requestFriend(ownerSession.account.id, friendSession.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(friendSession.account.id, ownerSession.account.id)?.status).toBe('accepted');

      const friendSocket = await connectSocket(baseUrl, friendSession.token);
      try {
        const revokedEvent = waitForSocketEvent<void>(friendSocket, 'auth:revoked');
        const disconnectEvent = new Promise<void>((resolve) => {
          friendSocket.once('disconnect', () => resolve());
        });
        const logoutResponse = await api(baseUrl, '/api/auth/logout', {
          method: 'POST',
          token: friendSession.token,
        });
        expect(logoutResponse.status).toBe(204);
        await revokedEvent;
        await disconnectEvent;

        const noDirectMessage = waitForNoSocketEvent<DirectMessage>(friendSocket, 'direct:message', 200);
        const messageResponse = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: 'logged out sockets must not receive this', clientMessageId: 'revoked-dm' }),
        });
        expect(messageResponse.status).toBe(201);
        expect(await noDirectMessage).toBeNull();
      } finally {
        friendSocket.close();
      }
    });
  });

  it('sends friends:changed only to relevant account sockets', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `friend-socket-owner-${suffix}@example.com`,
        displayName: 'Friend Socket Owner',
        password: '123456',
      })!;
      const friendSession = store.registerAccount({
        email: `friend-socket-friend-${suffix}@example.com`,
        displayName: 'Friend Socket Friend',
        password: '123456',
      })!;
      const outsiderSession = store.registerAccount({
        email: `friend-socket-outsider-${suffix}@example.com`,
        displayName: 'Friend Socket Outsider',
        password: '123456',
      })!;

      const ownerSocket = await connectSocket(baseUrl, ownerSession.token);
      const friendSocket = await connectSocket(baseUrl, friendSession.token);
      const outsiderSocket = await connectSocket(baseUrl, outsiderSession.token);
      try {
        let ownerChanged = waitForSocketEvent<FriendSummary[]>(ownerSocket, 'friends:changed');
        let friendChanged = waitForSocketEvent<FriendSummary[]>(friendSocket, 'friends:changed');
        let outsiderQuiet = waitForNoSocketEvent<FriendSummary[]>(outsiderSocket, 'friends:changed');
        const requestResult = await api(baseUrl, '/api/friends', {
          method: 'POST',
          token: friendSession.token,
          body: JSON.stringify({ email: ownerSession.account.email }),
        });
        expect(requestResult.status).toBe(201);
        expect((await ownerChanged).find((item) => item.id === friendSession.account.id)?.direction).toBe('incoming');
        expect((await friendChanged).find((item) => item.id === ownerSession.account.id)?.direction).toBe('outgoing');
        expect(await outsiderQuiet).toBeNull();

        ownerChanged = waitForSocketEvent<FriendSummary[]>(ownerSocket, 'friends:changed');
        friendChanged = waitForSocketEvent<FriendSummary[]>(friendSocket, 'friends:changed');
        outsiderQuiet = waitForNoSocketEvent<FriendSummary[]>(outsiderSocket, 'friends:changed');
        const acceptResult = await api(baseUrl, `/api/friends/${friendSession.account.id}/accept`, {
          method: 'POST',
          token: ownerSession.token,
        });
        expect(acceptResult.status).toBe(200);
        expect((await ownerChanged).find((item) => item.id === friendSession.account.id)?.direction).toBe('friend');
        expect((await friendChanged).find((item) => item.id === ownerSession.account.id)?.direction).toBe('friend');
        expect(await outsiderQuiet).toBeNull();

        ownerChanged = waitForSocketEvent<FriendSummary[]>(ownerSocket, 'friends:changed');
        friendChanged = waitForSocketEvent<FriendSummary[]>(friendSocket, 'friends:changed');
        outsiderQuiet = waitForNoSocketEvent<FriendSummary[]>(outsiderSocket, 'friends:changed');
        const messageResult = await api(baseUrl, `/api/friends/${friendSession.account.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: 'socket scoped message', clientMessageId: 'socket-scoped-message' }),
        });
        expect(messageResult.status).toBe(201);
        const message = messageResult.body as DirectMessage;
        expect((await ownerChanged).find((item) => item.id === friendSession.account.id)?.unreadCount).toBe(0);
        expect((await friendChanged).find((item) => item.id === ownerSession.account.id)?.unreadCount).toBe(1);
        expect(await outsiderQuiet).toBeNull();

        const ownerReadQuiet = waitForNoSocketEvent<FriendSummary[]>(ownerSocket, 'friends:changed');
        friendChanged = waitForSocketEvent<FriendSummary[]>(friendSocket, 'friends:changed');
        outsiderQuiet = waitForNoSocketEvent<FriendSummary[]>(outsiderSocket, 'friends:changed');
        const readResult = await api(baseUrl, `/api/friends/${ownerSession.account.id}/messages/read`, {
          method: 'POST',
          token: friendSession.token,
          body: JSON.stringify({ lastReadMessageId: message.id }),
        });
        expect(readResult.status).toBe(200);
        expect((await friendChanged).find((item) => item.id === ownerSession.account.id)?.unreadCount).toBe(0);
        expect(await ownerReadQuiet).toBeNull();
        expect(await outsiderQuiet).toBeNull();

        ownerChanged = waitForSocketEvent<FriendSummary[]>(ownerSocket, 'friends:changed');
        friendChanged = waitForSocketEvent<FriendSummary[]>(friendSocket, 'friends:changed');
        outsiderQuiet = waitForNoSocketEvent<FriendSummary[]>(outsiderSocket, 'friends:changed');
        const deleteResult = await api(baseUrl, `/api/friends/${friendSession.account.id}`, {
          method: 'DELETE',
          token: ownerSession.token,
        });
        expect(deleteResult.status).toBe(204);
        expect((await ownerChanged).some((item) => item.id === friendSession.account.id)).toBe(false);
        expect((await friendChanged).some((item) => item.id === ownerSession.account.id)).toBe(false);
        expect(await outsiderQuiet).toBeNull();
      } finally {
        ownerSocket.close();
        friendSocket.close();
        outsiderSocket.close();
      }
    });
  });

  it('uses one friend removal endpoint for rejecting, cancelling, and deleting safely', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `friend-life-owner-${suffix}@example.com`,
      displayName: 'Owner',
      password: '123456',
    })!.account;
    const incoming = store.registerAccount({
      email: `friend-life-incoming-${suffix}@example.com`,
      displayName: 'Incoming',
      password: '123456',
    })!.account;
    const outgoing = store.registerAccount({
      email: `friend-life-outgoing-${suffix}@example.com`,
      displayName: 'Outgoing',
      password: '123456',
    })!.account;
    const accepted = store.registerAccount({
      email: `friend-life-accepted-${suffix}@example.com`,
      displayName: 'Accepted',
      password: '123456',
    })!.account;

    expect(store.requestFriend(incoming.id, owner.email)?.direction).toBe('outgoing');
    expect(store.removeFriend(owner.id, incoming.id)).toBe(true);
    expect(store.listFriends(owner.id).some((item) => item.id === incoming.id)).toBe(false);

    expect(store.requestFriend(owner.id, outgoing.email)?.direction).toBe('outgoing');
    expect(store.removeFriend(owner.id, outgoing.id)).toBe(true);
    expect(store.listFriends(outgoing.id).some((item) => item.id === owner.id)).toBe(false);

    expect(store.requestFriend(owner.id, accepted.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(accepted.id, owner.id)?.status).toBe('accepted');
    expect(store.addDirectMessage(owner.id, accepted.id, '删除前可以私聊')).toBeTruthy();
    expect(store.removeFriend(owner.id, accepted.id)).toBe(true);
    expect(store.listDirectMessages(owner.id, accepted.id)).toBeNull();
  });

  it('deduplicates direct messages by sender and preserves old history under high volume', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `dm-dedupe-owner-${suffix}@example.com`,
      displayName: 'Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const friend = store.registerAccount({
      email: `dm-dedupe-friend-${suffix}@example.com`,
      displayName: 'Friend',
      password: '123456',
      role: 'player',
    })!.account;
    const otherFriend = store.registerAccount({
      email: `dm-dedupe-other-${suffix}@example.com`,
      displayName: 'Other Friend',
      password: '123456',
      role: 'player',
    })!.account;

    expect(store.requestFriend(owner.id, friend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(friend.id, owner.id)?.status).toBe('accepted');
    expect(store.requestFriend(owner.id, otherFriend.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(otherFriend.id, owner.id)?.status).toBe('accepted');

    const first = store.addDirectMessage(owner.id, friend.id, '只发送一次。', 'dm-once');
    const retried = store.addDirectMessage(owner.id, friend.id, '这条重试不应该出现。', 'dm-once');
    const friendSameKey = store.addDirectMessage(friend.id, owner.id, '好友可以使用自己的同名幂等键。', 'dm-once');

    expect(retried?.id).toBe(first?.id);
    expect(retried?.text).toBe('只发送一次。');
    expect(friendSameKey?.id).not.toBe(first?.id);

    expect(store.addDirectMessage(owner.id, otherFriend.id, '另一段会话不能被高流量会话挤掉。', 'other-once')).toBeTruthy();
    for (let index = 0; index < 1001; index += 1) {
      expect(store.addDirectMessage(owner.id, friend.id, `bulk-${index}`)).toBeTruthy();
    }

    const oldReply = store.addDirectMessage(friend.id, owner.id, '回复最早的私聊。', undefined, {
      id: first!.id,
      author: owner.displayName,
      text: first!.text,
    });
    expect(oldReply?.replyTo).toMatchObject({
      id: first!.id,
      text: '只发送一次。',
    });

    const otherConversation = store.listDirectMessages(owner.id, otherFriend.id);
    expect(otherConversation?.map((message) => message.text)).toContain('另一段会话不能被高流量会话挤掉。');
  }, 15_000);

  it('creates blank rooms without carrying seed scene or characters', () => {
    const owner = store.registerAccount({
      email: `blank-room-${Date.now()}@example.com`,
      displayName: 'Blank KP',
      password: '123456',
      role: 'keeper',
    })!.account;

    const room = store.createRoom({
      owner,
      name: '空白团',
      system: 'COC 7th',
    });

    expect(room.summary).toBe('');
    expect(room.scene).toMatchObject({
      name: '空白地图',
      width: 12,
      height: 8,
      features: [],
      tokens: [],
    });
    expect(room.characters).toEqual([]);
    expect(room.messages).toEqual([]);
    expect(JSON.stringify(room)).not.toContain('灰烬旅店');
    expect(JSON.stringify(room)).not.toContain('林岚');
    expect(JSON.stringify(room)).not.toContain('乔远');
    expect(JSON.stringify(room)).not.toContain('墙中影');
  });

  it('paginates room messages and keeps old reply targets outside the exposed room state', () => {
    const owner = store.registerAccount({
      email: `room-page-${Date.now()}@example.com`,
      displayName: 'Room Page KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const room = store.createRoom({
      owner,
      name: '分页团',
      system: 'COC 7th',
    });

    const created = Array.from({ length: 65 }, (_, index) =>
      store.addMessage(room.id, {
        author: 'KP',
        role: 'keeper',
        text: `room-message-${String(index + 1).padStart(2, '0')}`,
      }),
    );

    const latest = store.listRoomMessagePage(room.id, owner, { limit: 20 });
    expect(latest?.messages).toHaveLength(20);
    expect(latest?.messages[0].text).toBe('room-message-46');
    expect(latest?.messages.at(-1)?.text).toBe('room-message-65');
    expect(latest?.hasMore).toBe(true);

    const older = store.listRoomMessagePage(room.id, owner, {
      limit: 20,
      before: latest!.messages[0].id,
    });
    expect(older?.messages[0].text).toBe('room-message-26');
    expect(older?.messages.at(-1)?.text).toBe('room-message-45');
    expect(older?.hasMore).toBe(true);

    const exposedRoom = store.getRoom(room.id, owner);
    expect(exposedRoom?.messages).toHaveLength(50);
    expect(exposedRoom?.messages[0].text).toBe('room-message-16');
    expect(exposedRoom?.messages.some((message) => message.id === created[0]?.id)).toBe(false);

    expect(store.getRoomMessageReference(room.id, created[0]!.id)).toMatchObject({
      ok: true,
      replyTo: {
        author: 'KP',
        text: 'room-message-01',
      },
    });
  });

  it('derives room roles from room ownership and refreshes member profile on rejoin', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `member-owner-${suffix}@example.com`,
      displayName: 'KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const guest = store.registerAccount({
      email: `member-guest-${suffix}@example.com`,
      displayName: '璋冩煡鍛?A',
      password: '123456',
    })!.account;

    const room = store.createRoom({
      owner,
      name: '鎴愬憳娴嬭瘯',
      system: 'COC 7th',
    });

    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    const joined = store.joinRoom(room.id, guest);
    expect(joined.ok).toBe(true);
    expect(joined.ok ? joined.room.members.find((member) => member.accountId === guest.id)?.role : null).toBe('player');

    const updatedAccount = store.updateProfile(guest.id, {
      displayName: '鏂拌皟鏌ュ憳',
      avatar: 'NA',
    })!;
    const roomAfterProfile = store.getRoom(room.id, owner);
    expect(roomAfterProfile?.roster.find((member) => member.accountId === guest.id)).toMatchObject({
      accountId: guest.id,
      displayName: '鏂拌皟鏌ュ憳',
      avatar: 'NA',
    });
    expect(store.listAccountRoomIds(guest.id)).toContain(room.id);
    const rejoined = store.joinRoom(room.id, updatedAccount, 'keeper');
    const nextMember = rejoined.ok ? rejoined.room.members.find((member) => member.accountId === guest.id) : null;

    expect(rejoined.ok).toBe(true);
    expect(nextMember).toMatchObject({
      accountId: guest.id,
      displayName: '鏂拌皟鏌ュ憳',
      avatar: 'NA',
      role: 'player',
    });
    expect(typeof nextMember?.lastSeenAt).toBe('string');

    const switchedBack = store.joinRoom(room.id, updatedAccount, 'player');
    expect(switchedBack.ok ? switchedBack.room.members.find((member) => member.accountId === guest.id)?.role : null).toBe('player');

    const ownerRejoined = store.joinRoom(room.id, owner, 'keeper');
    expect(ownerRejoined.ok ? ownerRejoined.room.members.find((member) => member.accountId === owner.id)?.role : null).toBe('keeper');
  });

  it('broadcasts room state when a room participant updates profile over REST', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `profile-room-owner-${suffix}@example.com`,
        displayName: 'Profile Room Owner',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `profile-room-player-${suffix}@example.com`,
        displayName: 'Profile Room Player',
        password: '123456',
        role: 'player',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Profile broadcast room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);

      const playerSocket = await connectSocket(baseUrl, playerSession.token);
      const ownerSocket = await connectSocket(baseUrl, ownerSession.token);

      try {
        expect((await emitAck<{ ok: boolean }>(ownerSocket, 'room:join', {
          roomId: room.id,
          role: 'keeper',
          token: ownerSession.token,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(playerSocket, 'room:join', {
          roomId: room.id,
          role: 'player',
          token: playerSession.token,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(playerSocket, 'voice:join', {
          roomId: room.id,
          token: playerSession.token,
          muted: false,
        })).ok).toBe(true);

        const ownerRoomStateEvent = waitForSocketEvent<RoomState>(playerSocket, 'room:state');
        const ownerRoomsChanged = waitForSocketEvent<void>(playerSocket, 'rooms:changed');
        const ownerResponse = await api(baseUrl, '/api/profile', {
          method: 'PATCH',
          token: ownerSession.token,
          body: JSON.stringify({ displayName: 'Renamed Keeper', avatar: 'RK' }),
        });
        expect(ownerResponse.status).toBe(200);
        const ownerUpdatedRoom = await ownerRoomStateEvent;
        expect(ownerUpdatedRoom).toMatchObject({
          id: room.id,
          ownerName: 'Renamed Keeper',
          keeper: 'Renamed Keeper',
        });
        expect(ownerUpdatedRoom.roster.find((member) => member.accountId === ownerSession.account.id)).toMatchObject({
          displayName: 'Renamed Keeper',
          avatar: 'RK',
        });
        await expect(ownerRoomsChanged).resolves.toBeUndefined();

        const playerRoomStateEvent = waitForSocketEvent<RoomState>(ownerSocket, 'room:state');
        const playerRoomsChanged = waitForSocketEvent<void>(ownerSocket, 'rooms:changed');
        const playerResponse = await api(baseUrl, '/api/profile', {
          method: 'PATCH',
          token: playerSession.token,
          body: JSON.stringify({ displayName: 'Renamed Player', avatar: 'RP' }),
        });
        expect(playerResponse.status).toBe(200);
        const playerUpdatedRoom = await playerRoomStateEvent;
        expect(playerUpdatedRoom.roster.find((member) => member.accountId === playerSession.account.id)).toMatchObject({
          displayName: 'Renamed Player',
          avatar: 'RP',
        });
        expect(playerUpdatedRoom.members.find((member) => member.accountId === playerSession.account.id)).toMatchObject({
          displayName: 'Renamed Player',
          avatar: 'RP',
        });
        const playerVoiceStateEvent = waitForSocketEvent<{ participants: Array<{ id: string; name: string }> }>(
          ownerSocket,
          'voice:state',
        );
        const playerVoiceResponse = await api(baseUrl, '/api/profile', {
          method: 'PATCH',
          token: playerSession.token,
          body: JSON.stringify({ displayName: 'Renamed Voice Player' }),
        });
        expect(playerVoiceResponse.status).toBe(200);
        await expect(playerVoiceStateEvent).resolves.toMatchObject({
          participants: [expect.objectContaining({ id: playerSession.account.id, name: 'Renamed Voice Player' })],
        });
        await expect(playerRoomsChanged).resolves.toBeUndefined();
      } finally {
        playerSocket.close();
        ownerSocket.close();
      }
    });
  });

  it('does not expose messages sent after a formal leave in closed room history', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `closed-history-owner-${suffix}@example.com`,
        displayName: 'Closed History KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `closed-history-player-${suffix}@example.com`,
        displayName: 'Closed History Player',
        password: '123456',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Closed history visibility room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);

      const beforeLeave = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({ text: 'visible before formal leave' }),
      });
      expect(beforeLeave.status).toBe(201);
      const left = await api(baseUrl, `/api/rooms/${room.id}/leave`, {
        method: 'POST',
        token: playerSession.token,
      });
      expect(left.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const afterLeave = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({ text: 'hidden after formal leave' }),
      });
      expect(afterLeave.status).toBe(201);
      const closed = await api(baseUrl, `/api/rooms/${room.id}/close`, {
        method: 'POST',
        token: ownerSession.token,
      });
      expect(closed.status).toBe(200);

      const page = await api(baseUrl, `/api/rooms/${room.id}/messages?limit=20`, {
        token: playerSession.token,
      });
      expect(page.status).toBe(200);
      const messages = (page.body as { messages: ChatMessage[] }).messages;
      expect(messages.map((message) => message.text)).toContain('visible before formal leave');
      expect(messages.map((message) => message.text)).not.toContain('hidden after formal leave');

      const detail = await api(baseUrl, `/api/rooms/${room.id}`, {
        token: playerSession.token,
      });
      expect(detail.status).toBe(200);
      const detailMessages = (detail.body as RoomState).messages.map((message) => message.text);
      expect(detailMessages).toContain('visible before formal leave');
      expect(detailMessages).not.toContain('hidden after formal leave');

      const viewerState = store.getRoomViewerStates(room.id).find((item) => item.accountId === playerSession.account.id);
      expect(viewerState?.room.messages.map((message) => message.text)).toContain('visible before formal leave');
      expect(viewerState?.room.messages.map((message) => message.text)).not.toContain('hidden after formal leave');
    });
  });

  it('rebroadcasts existing room chat and dice messages during idempotent REST retries', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `idempotent-rebroadcast-owner-${suffix}@example.com`,
        displayName: 'Idempotent Rebroadcast KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `idempotent-rebroadcast-player-${suffix}@example.com`,
        displayName: 'Idempotent Rebroadcast Player',
        password: '123456',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Idempotent rebroadcast room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);

      const ownerSocket = await connectSocket(baseUrl, ownerSession.token);
      try {
        expect((await emitAck<{ ok: boolean }>(ownerSocket, 'room:join', {
          roomId: room.id,
          role: 'keeper',
          token: ownerSession.token,
        })).ok).toBe(true);

        const firstChatBroadcast = waitForSocketEvent<ChatMessage>(ownerSocket, 'chat:message');
        const firstChat = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
          method: 'POST',
          token: playerSession.token,
          body: JSON.stringify({ text: 'idempotent chat original', clientMessageId: 'rest-chat-rebroadcast' }),
        });
        expect(firstChat.status).toBe(201);
        const firstChatMessage = await firstChatBroadcast;
        expect(firstChatMessage).toMatchObject({ text: 'idempotent chat original' });

        const retriedChatBroadcast = waitForSocketEvent<ChatMessage>(ownerSocket, 'chat:message');
        const retriedChat = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
          method: 'POST',
          token: playerSession.token,
          body: JSON.stringify({ text: 'idempotent chat retry ignored', clientMessageId: 'rest-chat-rebroadcast' }),
        });
        expect(retriedChat.status).toBe(201);
        await expect(retriedChatBroadcast).resolves.toMatchObject({
          id: firstChatMessage.id,
          text: 'idempotent chat original',
        });

        const firstDiceBroadcast = waitForSocketEvent<ChatMessage>(ownerSocket, 'chat:message');
        const firstDice = await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
          method: 'POST',
          token: playerSession.token,
          body: JSON.stringify({ formula: '1d100<=100', clientMessageId: 'rest-dice-rebroadcast' }),
        });
        expect(firstDice.status).toBe(201);
        const firstDiceMessage = await firstDiceBroadcast;
        expect(firstDiceMessage).toMatchObject({ messageType: 'dice' });

        const retriedDiceBroadcast = waitForSocketEvent<ChatMessage>(ownerSocket, 'chat:message');
        const retriedDice = await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
          method: 'POST',
          token: playerSession.token,
          body: JSON.stringify({ formula: '1d100<=1', clientMessageId: 'rest-dice-rebroadcast' }),
        });
        expect(retriedDice.status).toBe(201);
        await expect(retriedDiceBroadcast).resolves.toMatchObject({
          id: firstDiceMessage.id,
          messageType: 'dice',
        });
      } finally {
        ownerSocket.close();
      }
    });
  });

  it('keeps empty rooms online for five minutes before closing them', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T00:00:00.000Z'));

    const owner = store.registerAccount({
      email: `leave-${Date.now()}@example.com`,
      displayName: '鎴夸富',
      password: '123456',
      role: 'keeper',
    })!.account;
    const room = store.createRoom({
      owner,
      name: '绌烘埧闂存祴璇?',
      system: 'COC 7th',
    });

    const left = store.leaveRoom(room.id, owner.id);
    expect(left.ok).toBe(true);
    expect(left.ok ? left.room.members : []).toHaveLength(0);
    expect(left.ok ? left.room.online : false).toBe(true);
    expect(left.ok ? left.room.closeAt : null).toBe('2026-05-19T00:05:00.000Z');
    expect(store.listRooms(owner).some((item) => item.id === room.id)).toBe(false);
    expect(store.listRooms(owner, { status: 'closed' }).some((item) => item.id === room.id)).toBe(false);

    vi.advanceTimersByTime(299_999);
    store.sweepExpiredRooms();
    expect(store.getRoom(room.id, owner)?.online).toBe(true);
    expect(store.listRooms(owner).some((item) => item.id === room.id)).toBe(false);

    vi.advanceTimersByTime(2);
    store.sweepExpiredRooms();
    expect(store.getRoom(room.id, owner)?.online).toBe(false);
    expect(store.getRoom(room.id, owner)?.closedAt).toBe('2026-05-19T00:05:00.001Z');

    const savedRoom = store.getRoom(room.id, owner);
    expect(savedRoom).not.toBeNull();
    expect(savedRoom?.messages).toEqual([]);
    expect(savedRoom?.participants.some((member) => member.accountId === owner.id)).toBe(true);

    expect(store.listRooms(owner).some((item) => item.id === room.id)).toBe(false);

    const visibleRooms = store.listRooms(owner, { status: 'closed' });
    expect(visibleRooms.find((item) => item.id === room.id)).toMatchObject({
      online: false,
      canJoin: true,
    });

    expect(store.deleteRoom(room.id, owner.id).ok).toBe(true);
    expect(store.getRoom(room.id, owner)).toBeNull();
  });

  it('lets the owner close an online room immediately without deleting its history', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `owner-close-${suffix}@example.com`,
      displayName: 'Owner Close',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `player-close-${suffix}@example.com`,
      displayName: 'Player Close',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Owner close room',
      system: 'COC 7th',
    });
    expect(store.updateRoomPhase(room.id, owner, 'module_editing').ok).toBe(true);
    expect(store.updateRoomPreparation(room.id, owner, {
      summary: '公开导入剧情',
      scriptCharacters: [{
        id: 'owner-close-character',
        name: '调查员',
        count: 1,
        publicSummary: '公开人设',
      }],
    }).ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'recruiting').ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);

    expect(store.closeRoom(room.id, player.id)).toMatchObject({
      ok: false,
      error: 'Only the room owner can close the room',
    });

    const closed = store.closeRoom(room.id, owner.id);
    expect(closed).toMatchObject({
      ok: true,
      room: {
        id: room.id,
        online: false,
        phase: 'closed',
        members: [],
      },
    });
    expect(closed.ok ? closed.room.closedAt : null).toBeTruthy();
    expect(store.listRooms(owner).some((item) => item.id === room.id)).toBe(false);
    expect(store.listRooms(owner, { status: 'closed' }).find((item) => item.id === room.id)).toMatchObject({
      canJoin: true,
      online: false,
    });
    expect(store.listRooms(player, { status: 'closed' }).find((item) => item.id === room.id)).toMatchObject({
      canJoin: true,
      online: false,
    });
  });

  it('closes an online room through the owner REST endpoint', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `rest-owner-close-${suffix}@example.com`,
        displayName: 'Rest Owner Close',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `rest-player-close-${suffix}@example.com`,
        displayName: 'Rest Player Close',
        password: '123456',
        role: 'player',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'REST owner close room',
        system: 'COC 7th',
      });

      const forbidden = await api(baseUrl, `/api/rooms/${room.id}/close`, {
        method: 'POST',
        token: playerSession.token,
      });
      expect(forbidden.status).toBe(403);

      const closed = await api(baseUrl, `/api/rooms/${room.id}/close`, {
        method: 'POST',
        token: ownerSession.token,
      });
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({
        id: room.id,
        online: false,
        phase: 'closed',
        members: [],
      });

      const repeated = await api(baseUrl, `/api/rooms/${room.id}/close`, {
        method: 'POST',
        token: ownerSession.token,
      });
      expect(repeated.status).toBe(409);
      expect(store.listRooms(ownerSession.account, { status: 'closed' }).some((item) => item.id === room.id)).toBe(true);
    });
  });

  it('broadcasts room, voice, and lobby updates when the owner closes a room over REST', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `rest-close-broadcast-owner-${suffix}@example.com`,
        displayName: 'REST Close Broadcast Owner',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `rest-close-broadcast-player-${suffix}@example.com`,
        displayName: 'REST Close Broadcast Player',
        password: '123456',
        role: 'player',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'REST close broadcast room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);

      const playerSocket = await connectSocket(baseUrl, playerSession.token);
      try {
        expect((await emitAck<{ ok: boolean }>(playerSocket, 'room:join', {
          roomId: room.id,
          role: 'player',
          token: playerSession.token,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(playerSocket, 'voice:join', {
          roomId: room.id,
          token: playerSession.token,
          muted: false,
        })).ok).toBe(true);

        const roomClosed = waitForSocketEvent<{ id: string; online: boolean; closedAt: string }>(playerSocket, 'room:closed');
        const roomState = waitForSocketEvent<RoomState>(playerSocket, 'room:state');
        const voiceState = waitForSocketEvent<{ roomId: string; participants: Array<{ id: string }> }>(playerSocket, 'voice:state');
        const roomsChanged = waitForSocketEvent<void>(playerSocket, 'rooms:changed');
        const closed = await api(baseUrl, `/api/rooms/${room.id}/close`, {
          method: 'POST',
          token: ownerSession.token,
        });
        expect(closed.status).toBe(200);
        expect(await roomClosed).toMatchObject({
          id: room.id,
          online: false,
        });
        expect(await roomState).toMatchObject({
          id: room.id,
          online: false,
          phase: 'closed',
          members: [],
        });
        expect(await voiceState).toMatchObject({
          roomId: room.id,
          participants: [],
        });
        await expect(roomsChanged).resolves.toBeUndefined();
      } finally {
        playerSocket.close();
      }
    });
  }, 15_000);

  it('queues closed-room events when ordinary reads trigger room expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T01:00:00.000Z'));

    const owner = store.registerAccount({
      email: `read-sweep-${Date.now()}@example.com`,
      displayName: 'Read Sweep Keeper',
      password: '123456',
      role: 'keeper',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Read sweep room',
      system: 'COC 7th',
    });

    const left = store.leaveRoom(room.id, owner.id);
    expect(left.ok).toBe(true);
    expect(left.ok ? left.room.closeAt : null).toBe('2026-05-19T01:05:00.000Z');
    const previousLiveKitRoomName = store.getRoomLiveKitVoiceRoomName(room.id);

    vi.advanceTimersByTime(300_001);
    expect(store.getRoom(room.id, owner)?.online).toBe(false);

    const closedEvents = store.sweepExpiredRooms();
    expect(closedEvents.map((item) => item.id)).toContain(room.id);
    expect(closedEvents.find((item) => item.id === room.id)).toMatchObject({
      closedAt: '2026-05-19T01:05:00.001Z',
      liveKitRoomName: previousLiveKitRoomName,
      online: false,
    });
    expect(store.getRoomLiveKitVoiceRoomName(room.id)).not.toBe(previousLiveKitRoomName);
    const closedEvent = closedEvents.find((item) => item.id === room.id);
    expect(closedEvent).not.toHaveProperty('scene');
    expect(closedEvent).not.toHaveProperty('characters');
    expect(closedEvent).not.toHaveProperty('messages');
    expect(store.sweepExpiredRooms().some((item) => item.id === room.id)).toBe(false);
  });

  it('broadcasts room closure when a room list request triggers expiry', async () => {
    await withServer(async (baseUrl) => {
      const ownerSession = store.registerAccount({
        email: `read-broadcast-${Date.now()}@example.com`,
        displayName: 'Read Broadcast Keeper',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Read broadcast room',
        system: 'COC 7th',
      });

      const socket = await connectSocket(baseUrl, ownerSession.token);
      try {
        expect((await emitAck<{ ok: boolean }>(socket, 'room:join', {
          roomId: room.id,
          token: ownerSession.token,
          role: 'keeper',
        })).ok).toBe(true);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-05-19T02:00:00.000Z'));
        const left = store.leaveRoom(room.id, ownerSession.account.id);
        expect(left.ok).toBe(true);
        vi.setSystemTime(new Date('2026-05-19T02:05:00.001Z'));

        const closedEvent = waitForSocketEvent<{ id: string; online: boolean; closedAt: string }>(socket, 'room:closed');
        const roomsChanged = waitForSocketEvent<void>(socket, 'rooms:changed');
        const listed = await api(baseUrl, '/api/rooms', { token: ownerSession.token });
        expect(listed.status).toBe(200);
        const closedPayload = await closedEvent;
        expect(closedPayload).toMatchObject({
          id: room.id,
          online: false,
          closedAt: '2026-05-19T02:05:00.001Z',
        });
        expect(closedPayload).not.toHaveProperty('scene');
        expect(closedPayload).not.toHaveProperty('characters');
        expect(closedPayload).not.toHaveProperty('messages');
        await expect(roomsChanged).resolves.toBeUndefined();
      } finally {
        socket.close();
      }
    });
  });

  it('broadcasts room closure when a room write request triggers expiry', async () => {
    await withServer(async (baseUrl) => {
      const ownerSession = store.registerAccount({
        email: `write-broadcast-${Date.now()}@example.com`,
        displayName: 'Write Broadcast Keeper',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `write-broadcast-player-${Date.now()}@example.com`,
        displayName: 'Write Broadcast Player',
        password: '123456',
      })!;
      const expiringRoom = store.createRoom({
        owner: ownerSession.account,
        name: 'Write broadcast expiring room',
        system: 'COC 7th',
      });
      const triggerRoom = store.createRoom({
        owner: ownerSession.account,
        name: 'Write broadcast trigger room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(triggerRoom.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(triggerRoom.id, playerSession.account, 'player').ok).toBe(true);
      expect(store.updateRoomPhase(triggerRoom.id, ownerSession.account, 'chargen').ok).toBe(true);

      const socket = await connectSocket(baseUrl, ownerSession.token);
      try {
        expect((await emitAck<{ ok: boolean }>(socket, 'room:join', {
          roomId: expiringRoom.id,
          token: ownerSession.token,
          role: 'keeper',
        })).ok).toBe(true);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-05-19T02:30:00.000Z'));
        const left = store.leaveRoom(expiringRoom.id, ownerSession.account.id);
        expect(left.ok).toBe(true);
        vi.setSystemTime(new Date('2026-05-19T02:35:00.001Z'));

        const closedEvent = waitForSocketEvent<{ id: string; online: boolean; closedAt: string }>(socket, 'room:closed');
        const roomsChanged = waitForSocketEvent<void>(socket, 'rooms:changed');
        const changed = await api(baseUrl, `/api/rooms/${triggerRoom.id}/character-sheets/me/submit`, {
          method: 'POST',
          token: playerSession.token,
          body: JSON.stringify(validSheetInput('Write Broadcast Sheet')),
        });
        expect(changed.status).toBe(201);
        const closedPayload = await closedEvent;
        expect(closedPayload).toMatchObject({
          id: expiringRoom.id,
          online: false,
          closedAt: '2026-05-19T02:35:00.001Z',
        });
        expect(closedPayload).not.toHaveProperty('scene');
        expect(closedPayload).not.toHaveProperty('characters');
        expect(closedPayload).not.toHaveProperty('messages');
        await expect(roomsChanged).resolves.toBeUndefined();
      } finally {
        socket.close();
      }
    });
  });

  it('drains expired room closures after create-room requests trigger a sweep', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `create-drain-${suffix}@example.com`,
        displayName: 'Create Drain KP',
        password: '123456',
        role: 'keeper',
      })!;
      const expiringRoom = store.createRoom({
        owner: ownerSession.account,
        name: 'Create drain expiring room',
        system: 'COC 7th',
      });

      const socket = await connectSocket(baseUrl, ownerSession.token);
      try {
        expect((await emitAck<{ ok: boolean }>(socket, 'room:join', {
          roomId: expiringRoom.id,
          token: ownerSession.token,
          role: 'keeper',
        })).ok).toBe(true);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-05-19T02:45:00.000Z'));
        expect(store.leaveRoom(expiringRoom.id, ownerSession.account.id).ok).toBe(true);
        vi.setSystemTime(new Date('2026-05-19T02:50:00.001Z'));

        const closedEvent = waitForSocketEvent<{ id: string; online: boolean; closedAt: string }>(socket, 'room:closed');
        const created = await api(baseUrl, '/api/rooms', {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ name: 'Create drain trigger room', system: 'COC 7th' }),
        });
        expect(created.status).toBe(201);
        const closedPayload = await closedEvent;
        expect(closedPayload).toMatchObject({
          id: expiringRoom.id,
          online: false,
          closedAt: '2026-05-19T02:50:00.001Z',
        });
        expect(closedPayload).not.toHaveProperty('scene');
        expect(closedPayload).not.toHaveProperty('characters');
        expect(closedPayload).not.toHaveProperty('messages');
      } finally {
        socket.close();
      }
    });
  });

  it('drains expired room closures after LiveKit token requests trigger a sweep', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `livekit-drain-${suffix}@example.com`,
        displayName: 'LiveKit Drain KP',
        password: '123456',
        role: 'keeper',
      })!;
      const expiringRoom = store.createRoom({
        owner: ownerSession.account,
        name: 'LiveKit drain expiring room',
        system: 'COC 7th',
      });
      const triggerRoom = store.createRoom({
        owner: ownerSession.account,
        name: 'LiveKit drain trigger room',
        system: 'COC 7th',
      });

      const socket = await connectSocket(baseUrl, ownerSession.token);
      try {
        expect((await emitAck<{ ok: boolean }>(socket, 'room:join', {
          roomId: expiringRoom.id,
          token: ownerSession.token,
          role: 'keeper',
        })).ok).toBe(true);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-05-19T02:55:00.000Z'));
        expect(store.leaveRoom(expiringRoom.id, ownerSession.account.id).ok).toBe(true);
        vi.setSystemTime(new Date('2026-05-19T03:00:00.001Z'));
        expect(store.joinRoom(triggerRoom.id, ownerSession.account, 'keeper').ok).toBe(true);

        const closedEvent = waitForSocketEvent<{ id: string; online: boolean; closedAt: string }>(socket, 'room:closed');
        const tokenResponse = await api(baseUrl, '/api/livekit/token', {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ roomId: triggerRoom.id, voiceSessionId: 'livekitdrain01' }),
        });
        expect(tokenResponse.status).toBe(200);
        const closedPayload = await closedEvent;
        expect(closedPayload).toMatchObject({
          id: expiringRoom.id,
          online: false,
          closedAt: '2026-05-19T03:00:00.001Z',
        });
        expect(closedPayload).not.toHaveProperty('scene');
        expect(closedPayload).not.toHaveProperty('characters');
        expect(closedPayload).not.toHaveProperty('messages');
      } finally {
        socket.close();
      }
    });
  });

  it('does not reopen a closed room from socket resume join', async () => {
    await withServer(async (baseUrl) => {
      const ownerSession = store.registerAccount({
        email: `resume-closed-${Date.now()}@example.com`,
        displayName: 'Resume Closed KP',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Resume closed room',
        system: 'COC 7th',
      });

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-05-19T03:00:00.000Z'));
      expect(store.leaveRoom(room.id, ownerSession.account.id).ok).toBe(true);
      vi.setSystemTime(new Date('2026-05-19T03:05:00.001Z'));
      store.sweepExpiredRooms();
      expect(store.getRoom(room.id, ownerSession.account)?.online).toBe(false);

      const socket = await connectSocket(baseUrl, ownerSession.token);
      try {
        const resumed = await emitAck<{ ok: false; error: unknown }>(socket, 'room:join', {
          roomId: room.id,
          resume: true,
          role: 'keeper',
          token: ownerSession.token,
        });
        expect(resumed).toMatchObject({ ok: false });
        expect(store.getRoom(room.id, ownerSession.account)?.online).toBe(false);
      } finally {
        socket.close();
      }
    });
  });

  it('restores an online room member from socket resume without reopening closed rooms', async () => {
    await withServer(async (baseUrl) => {
      const ownerSession = store.registerAccount({
        email: `resume-online-${Date.now()}@example.com`,
        displayName: 'Resume Online KP',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Resume online room',
        system: 'COC 7th',
      });

      const disconnected = store.disconnectRoomMember(room.id, ownerSession.account.id);
      expect(disconnected.ok).toBe(true);
      expect(store.getRoom(room.id, ownerSession.account)?.online).toBe(true);
      expect(store.getRoom(room.id, ownerSession.account)?.memberIds).toEqual([]);

      const socket = await connectSocket(baseUrl, ownerSession.token);
      try {
        const resumed = await emitAck<{ ok: true; room: { memberIds: string[]; closeAt: string | null; online: boolean } }>(
          socket,
          'room:join',
          {
            roomId: room.id,
            resume: true,
            role: 'keeper',
            token: ownerSession.token,
          },
        );
        expect(resumed.ok).toBe(true);
        expect(resumed.room.online).toBe(true);
        expect(resumed.room.memberIds).toContain(ownerSession.account.id);
        expect(resumed.room.closeAt).toBeNull();
      } finally {
        socket.close();
      }
    });
  });

  it('does not push online room viewer state to players who already left', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `viewer-owner-${suffix}@example.com`,
      displayName: 'Viewer Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `viewer-player-${suffix}@example.com`,
      displayName: 'Viewer Player',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Viewer Room',
      system: 'COC 7th',
    });

    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
    expect(store.getRoomViewerStates(room.id).map((viewer) => viewer.accountId)).toContain(player.id);
    expect(store.leaveRoom(room.id, player.id).ok).toBe(true);

    const savedRoom = store.getRoom(room.id, owner);
    expect(savedRoom?.online).toBe(true);
    expect(savedRoom?.participants.some((member) => member.accountId === player.id)).toBe(true);
    expect(store.getRoomViewerStates(room.id).map((viewer) => viewer.accountId)).not.toContain(player.id);
  });

  it('keeps closed rooms in personal history and lets prior participants reopen or hide them', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T01:00:00.000Z'));

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `history-owner-${suffix}@example.com`,
      displayName: 'History Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `history-player-${suffix}@example.com`,
      displayName: 'History Player',
      password: '123456',
      role: 'player',
    })!.account;

    const room = store.createRoom({
      owner,
      name: 'History Room',
      system: 'COC 7th',
    });
    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
    expect(store.leaveRoom(room.id, player.id).ok).toBe(true);
    expect(store.leaveRoom(room.id, owner.id).ok).toBe(true);

    vi.advanceTimersByTime(300_001);
    const closedEvents = store.sweepExpiredRooms();

    expect(store.listRooms(owner).some((item) => item.id === room.id)).toBe(false);
    expect(closedEvents).toEqual([
      expect.objectContaining({
        id: room.id,
        roomId: room.id,
        online: false,
        closedAt: expect.any(String),
        liveKitRoomName: expect.any(String),
      }),
    ]);
    expect('scene' in (closedEvents[0] as object)).toBe(false);
    expect('characters' in (closedEvents[0] as object)).toBe(false);
    expect('messages' in (closedEvents[0] as object)).toBe(false);
    expect(store.listRooms(player, { status: 'closed' }).find((item) => item.id === room.id)).toMatchObject({
      canJoin: true,
      online: false,
    });
    const exposedRoom = store.getRoom(room.id, player);
    expect(exposedRoom).not.toBeNull();
    expect('hiddenForAccountIds' in (exposedRoom as object)).toBe(false);

    const reopened = store.joinRoom(room.id, player, 'keeper');
    expect(reopened.ok).toBe(true);
    expect(reopened.ok ? reopened.room.online : false).toBe(true);
    expect(reopened.ok ? reopened.room.closedAt : 'still-closed').toBeNull();
    expect(reopened.ok ? reopened.room.members.find((member) => member.accountId === player.id)?.role : null).toBe(
      'player',
    );
    expect(store.updateRoomPhase(room.id, player, 'chargen')).toMatchObject({
      ok: false,
      error: '只有 KP 可以推进跑团流程。',
    });
    const ownerReturned = store.joinRoom(room.id, owner, 'keeper');
    expect(ownerReturned.ok).toBe(true);
    expect(ownerReturned.ok ? ownerReturned.room.members.find((member) => member.accountId === owner.id)?.role : null).toBe(
      'keeper',
    );
    expect(store.updateRoomPhase(room.id, owner, 'chargen')).toMatchObject({ ok: true });

    expect(store.leaveRoom(room.id, player.id).ok).toBe(true);
    expect(store.leaveRoom(room.id, owner.id).ok).toBe(true);
    vi.advanceTimersByTime(300_001);
    store.sweepExpiredRooms();

    const hidden = store.deleteRoom(room.id, player.id);
    expect(hidden).toMatchObject({ ok: true, deleted: false });
    expect(store.listRooms(player, { status: 'closed' }).some((item) => item.id === room.id)).toBe(false);
    expect(store.getRoom(room.id, player)).toBeNull();
    expect(store.listRooms(owner, { status: 'closed' }).some((item) => item.id === room.id)).toBe(true);

    expect(store.deleteRoom(room.id, owner.id)).toMatchObject({ ok: true, deleted: true });
    expect(store.getRoom(room.id, owner)).toBeNull();
  });

  it('restores the previous flow phase when a closed history room is reopened', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T02:00:00.000Z'));

    const phases = ['module_locked', 'recruiting', 'chargen', 'review'] as const;
    phases.forEach((phase, index) => {
      const owner = store.registerAccount({
        email: `restore-${phase}-${Date.now()}-${index}@example.com`,
        displayName: `Restore ${phase}`,
        password: '123456',
        role: 'keeper',
      })!.account;
      const room = store.createRoom({
        owner,
        name: `Restore ${phase}`,
        system: 'COC 7th',
      });
      let player: Account | null = null;
      if (phase !== 'module_locked') {
        expect(enterRecruiting(room.id, owner).ok).toBe(true);
      }
      if (phase === 'chargen' || phase === 'review') {
        player = store.registerAccount({
          email: `restore-${phase}-player-${Date.now()}-${index}@example.com`,
          displayName: `Restore ${phase} Player`,
          password: '123456',
        })!.account;
        expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
        expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
      }
      if (phase === 'review') {
        const draft = store.upsertCharacterSheet(room.id, player!, validSheetInput(`Restore ${phase} Sheet`));
        expect(draft.ok).toBe(true);
        const submitted = store.submitCharacterSheet(room.id, player!, draft.sheet);
        expect(submitted.ok).toBe(true);
        expect(store.updateRoomPhase(room.id, owner, 'review').ok).toBe(true);
      }

      if (player) {
        expect(store.leaveRoom(room.id, player.id).ok).toBe(true);
      }
      expect(store.leaveRoom(room.id, owner.id).ok).toBe(true);
      vi.advanceTimersByTime(300_001);
      store.sweepExpiredRooms();
      expect(store.getRoom(room.id, owner)?.phase).toBe('closed');

      const reopened = store.joinRoom(room.id, owner, 'keeper');
      expect(reopened.ok).toBe(true);
      expect(reopened.ok ? reopened.room.phase : null).toBe(phase);
      expect(reopened.ok ? reopened.room.closedAt : 'still-closed').toBeNull();
    });
  });

  it('keeps disconnected last-member rooms for five minutes and then closes the online instance', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T00:00:00.000Z'));

    const owner = store.registerAccount({
      email: `disconnect-${Date.now()}@example.com`,
      displayName: '房主',
      password: '123456',
      role: 'keeper',
    })!.account;
    const room = store.createRoom({
      owner,
      name: '断线房间测试',
      system: 'COC 7th',
    });

    const disconnected = store.disconnectRoomMember(room.id, owner.id);
    expect(disconnected.ok).toBe(true);
    expect(disconnected.ok ? disconnected.room.online : false).toBe(true);
    expect(disconnected.ok ? disconnected.room.closeAt : null).toBe('2026-05-19T00:05:00.000Z');

    vi.advanceTimersByTime(299_999);
    store.sweepExpiredRooms();
    expect(store.getRoom(room.id, owner)?.online).toBe(true);

    vi.advanceTimersByTime(2);
    store.sweepExpiredRooms();
    const closedRoom = store.getRoom(room.id, owner);
    expect(closedRoom).not.toBeNull();
    expect(closedRoom?.online).toBe(false);
    expect(closedRoom?.members).toHaveLength(0);
    expect(closedRoom?.participants.some((member) => member.accountId === owner.id)).toBe(true);
  });

  it('does not let players who formally left keep blocking the preparation roster', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `roster-owner-${suffix}@example.com`,
      displayName: 'Roster Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const leavingPlayer = store.registerAccount({
      email: `roster-left-${suffix}@example.com`,
      displayName: 'Left Player',
      password: '123456',
      role: 'player',
    })!.account;
    const activePlayer = store.registerAccount({
      email: `roster-active-${suffix}@example.com`,
      displayName: 'Active Player',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Roster flow room',
      system: 'COC 7th',
    });

    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, leavingPlayer, 'player').ok).toBe(true);
    expect(store.joinRoom(room.id, activePlayer, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);

    const left = store.leaveRoom(room.id, leavingPlayer.id);
    expect(left.ok).toBe(true);
    expect(left.ok ? left.room.roster.some((member) => member.accountId === leavingPlayer.id) : true).toBe(false);
    expect(left.ok ? left.room.participants.some((member) => member.accountId === leavingPlayer.id) : false).toBe(true);

    const draft = store.upsertCharacterSheet(room.id, activePlayer, validSheetInput('Roster Active Sheet'));
    expect(draft.ok).toBe(true);
    const submitted = store.submitCharacterSheet(room.id, activePlayer, draft.sheet);
    expect(submitted.ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'review')).toMatchObject({ ok: true });

    const reviewed = store.reviewCharacterSheet(room.id, owner, submitted.sheet.id, { status: 'approved' });
    expect(reviewed.ok).toBe(true);
    expect(store.confirmCharacterSheet(room.id, activePlayer)).toMatchObject({ ok: true });
    expect(store.updateRoomPhase(room.id, owner, 'casting')).toMatchObject({ ok: true });
  });

  it('does not let invited friends block the roster until they actually join', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `invite-roster-owner-${suffix}@example.com`,
      displayName: 'Invite Roster Owner',
      password: '123456',
      role: 'keeper',
    })!.account;
    const invited = store.registerAccount({
      email: `invite-roster-ghost-${suffix}@example.com`,
      displayName: 'Invited Ghost',
      password: '123456',
      role: 'player',
    })!.account;
    const activePlayer = store.registerAccount({
      email: `invite-roster-active-${suffix}@example.com`,
      displayName: 'Invite Roster Active',
      password: '123456',
      role: 'player',
    })!.account;
    expect(store.requestFriend(owner.id, invited.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(invited.id, owner.id)?.status).toBe('accepted');

    const room = store.createRoom({
      owner,
      name: 'Invite roster flow room',
      system: 'COC 7th',
    });
    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.inviteRoomFriend(room.id, owner, invited.id)).toMatchObject({ ok: true });

    const afterInvite = store.getRoom(room.id, owner);
    expect(afterInvite?.participants.some((member) => member.accountId === invited.id)).toBe(true);
    expect(afterInvite?.roster.some((member) => member.accountId === invited.id)).toBe(false);

    expect(store.joinRoom(room.id, activePlayer, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
    const draft = store.upsertCharacterSheet(room.id, activePlayer, validSheetInput('Invite Roster Active Sheet'));
    expect(draft.ok).toBe(true);
    const submitted = store.submitCharacterSheet(room.id, activePlayer, draft.sheet);
    expect(submitted.ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'review')).toMatchObject({ ok: true });
  });

  it('ignores historical leaver sheets when advancing and importing the current roster', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `leaver-import-owner-${suffix}@example.com`,
      displayName: 'Leaver Import KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const leavingPlayer = store.registerAccount({
      email: `leaver-import-left-${suffix}@example.com`,
      displayName: 'Leaver Import Left',
      password: '123456',
      role: 'player',
    })!.account;
    const activePlayer = store.registerAccount({
      email: `leaver-import-active-${suffix}@example.com`,
      displayName: 'Leaver Import Active',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Leaver import roster room',
      system: 'COC 7th',
    });

    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, leavingPlayer, 'player').ok).toBe(true);
    expect(store.joinRoom(room.id, activePlayer, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);

    const leavingDraft = store.upsertCharacterSheet(room.id, leavingPlayer, validSheetInput('Leaving Sheet'));
    const activeDraft = store.upsertCharacterSheet(room.id, activePlayer, validSheetInput('Active Sheet'));
    expect(leavingDraft.ok).toBe(true);
    expect(activeDraft.ok).toBe(true);
    const leavingSubmitted = store.submitCharacterSheet(room.id, leavingPlayer, leavingDraft.sheet);
    const activeSubmitted = store.submitCharacterSheet(room.id, activePlayer, activeDraft.sheet);
    expect(leavingSubmitted.ok).toBe(true);
    expect(activeSubmitted.ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'review')).toMatchObject({ ok: true });
    expect(store.reviewCharacterSheet(room.id, owner, leavingSubmitted.sheet.id, { status: 'approved' }).ok).toBe(true);
    expect(store.reviewCharacterSheet(room.id, owner, activeSubmitted.sheet.id, { status: 'approved' }).ok).toBe(true);
    expect(store.confirmCharacterSheet(room.id, leavingPlayer)).toMatchObject({ ok: true });
    expect(store.confirmCharacterSheet(room.id, activePlayer)).toMatchObject({ ok: true });

    const left = store.leaveRoom(room.id, leavingPlayer.id);
    expect(left.ok).toBe(true);
    expect(left.ok ? left.room.roster.some((member) => member.accountId === leavingPlayer.id) : true).toBe(false);
    expect(store.updateRoomPhase(room.id, owner, 'casting')).toMatchObject({ ok: true });
    const imported = store.importApprovedSheets(room.id, owner);
    expect(imported.ok).toBe(true);
    expect(imported.ok ? imported.room.characters.map((character) => character.accountId) : []).toEqual([activePlayer.id]);
  });

  it('does not let historical leavers rejoin an online room outside recruiting', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `leaver-rejoin-owner-${suffix}@example.com`,
      displayName: 'Leaver Rejoin KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `leaver-rejoin-player-${suffix}@example.com`,
      displayName: 'Leaver Rejoin PL',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Leaver rejoin room',
      system: 'COC 7th',
    });

    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
    expect(store.leaveRoom(room.id, player.id).ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player')).toMatchObject({
      ok: false,
      error: 'Room is not recruiting new players',
    });
    expect(store.getRoom(room.id, owner)?.roster.some((member) => member.accountId === player.id)).toBe(false);
    expect(store.listRooms(player).find((summary) => summary.id === room.id)?.canJoin).toBe(false);
  });

  it('keeps invited access-only room members out of the preparation roster across repeated joins', () => {
    const imported = createImportedCoc7Room('access-only-rejoin');
    const visitor = imported.otherSession.account;
    expect(store.requestFriend(imported.ownerSession.account.id, visitor.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(visitor.id, imported.ownerSession.account.id)?.status).toBe('accepted');
    expect(store.inviteRoomFriend(imported.room.id, imported.ownerSession.account, visitor.id)).toMatchObject({ ok: true });
    expect(store.joinRoom(imported.room.id, visitor, 'player')).toMatchObject({ ok: true });

    const afterFirstJoin = store.getRoom(imported.room.id, imported.ownerSession.account);
    expect(afterFirstJoin?.members.some((member) => member.accountId === visitor.id)).toBe(true);
    expect(afterFirstJoin?.participants.some((member) => member.accountId === visitor.id)).toBe(true);
    expect(afterFirstJoin?.roster.some((member) => member.accountId === visitor.id)).toBe(false);

    expect(store.joinRoom(imported.room.id, visitor, 'player')).toMatchObject({ ok: true });
    const afterSecondJoin = store.getRoom(imported.room.id, imported.ownerSession.account);
    expect(afterSecondJoin?.roster.some((member) => member.accountId === visitor.id)).toBe(false);
  });

  it('keeps access-only historical visitors out of the roster when reopening a closed room', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T00:00:00.000Z'));

    const imported = createImportedCoc7Room('access-only-reopen');
    const visitor = imported.otherSession.account;
    expect(store.requestFriend(imported.ownerSession.account.id, visitor.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(visitor.id, imported.ownerSession.account.id)?.status).toBe('accepted');
    expect(store.inviteRoomFriend(imported.room.id, imported.ownerSession.account, visitor.id)).toMatchObject({ ok: true });
    expect(store.joinRoom(imported.room.id, visitor, 'player')).toMatchObject({ ok: true });
    expect(store.getRoom(imported.room.id, imported.ownerSession.account)?.roster.some((member) => member.accountId === visitor.id)).toBe(false);

    expect(store.disconnectRoomMember(imported.room.id, visitor.id).ok).toBe(true);
    expect(store.disconnectRoomMember(imported.room.id, imported.playerSession.account.id).ok).toBe(true);
    expect(store.disconnectRoomMember(imported.room.id, imported.ownerSession.account.id).ok).toBe(true);
    vi.advanceTimersByTime(300_001);
    store.sweepExpiredRooms();
    expect(store.getRoom(imported.room.id, visitor)?.online).toBe(false);

    const reopened = store.joinRoom(imported.room.id, visitor, 'player');
    expect(reopened).toMatchObject({ ok: true });
    expect(reopened.ok ? reopened.room.members.some((member) => member.accountId === visitor.id) : false).toBe(true);
    expect(reopened.ok ? reopened.room.participants.some((member) => member.accountId === visitor.id) : false).toBe(true);
    expect(reopened.ok ? reopened.room.roster.some((member) => member.accountId === visitor.id) : true).toBe(false);
  });

  it('rejects character sheet writes and reviews for players outside the active roster', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `sheet-roster-owner-${suffix}@example.com`,
      displayName: 'Sheet Roster KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `sheet-roster-player-${suffix}@example.com`,
      displayName: 'Sheet Roster PL',
      password: '123456',
      role: 'player',
    })!.account;
    const visitor = store.registerAccount({
      email: `sheet-roster-visitor-${suffix}@example.com`,
      displayName: 'Sheet Roster Visitor',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({ owner, name: 'Sheet roster guard room', system: 'COC 7th' });

    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
    expect(store.requestFriend(owner.id, visitor.email)?.direction).toBe('outgoing');
    expect(store.acceptFriend(visitor.id, owner.id)?.status).toBe('accepted');
    expect(store.inviteRoomFriend(room.id, owner, visitor.id)).toMatchObject({ ok: true });
    expect(store.joinRoom(room.id, visitor, 'player')).toMatchObject({ ok: true });
    expect(store.upsertCharacterSheet(room.id, visitor, validSheetInput('Visitor Sheet'))).toMatchObject({
      ok: false,
      error: 'Only active roster players can edit character sheets',
    });

    const draft = store.upsertCharacterSheet(room.id, player, validSheetInput('Roster Sheet'));
    expect(draft.ok).toBe(true);
    const submitted = store.submitCharacterSheet(room.id, player, draft.sheet);
    expect(submitted.ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'review').ok).toBe(true);
    expect(store.leaveRoom(room.id, player.id)).toMatchObject({ ok: true });
    expect(store.reviewCharacterSheet(room.id, owner, submitted.sheet.id, { status: 'approved' })).toMatchObject({
      ok: false,
      error: 'Only active roster player sheets can be reviewed',
    });
  });

  it('creates rooms and records messages', () => {
    const owner = store.registerAccount({
      email: `room-${Date.now()}@example.com`,
      displayName: 'KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const room = store.createRoom({
      owner,
      name: '测试团',
      system: 'COC 7th',
    });

    const message = store.addMessage(room.id, {
      author: '测试玩家',
      role: 'player',
      text: '我检查门锁。',
    });

    const savedRoom = store.getRoom(room.id, owner);
    expect(message?.text).toBe('我检查门锁。');
    expect(savedRoom?.messages).toHaveLength(1);
  });

  it('deduplicates room messages by client idempotency key', () => {
    const owner = store.registerAccount({
      email: `room-idempotent-${Date.now()}@example.com`,
      displayName: '幂等 KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const room = store.createRoom({
      owner,
      name: '幂等团',
      system: 'COC 7th',
    });

    const first = store.addMessage(room.id, {
      clientMessageId: 'client-message-once',
      author: '测试玩家',
      role: 'player',
      text: '网络抖动时只记录一次。',
    });
    const retried = store.addMessage(room.id, {
      clientMessageId: 'client-message-once',
      author: '测试玩家',
      role: 'player',
      text: '这次重试不应该新建消息。',
    });

    const savedRoom = store.getRoom(room.id, owner);
    expect(retried?.id).toBe(first?.id);
    expect(retried?.text).toBe('网络抖动时只记录一次。');
    expect(savedRoom?.messages).toHaveLength(1);
    expect(savedRoom?.messages[0]?.clientMessageId).toBe('client-message-once');
  });

  it('scopes room message idempotency by sender and message type', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `room-id-scope-owner-${suffix}@example.com`,
      displayName: 'Scope KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `room-id-scope-player-${suffix}@example.com`,
      displayName: 'Scope Player',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({
      owner,
      name: '幂等隔离团',
      system: 'COC 7th',
    });

    const first = store.addMessage(room.id, {
      clientMessageId: 'shared-client-id',
      senderId: owner.id,
      messageType: 'chat',
      author: 'Scope KP',
      role: 'keeper',
      text: 'KP 的消息。',
    });
    const retried = store.addMessage(room.id, {
      clientMessageId: 'shared-client-id',
      senderId: owner.id,
      messageType: 'chat',
      author: 'Scope KP',
      role: 'keeper',
      text: 'KP 的重试。',
    });
    const playerMessage = store.addMessage(room.id, {
      clientMessageId: 'shared-client-id',
      senderId: player.id,
      messageType: 'chat',
      author: 'Scope Player',
      role: 'player',
      text: '玩家同名键消息。',
    });
    const ownerDice = store.addMessage(room.id, {
      clientMessageId: 'shared-client-id',
      senderId: owner.id,
      messageType: 'dice',
      author: 'Scope KP',
      role: 'keeper',
      text: '骰子：1d100<=60',
      roll: {
        formula: '1d100<=60',
        total: 42,
        rolls: [42],
        modifier: 0,
        target: 60,
        comparator: '<=',
        outcome: 'success',
        successLevel: 'regular',
        text: '1d100<=60 => 42，成功',
      },
    });

    expect(retried?.id).toBe(first?.id);
    expect(playerMessage?.id).not.toBe(first?.id);
    expect(ownerDice?.id).not.toBe(first?.id);
    expect(store.getRoom(room.id, owner)?.messages).toHaveLength(3);
  });

  it('keeps moved tokens inside the scene bounds', () => {
    const token = store.moveToken('ember-inn', 'token-a', 99, -20);

    expect(token).toMatchObject({
      id: 'token-a',
      x: 12,
      y: 1,
    });
  });

  it('creates editable scripts', () => {
    const owner = store.registerAccount({
      email: `script-${Date.now()}@example.com`,
      displayName: '剧本作者',
      password: '123456',
      role: 'keeper',
    })!.account;

    const script = store.createScript(owner, {
      title: '测试剧本',
      summary: '用于测试的剧本。',
      visibility: 'private',
    });

    expect(script.title).toBe('测试剧本');
    expect(script.version).toBe(1);
    expect(store.listScripts(owner).some((item) => item.id === script.id && item.canEdit)).toBe(true);
  });

  it('rejects stale script updates without overwriting the current version', () => {
    const owner = store.registerAccount({
      email: `script-lock-${Date.now()}@example.com`,
      displayName: '并发作者',
      password: '123456',
      role: 'keeper',
    })!.account;

    const script = store.createScript(owner, {
      title: '并发保护剧本',
      summary: '初始版本',
      visibility: 'private',
    });

    const firstUpdate = store.updateScript(script.id, owner, {
      title: '服务器已保存版本',
      summary: '第一位编辑者保存',
      version: script.version,
    });
    expect(firstUpdate.ok).toBe(true);
    expect(firstUpdate.ok ? firstUpdate.script.version : null).toBe(2);

    const staleUpdate = store.updateScript(script.id, owner, {
      title: '过期编辑不应覆盖',
      summary: '第二位编辑者的旧草稿',
      version: script.version,
    });
    expect(staleUpdate.ok).toBe(false);
    expect(staleUpdate.ok ? null : staleUpdate.error).toBe('conflict');
    expect(staleUpdate.ok ? null : staleUpdate.currentVersion).toBe(2);

    const current = store.getScript(script.id, owner);
    expect(current).toMatchObject({
      title: '服务器已保存版本',
      summary: '第一位编辑者保存',
      version: 2,
    });
  });

  it('normalizes script map features and tokens before saving', () => {
    const owner = store.registerAccount({
      email: `script-map-normalize-${Date.now()}@example.com`,
      displayName: '地图作者',
      password: '123456',
      role: 'keeper',
    })!.account;

    const script = store.createScript(owner, {
      title: '地图归一化',
      summary: '检查地图对象保存边界。',
      maps: [
        {
          id: 'map-rough',
          name: '  ',
          width: 6,
          height: 5,
          notes: '',
          features: [
            { id: 'feature-rough', type: 'hazard', label: '', x: 0, y: 99, w: 99, h: 0 },
          ],
          tokens: [
            { id: 'token-rough', characterId: 'sc-map', label: '', color: 'red', x: -10, y: 99, status: 'npc' },
            { id: 'token-missing-character', characterId: 'missing', label: '孤儿棋子', color: '#000000', x: 2, y: 2, status: 'ready' },
          ],
        },
      ],
      characters: [
        {
          id: 'sc-map',
          name: '地图角色',
          count: 1,
          parameters: '',
          publicSummary: '用于绑定棋子。',
          story: '',
        },
      ],
    });

    expect(script.maps[0]).toMatchObject({
      name: '未命名地图',
      width: 6,
      height: 5,
    });
    expect(script.maps[0].features).toEqual([
      { id: 'feature-rough', type: 'hazard', label: '危险区', x: 1, y: 5, w: 6, h: 1 },
    ]);
    expect(script.maps[0].tokens).toEqual([
      { id: 'token-rough', characterId: 'sc-map', label: '地图', color: '#187a6d', x: 1, y: 5, status: 'npc' },
    ]);
  });

  it('normalizes script chapter block references before saving', () => {
    const owner = store.registerAccount({
      email: `script-block-normalize-${Date.now()}@example.com`,
      displayName: '章节作者',
      password: '123456',
      role: 'keeper',
    })!.account;

    const script = store.createScript(owner, {
      title: '章节引用归一化',
      maps: [{ id: 'map-valid', name: '可用地图', width: 8, height: 6, notes: '' }],
      characters: [{
        id: 'sc-valid',
        name: '可用人物',
        count: 1,
        parameters: '',
        publicSummary: '公开信息',
        story: '',
      }],
      diceProfiles: [{ id: 'dice-valid', label: '可用骰子', formula: '1d100<=60', probability: 0.5 }],
      chapters: [{
        id: 'chapter-invalid-refs',
        title: '坏引用章节',
        blocks: [
          { id: 'map-bad', type: 'map', title: '坏地图', mapId: 'missing-map', notes: '地图说明' },
          { id: 'map-good', type: 'map', title: '好地图', mapId: 'map-valid', notes: '地图说明' },
          { id: 'character-bad', type: 'character', title: '坏人物', characterId: 'missing-character', notes: '人物说明' },
          { id: 'character-good', type: 'character', title: '好人物', characterId: 'sc-valid', notes: '人物说明' },
          { id: 'check-bad', type: 'check', title: '坏判定', diceId: 'missing-dice', difficulty: 70, onPass: '成功', onFail: '失败' },
          { id: 'check-good', type: 'check', title: '好判定', diceId: 'dice-valid', difficulty: 70, onPass: '成功', onFail: '失败' },
          { id: 'narrative-good', type: 'narrative', title: '正文', markdown: '正文保留' },
        ],
      }],
    });

    expect(script.chapters[0]?.blocks).toEqual([
      expect.objectContaining({ id: 'map-good', type: 'map', mapId: 'map-valid' }),
      expect.objectContaining({ id: 'character-good', type: 'character', characterId: 'sc-valid' }),
      expect.objectContaining({ id: 'check-good', type: 'check', diceId: 'dice-valid' }),
      { id: 'narrative-good', type: 'narrative', title: '正文', markdown: '正文保留' },
    ]);

    const updated = store.updateScript(script.id, owner, {
      version: script.version,
      maps: [],
      characters: [],
      diceProfiles: [],
      chapters: [{
        id: 'chapter-no-resources',
        title: '无资源章节',
        blocks: [
          { id: 'map-orphan', type: 'map', title: '孤儿地图', mapId: 'map-valid', notes: '' },
          { id: 'character-orphan', type: 'character', title: '孤儿人物', characterId: 'sc-valid', notes: '' },
          { id: 'check-orphan', type: 'check', title: '孤儿判定', diceId: 'dice-valid', difficulty: 50, onPass: '', onFail: '' },
          { id: 'narrative-kept', type: 'narrative', title: '正文保留', markdown: '正文仍可运行' },
        ],
      }],
    });

    expect(updated.ok).toBe(true);
    expect(updated.ok ? updated.script.chapters[0]?.blocks : []).toEqual([
      { id: 'narrative-kept', type: 'narrative', title: '正文保留', markdown: '正文仍可运行' },
    ]);
  });

  it('instantiates selected scripts into newly created rooms', () => {
    const owner = store.registerAccount({
      email: `script-room-${Date.now()}@example.com`,
      displayName: '剧本房主',
      password: '123456',
      role: 'keeper',
    })!.account;

    const script = store.createScript(owner, {
      title: '自定义团',
      summary: '自定义地图与人物',
      maps: [
        {
          id: 'map-custom',
          name: '地下室',
          width: 9,
          height: 7,
          notes: '',
          features: [
            { id: 'feature-door', type: 'door', label: '暗门', x: 2, y: 3, w: 1, h: 1 },
            { id: 'feature-edge', type: 'wall', label: '边界墙', x: 9, y: 7, w: 5, h: 4 },
          ],
          tokens: [{ id: 'token-npc', characterId: 'sc-custom', label: '管理员', color: '#b85f32', x: 4, y: 5, status: 'npc' }],
        },
      ],
      characters: [
        {
          id: 'sc-custom',
          name: '管理员',
          count: 2,
          parameters: 'HP 13 / SAN 45',
          publicSummary: '管理地下室和值班区的公开 NPC 人设。',
          story: '知道后门。',
          privateBrief: '钥匙藏在值班室。',
        },
      ],
      diceProfiles: [],
      chapters: [],
    });

    const room = store.createRoom({
      owner,
      name: '剧本实例房',
      system: 'COC 7th',
      scriptId: script.id,
    });

    expect(room.scriptId).toBe(script.id);
    expect(room.summary).toBe('自定义地图与人物');
    expect(room.scene).toMatchObject({ name: '地下室', width: 9, height: 7 });
    expect(room.phase).toBe('module_locked');
    expect(room.scriptCharacters).toHaveLength(1);
    expect(room.scriptCharacters[0]).toMatchObject({ name: '管理员', count: 2, privateBrief: '钥匙藏在值班室。' });
    expect(room.characters).toHaveLength(0);
    expect(room.scene.features).toEqual([
      { id: 'feature-door', type: 'door', label: '暗门', x: 2, y: 3, w: 1, h: 1 },
      { id: 'feature-edge', type: 'wall', label: '边界墙', x: 9, y: 7, w: 1, h: 1 },
    ]);
    expect(room.scene.tokens).toEqual([{ id: 'token-npc', characterId: 'sc-custom', label: '管理员', color: '#b85f32', x: 4, y: 5, status: 'npc' }]);
  });

  it('lets the keeper publish script blocks without leaking the private runtime cursor to players', () => {
    const { ownerSession, playerSession, room } = createRuntimeScriptRoom('runtime-publish');

    expect(store.revealRoomScriptBlock(room.id, playerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-opening',
    })).toMatchObject({
      ok: false,
      error: '只有 KP 可以公开剧本内容。',
    });

    const opened = store.revealRoomScriptBlock(room.id, ownerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-opening',
    });
    expect(opened.ok).toBe(true);
    const openingPublication = opened.ok
      ? opened.room.publicContent.find((item) => item.source?.blockId === 'runtime-block-opening')
      : null;
    expect(openingPublication).toMatchObject({
      type: 'narrative',
      title: '抵达车站',
      markdown: expect.stringContaining('重复的录音'),
    });

    const ownerRoom = store.getRoom(room.id, ownerSession.account);
    const playerRoom = store.getRoom(room.id, playerSession.account);
    expect(ownerRoom?.progress.currentBlockId).toBe('runtime-block-opening');
    expect(playerRoom?.progress.currentBlockId).toBeUndefined();
    expect(playerRoom?.progress.currentChapterId).toBeUndefined();
    expect(playerRoom?.publicContent.find((item) => item.source?.blockId === 'runtime-block-opening')?.markdown).toContain('重复的录音');
    expect(playerRoom?.scriptCharacters[0].privateBrief).toBe('');

    const check = store.revealRoomScriptBlock(room.id, ownerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-check',
    });
    expect(check.ok).toBe(true);
    const checkPublication = check.ok
      ? check.room.publicContent.find((item) => item.source?.blockId === 'runtime-block-check')
      : null;
    expect(checkPublication?.markdown).toContain('骰子：侦查');
    expect(checkPublication?.markdown).not.toContain('发现扩音器');
    expect(checkPublication?.markdown).not.toContain('只听见噪音');

    const character = store.revealRoomScriptBlock(room.id, ownerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-character',
    });
    expect(character.ok).toBe(true);
    const characterPublication = store.getRoom(room.id, playerSession.account)?.publicContent.find(
      (item) => item.source?.blockId === 'runtime-block-character',
    );
    expect(characterPublication?.markdown).toContain('委托人要求你们不要报警');
    expect(characterPublication?.markdown).toContain('受雇调查旧车站失踪案');
    expect(characterPublication?.markdown).toContain('职业倾向：记者');
    expect(characterPublication?.markdown).not.toContain('HP 11');
    expect(characterPublication?.markdown).not.toContain('公开背景：与委托人有联系');
    expect(characterPublication?.markdown).not.toContain('真正委托人');

    const duplicate = store.revealRoomScriptBlock(room.id, ownerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-opening',
    });
    expect(duplicate.ok).toBe(true);
    const afterDuplicate = store.getRoom(room.id, ownerSession.account);
    expect(afterDuplicate?.publicContent.filter((item) => item.source?.blockId === 'runtime-block-opening')).toHaveLength(1);
  });

  it('switches scene through script map blocks and remaps script tokens to imported characters', () => {
    const { ownerSession, playerSession, room } = createRuntimeScriptRoom('runtime-map');
    const mapped = store.revealRoomScriptBlock(room.id, ownerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-map',
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.ok ? mapped.room.scene : null).toMatchObject({
      mapId: 'runtime-map-basement',
      name: '地下候车室',
      width: 8,
      height: 6,
    });

    const playerRoom = store.getRoom(room.id, playerSession.account);
    expect(playerRoom?.scene.name).toBe('地下候车室');
    expect(playerRoom?.scene.tokens.some((token) => token.status === 'hidden')).toBe(false);
    expect(playerRoom?.scene.tokens[0]?.characterId).toBe(playerRoom?.characters[0]?.id);
    expect(playerRoom?.scene.tokens.some((token) => token.id === 'runtime-token-visible-npc')).toBe(true);
    expect(playerRoom?.characters.some((character) => character.id === 'runtime-sc-shadow')).toBe(false);
    expect(playerRoom?.publicContent.find((item) => item.type === 'map')?.markdown).toContain('潮湿空气');
  });

  it('uses the frozen room script snapshot after the source script changes or is deleted', () => {
    const { ownerSession, playerSession, script, room } = createRuntimeScriptRoom('runtime-snapshot');
    expect(room.scriptSnapshot?.version).toBe(script.version);
    expect(room.scriptSnapshot?.chapters[0]?.blocks[0]).toMatchObject({
      id: 'runtime-block-opening',
      markdown: expect.stringContaining('重复的录音'),
    });
    expect(store.getRoom(room.id, playerSession.account)?.scriptSnapshot).toBeUndefined();

    const updated = store.updateScript(script.id, ownerSession.account, {
      ...script,
      title: '源剧本新版',
      version: script.version,
      maps: [
        {
          id: 'runtime-map-basement',
          name: '源剧本新版地图',
          width: 12,
          height: 10,
          notes: '源剧本新版地图备注不应出现。',
          features: [],
          tokens: [],
        },
      ],
      characters: script.characters.map((character) => ({
        ...character,
        publicSummary: '源剧本新版公开人设不应出现',
      })),
      diceProfiles: script.diceProfiles.map((dice) => ({
        ...dice,
        label: '源剧本新版骰子不应出现',
      })),
      chapters: [
        {
          id: 'runtime-chapter-1',
          title: '源剧本新版章节',
          blocks: [
            {
              id: 'runtime-block-opening',
              type: 'narrative',
              title: '源剧本新版标题',
              markdown: '源剧本新版正文不应出现。',
            },
            {
              id: 'runtime-block-map',
              type: 'map',
              title: '源剧本新版地图块',
              mapId: 'runtime-map-basement',
              notes: '源剧本新版切图说明不应出现。',
            },
            {
              id: 'runtime-block-check',
              type: 'check',
              title: '源剧本新版判定',
              diceId: 'runtime-dice-spot',
              difficulty: 99,
              onPass: '',
              onFail: '',
            },
          ],
        },
      ],
    });
    expect(updated.ok).toBe(true);

    const opened = store.revealRoomScriptBlock(room.id, ownerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-opening',
    });
    expect(opened.ok).toBe(true);
    const opening = opened.ok
      ? opened.room.publicContent.find((item) => item.source?.blockId === 'runtime-block-opening')
      : null;
    expect(opening?.title).toBe('抵达车站');
    expect(opening?.markdown).toContain('重复的录音');
    expect(opening?.markdown).not.toContain('源剧本新版');
    expect(opened.ok ? opened.room.progress.scriptVersion : null).toBe(script.version);

    const check = store.revealRoomScriptBlock(room.id, ownerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-check',
    });
    expect(check.ok).toBe(true);
    const checkPublication = check.ok
      ? check.room.publicContent.find((item) => item.source?.blockId === 'runtime-block-check')
      : null;
    expect(checkPublication?.markdown).toContain('骰子：侦查');
    expect(checkPublication?.markdown).not.toContain('源剧本新版骰子');

    const switched = store.switchRoomScriptMap(room.id, ownerSession.account, { mapId: 'runtime-map-basement' });
    expect(switched.ok).toBe(true);
    expect(switched.ok ? switched.room.scene : null).toMatchObject({
      name: '地下候车室',
      width: 8,
      height: 6,
    });
    expect(switched.ok ? switched.room.scene.name : '').not.toContain('源剧本新版');

    expect(store.deleteScript(script.id, ownerSession.account).ok).toBe(true);
    const openedAfterDelete = store.revealRoomScriptBlock(room.id, ownerSession.account, {
      chapterId: 'runtime-chapter-1',
      blockId: 'runtime-block-character',
    });
    expect(openedAfterDelete.ok).toBe(true);
    const characterPublication = openedAfterDelete.ok
      ? openedAfterDelete.room.publicContent.find((item) => item.source?.blockId === 'runtime-block-character')
      : null;
    expect(characterPublication?.markdown).toContain('委托人要求你们不要报警');
    expect(characterPublication?.markdown).not.toContain('源剧本新版公开人设');
  });

  it('exposes owner-only REST endpoints for publishing runtime blocks and switching maps', async () => {
    await withServer(async (baseUrl) => {
      const { ownerSession, playerSession, room } = createRuntimeScriptRoom('runtime-api');
      const forbidden = await api(baseUrl, `/api/rooms/${room.id}/script-blocks/reveal`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({
          chapterId: 'runtime-chapter-1',
          blockId: 'runtime-block-opening',
        }),
      });
      expect(forbidden.status).toBe(403);

      const published = await api(baseUrl, `/api/rooms/${room.id}/script-blocks/reveal`, {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({
          chapterId: 'runtime-chapter-1',
          blockId: 'runtime-block-opening',
        }),
      });
      expect(published.status).toBe(200);
      expect(published.body.scriptSnapshot?.title).toBe('runtime-api Runtime Script');
      expect(published.body.publicContent.find((item: { title?: string; source?: { blockId?: string } }) => item.source?.blockId === 'runtime-block-opening')?.title).toBe('抵达车站');
      expect(published.body.progress.currentBlockId).toBe('runtime-block-opening');

      const playerRoom = await api(baseUrl, `/api/rooms/${room.id}`, { token: playerSession.token });
      expect(playerRoom.status).toBe(200);
      expect(playerRoom.body.scriptSnapshot).toBeUndefined();
      expect(playerRoom.body.publicContent.find((item: { title?: string; source?: { blockId?: string } }) => item.source?.blockId === 'runtime-block-opening')?.title).toBe('抵达车站');
      expect(playerRoom.body.progress.currentBlockId).toBeUndefined();

      const switched = await api(baseUrl, `/api/rooms/${room.id}/script-map`, {
        method: 'PATCH',
        token: ownerSession.token,
        body: JSON.stringify({ mapId: 'runtime-map-basement' }),
      });
      expect(switched.status).toBe(200);
      expect(switched.body.scene).toMatchObject({ mapId: 'runtime-map-basement', name: '地下候车室' });
    });
  });

  it('redacts keeper private briefs from non-owner script and room payloads', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `brief-owner-${suffix}@example.com`,
        displayName: 'Brief Keeper',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `brief-player-${suffix}@example.com`,
        displayName: 'Brief Player',
        password: '123456',
        role: 'player',
      })!;
      const script = store.createScript(ownerSession.account, {
        title: 'Private Brief Script',
        visibility: 'public',
        summary: '公开剧情摘要',
        maps: [{
          id: 'brief-map',
          name: '秘密地图',
          width: 8,
          height: 6,
          notes: '最终真相藏在地下室。',
          tokens: [],
        }],
        characters: [
          {
            id: 'sc-private-brief',
            name: '公开人设',
            count: 1,
            parameters: 'STR 90 / 隐藏战斗参数',
            publicSummary: '玩家加入前可见的公开人设。',
            story: '最终真相：角色其实知道幕后黑手。',
            privateBrief: 'KP隐藏真相',
          },
        ],
        diceProfiles: [{ id: 'brief-dice', label: '秘密判定', formula: '1d100<=20', probability: 0.2 }],
        chapters: [{
          id: 'brief-chapter',
          title: '真相章节',
          blocks: [{
            id: 'brief-ending',
            type: 'narrative',
            title: '结局真相',
            markdown: '最终真相：邪教仪式已经完成。',
          }],
        }],
      });

      const ownerScript = await api(baseUrl, `/api/scripts/${script.id}`, { token: ownerSession.token });
      expect(ownerScript.status).toBe(200);
      expect(ownerScript.body.characters[0].privateBrief).toBe('KP隐藏真相');
      expect(ownerScript.body.chapters[0].blocks[0].markdown).toContain('最终真相');

      const playerScript = await api(baseUrl, `/api/scripts/${script.id}`, { token: playerSession.token });
      expect(playerScript.status).toBe(200);
      expect(playerScript.body.characters[0].privateBrief).toBe('');
      expect(playerScript.body.characters[0].parameters).toBe('');
      expect(playerScript.body.characters[0].story).toBe('');
      expect(playerScript.body.chapters).toEqual([]);
      expect(playerScript.body.maps).toEqual([]);
      expect(playerScript.body.diceProfiles).toEqual([]);

      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Private Brief Room',
        system: 'COC 7th',
        scriptId: script.id,
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);

      const ownerRoom = await api(baseUrl, `/api/rooms/${room.id}`, { token: ownerSession.token });
      expect(ownerRoom.status).toBe(200);
      expect(ownerRoom.body.scriptCharacters[0].privateBrief).toBe('KP隐藏真相');
      expect(ownerRoom.body.scriptCharacters[0].parameters).toContain('隐藏战斗参数');
      expect(ownerRoom.body.scriptCharacters[0].story).toContain('最终真相');

      const playerJoin = await api(baseUrl, `/api/rooms/${room.id}/join`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ role: 'keeper' }),
      });
      expect(playerJoin.status).toBe(200);
      expect(playerJoin.body.members.find((member: { accountId: string; role: string }) => member.accountId === playerSession.account.id)?.role).toBe('player');
      expect(playerJoin.body.scriptCharacters[0].privateBrief).toBe('');
      expect(playerJoin.body.scriptCharacters[0].parameters).toBe('');
      expect(playerJoin.body.scriptCharacters[0].story).toBe('');

      const playerMessage = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ text: 'role should stay player' }),
      });
      expect(playerMessage.status).toBe(201);
      expect(playerMessage.body).toMatchObject({
        author: 'Brief Player',
        role: 'player',
        text: 'role should stay player',
      });

      const playerRoom = await api(baseUrl, `/api/rooms/${room.id}`, { token: playerSession.token });
      expect(playerRoom.status).toBe(200);
      expect(playerRoom.body.scriptCharacters[0].privateBrief).toBe('');
      expect(playerRoom.body.scriptCharacters[0].parameters).toBe('');
      expect(playerRoom.body.scriptCharacters[0].story).toBe('');

      const socket = await connectSocket(baseUrl);
      try {
        const joined = await emitAck<{
          ok: true;
            room: {
              members: Array<{ accountId: string; role: string }>;
              scriptCharacters: Array<{ parameters?: string; story?: string; privateBrief?: string }>;
            };
          }>(
          socket,
          'room:join',
          {
            roomId: room.id,
            token: playerSession.token,
            role: 'keeper',
          },
        );
        expect(joined.ok).toBe(true);
        expect(joined.room.members.find((member: { accountId: string; role: string }) => member.accountId === playerSession.account.id)?.role).toBe('player');
        expect(joined.room.scriptCharacters[0].privateBrief).toBe('');
        expect(joined.room.scriptCharacters[0].parameters).toBe('');
        expect(joined.room.scriptCharacters[0].story).toBe('');

        const socketMessage = await emitAck<{ ok: true; data: { author: string; role: string; text: string } }>(
          socket,
          'chat:send',
          {
            roomId: room.id,
            token: playerSession.token,
            message: { text: 'socket role should stay player' },
          },
        );
        expect(socketMessage).toMatchObject({
          ok: true,
          data: {
            author: 'Brief Player',
            role: 'player',
            text: 'socket role should stay player',
          },
        });
      } finally {
        socket.close();
      }
    });
  });

  it('scopes character sheets to the room owner or the sheet owner', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `sheet-owner-${suffix}@example.com`,
      displayName: 'Sheet KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const playerA = store.registerAccount({
      email: `sheet-a-${suffix}@example.com`,
      displayName: 'Sheet A',
      password: '123456',
      role: 'player',
    })!.account;
    const playerB = store.registerAccount({
      email: `sheet-b-${suffix}@example.com`,
      displayName: 'Sheet B',
      password: '123456',
      role: 'player',
    })!.account;

    const room = store.createRoom({
      owner,
      name: 'Sheet Scope Room',
      system: 'COC 7th',
    });
    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, playerA, 'player').ok).toBe(true);
    expect(store.joinRoom(room.id, playerB, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
    expect(store.upsertCharacterSheet(room.id, playerA, { name: 'Alice', occupation: 'Reporter' }).ok).toBe(true);
    expect(store.upsertCharacterSheet(room.id, playerB, { name: 'Bob', occupation: 'Doctor' }).ok).toBe(true);

    expect(store.getRoom(room.id, owner)?.characterSheets.map((sheet) => sheet.ownerId).sort()).toEqual(
      [playerA.id, playerB.id].sort(),
    );
    expect(store.getRoom(room.id, playerA)?.characterSheets.map((sheet) => sheet.ownerId)).toEqual([playerA.id]);
    expect(store.getRoom(room.id, playerB)?.characterSheets.map((sheet) => sheet.ownerId)).toEqual([playerB.id]);
    expect(store.getRoomBroadcastState(room.id)?.characterSheets).toEqual([]);

    const viewerStates = store.getRoomViewerStates(room.id);
    const ownerState = viewerStates.find((viewer) => viewer.accountId === owner.id)?.room;
    const playerAState = viewerStates.find((viewer) => viewer.accountId === playerA.id)?.room;
    expect(ownerState?.characterSheets).toHaveLength(2);
    expect(playerAState?.characterSheets.map((sheet) => sheet.ownerId)).toEqual([playerA.id]);
  });

  it('redacts keeper-only scene tokens and character notes for player viewers', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `scene-redact-owner-${suffix}@example.com`,
      displayName: 'Scene KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `scene-redact-player-${suffix}@example.com`,
      displayName: 'Scene Player',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Scene Redaction Room',
      system: 'COC 7th',
    });
    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);

    expect(store.updateCharacter(room.id, {
      id: 'player-character',
      accountId: player.id,
      name: 'Visible Investigator',
      player: player.displayName,
      avatar: 'VI',
      hp: 10,
      maxHp: 10,
      sanity: 45,
      maxSanity: 45,
      initiative: 50,
      tags: ['调查员'],
      notes: '玩家自己的背景秘密',
    })).toBeTruthy();
    expect(store.updateCharacter(room.id, {
      id: 'keeper-npc',
      name: 'Hidden NPC',
      player: 'KP',
      avatar: 'HN',
      hp: 8,
      maxHp: 8,
      sanity: 30,
      maxSanity: 30,
      initiative: 40,
      tags: ['NPC'],
      notes: 'KP暗线：地下室入口',
      statBlock: {
        accountId: owner.id,
        hp: 8,
        maxHp: 8,
        mp: 8,
        maxMp: 8,
        san: 30,
        maxSan: 30,
        mov: 8,
        db: '0',
        build: 0,
        attributes: { str: 40, con: 40, siz: 40, dex: 40, app: 40, int: 40, pow: 40, edu: 40, luck: 40 },
        skills: { spotHidden: 60 },
        skillNames: { spotHidden: '侦查' },
      },
    })).toBeTruthy();
    store.upsertToken(room.id, {
      id: 'player-token',
      characterId: 'player-character',
      label: '调查员',
      color: '#187a6d',
      x: 1,
      y: 1,
      status: 'ready',
    });
    store.upsertToken(room.id, {
      id: 'hidden-token',
      characterId: 'keeper-npc',
      label: '暗处NPC',
      color: '#b85f32',
      x: 2,
      y: 2,
      status: 'hidden',
    });

    const ownerRoom = store.getRoom(room.id, owner);
    const playerRoom = store.getRoom(room.id, player);
    expect(ownerRoom?.scene.tokens.map((token) => token.id).sort()).toEqual(['hidden-token', 'player-token']);
    expect(ownerRoom?.characters.find((character) => character.id === 'keeper-npc')?.notes).toBe('KP暗线：地下室入口');
    expect(playerRoom?.scene.tokens.map((token) => token.id)).toEqual(['player-token']);
    expect(playerRoom?.characters.find((character) => character.id === 'player-character')?.notes).toBe('玩家自己的背景秘密');
    expect(playerRoom?.characters.find((character) => character.id === 'keeper-npc')).toBeUndefined();
  });

  it('emits viewer-redacted room state instead of full character or token socket deltas', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `viewer-event-owner-${suffix}@example.com`,
        displayName: 'Viewer Event KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerASession = store.registerAccount({
        email: `viewer-event-a-${suffix}@example.com`,
        displayName: 'Viewer Event A',
        password: '123456',
        role: 'player',
      })!;
      const playerBSession = store.registerAccount({
        email: `viewer-event-b-${suffix}@example.com`,
        displayName: 'Viewer Event B',
        password: '123456',
        role: 'player',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Viewer Event Room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(room.id, playerASession.account, 'player').ok).toBe(true);
      expect(store.joinRoom(room.id, playerBSession.account, 'player').ok).toBe(true);
      expect(store.updateCharacter(room.id, {
        id: 'player-a-character',
        accountId: playerASession.account.id,
        name: 'Player A Character',
        player: playerASession.account.displayName,
        avatar: 'PA',
        hp: 10,
        maxHp: 10,
        sanity: 50,
        maxSanity: 50,
        initiative: 50,
        tags: ['调查员'],
        notes: '玩家A秘密',
        statBlock: {
          accountId: playerASession.account.id,
          hp: 10,
          maxHp: 10,
          mp: 10,
          maxMp: 10,
          san: 50,
          maxSan: 50,
          mov: 8,
          db: '0',
          build: 0,
          attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 },
          skills: { spotHidden: 45 },
          skillNames: { spotHidden: '侦查' },
        },
      })).toBeTruthy();
      expect(store.updateCharacter(room.id, {
        id: 'keeper-hidden-npc',
        name: 'Hidden NPC',
        player: 'KP',
        avatar: 'HN',
        hp: 9,
        maxHp: 9,
        sanity: 30,
        maxSanity: 30,
        initiative: 40,
        tags: ['NPC'],
        notes: 'NPC隐藏动机',
        statBlock: {
          accountId: ownerSession.account.id,
          hp: 9,
          maxHp: 9,
          mp: 8,
          maxMp: 8,
          san: 30,
          maxSan: 30,
          mov: 8,
          db: '0',
          build: 0,
          attributes: { str: 40, con: 40, siz: 40, dex: 40, app: 40, int: 40, pow: 40, edu: 40, luck: 40 },
          skills: { spotHidden: 80 },
          skillNames: { spotHidden: '侦查' },
        },
      })).toBeTruthy();
      store.upsertToken(room.id, {
        id: 'hidden-npc-token',
        characterId: 'keeper-hidden-npc',
        label: '暗处NPC',
        color: '#b85f32',
        x: 2,
        y: 2,
        status: 'hidden',
      });

      const ownerSocket = await connectSocket(baseUrl, ownerSession.token);
      const playerBSocket = await connectSocket(baseUrl, playerBSession.token);
      try {
        const noCharacterDelta = waitForNoSocketEvent<Character & { roomId?: string }>(playerBSocket, 'character:updated', 250);
        const characterStateEvent = waitForSocketEvent<{
          characters: Character[];
          scene: { tokens: Array<{ id: string }> };
        }>(playerBSocket, 'room:state');
        const updateAck = await emitAck<{ ok: true; data: Character } | { ok: false; error: unknown }>(
          ownerSocket,
          'character:update',
          {
            roomId: room.id,
            token: ownerSession.token,
            character: {
              id: 'keeper-hidden-npc',
              name: 'Hidden NPC',
              player: 'KP',
              avatar: 'HN',
              hp: 7,
              maxHp: 9,
              sanity: 30,
              maxSanity: 30,
              initiative: 40,
              tags: ['NPC'],
              notes: '更新后的NPC隐藏动机',
            },
          },
        );
        expect(updateAck.ok).toBe(true);
        const playerBCharacterState = await characterStateEvent;
        expect(await noCharacterDelta).toBeNull();
        expect(playerBCharacterState.characters.find((character) => character.id === 'keeper-hidden-npc')).toBeUndefined();
        expect(playerBCharacterState.scene.tokens.map((token) => token.id)).not.toContain('hidden-npc-token');

        const noTokenDelta = waitForNoSocketEvent<{ tokenId: string }>(playerBSocket, 'scene:tokenMoved', 250);
        const tokenStateEvent = waitForSocketEvent<{
          scene: { tokens: Array<{ id: string; x: number; y: number }> };
        }>(playerBSocket, 'room:state');
        const tokenAck = await emitAck<{ ok: true; data: { id: string; x: number; y: number } } | { ok: false; error: unknown }>(
          ownerSocket,
          'scene:moveToken',
          {
            roomId: room.id,
            token: ownerSession.token,
            tokenId: 'hidden-npc-token',
            x: 5,
            y: 5,
          },
        );
        expect(tokenAck.ok).toBe(true);
        const playerBTokenState = await tokenStateEvent;
        expect(await noTokenDelta).toBeNull();
        expect(playerBTokenState.scene.tokens.map((token) => token.id)).not.toContain('hidden-npc-token');
      } finally {
        ownerSocket.close();
        playerBSocket.close();
      }
    });
  });

  it('rejects room flow phase skips and premature casting or import', () => {
    const owner = store.registerAccount({
      email: `phase-guard-${Date.now()}@example.com`,
      displayName: 'Phase Guard KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `phase-guard-player-${Date.now()}@example.com`,
      displayName: 'Phase Guard PL',
      password: '123456',
      role: 'player',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Phase Guard Room',
      system: 'COC 7th',
    });

    expect(store.updateRoomPhase(room.id, owner, 'recruiting')).toMatchObject({
      ok: false,
      error: expect.stringContaining('确认模组后才能招募PL'),
    });
    expect(store.updateRoomPhase(room.id, owner, 'playing')).toMatchObject({
      ok: false,
      error: '跑团流程需要按模组确认、招募、车卡、审核、选角导入、开团的顺序推进。',
    });
    expect(store.updateRoomPhase(room.id, owner, 'casting')).toMatchObject({
      ok: false,
      error: '跑团流程需要按模组确认、招募、车卡、审核、选角导入、开团的顺序推进。',
    });
    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen')).toMatchObject({
      ok: false,
      error: '进入车卡前至少需要 1 名已加入名单的玩家。',
    });
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'casting')).toMatchObject({
      ok: false,
      error: '跑团流程需要按模组确认、招募、车卡、审核、选角导入、开团的顺序推进。',
    });
    expect(store.updateRoomPhase(room.id, owner, 'review')).toMatchObject({
      ok: false,
      error: '进入集中审核前至少需要 1 张已提交角色卡。',
    });
    expect(store.updateRoomPhase(room.id, owner, 'casting')).toMatchObject({
      ok: false,
      error: '跑团流程需要按模组确认、招募、车卡、审核、选角导入、开团的顺序推进。',
    });
    expect(store.importApprovedSheets(room.id, owner)).toMatchObject({
      ok: false,
      error: 'Approved sheets can be imported during casting',
    });

    const latePlayer = store.registerAccount({
      email: `phase-late-player-${Date.now()}@example.com`,
      displayName: 'Phase Late Player',
      password: '123456',
    })!.account;
    expect(store.joinRoom(room.id, latePlayer, 'player')).toMatchObject({
      ok: false,
      error: 'Room is not recruiting new players',
    });
    expect(store.updateRoomPhase(room.id, owner, 'recruiting').ok).toBe(false);
  });

  it('keeps multi-player character review from auto-advancing before every active player is approved', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `multi-flow-owner-${suffix}@example.com`,
      displayName: 'Multi Flow KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const playerA = store.registerAccount({
      email: `multi-flow-a-${suffix}@example.com`,
      displayName: 'PL A',
      password: '123456',
    })!.account;
    const playerB = store.registerAccount({
      email: `multi-flow-b-${suffix}@example.com`,
      displayName: 'PL B',
      password: '123456',
    })!.account;
    const room = store.createRoom({
      owner,
      name: '多人流程房',
      system: 'COC 7th',
    });

    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, playerA, 'player').ok).toBe(true);
    expect(store.joinRoom(room.id, playerB, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
    const draftA = store.upsertCharacterSheet(room.id, playerA, validSheetInput('A'));
    const draftB = store.upsertCharacterSheet(room.id, playerB, validSheetInput('B'));
    expect(draftA.ok).toBe(true);
    expect(draftB.ok).toBe(true);
    const submittedA = store.submitCharacterSheet(room.id, playerA, draftA.sheet);
    expect(submittedA.ok).toBe(true);
    expect(submittedA.room.phase).toBe('chargen');
    expect(store.updateRoomPhase(room.id, owner, 'review')).toMatchObject({
      ok: false,
      error: expect.stringContaining('PL B'),
    });
    const submittedB = store.submitCharacterSheet(room.id, playerB, draftB.sheet);
    expect(submittedB.ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'review').ok).toBe(true);
    const reviewedA = store.reviewCharacterSheet(room.id, owner, submittedA.sheet.id, { status: 'approved' });
    expect(reviewedA.ok).toBe(true);
    expect(reviewedA.room.phase).toBe('review');
    expect(store.updateRoomPhase(room.id, owner, 'casting')).toMatchObject({
      ok: false,
      error: '进入选角导入前需要先审核完所有已提交角色卡。',
    });
    const reviewedB = store.reviewCharacterSheet(room.id, owner, submittedB.sheet.id, { status: 'approved' });
    expect(reviewedB.ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'casting')).toMatchObject({
      ok: false,
      error: expect.stringContaining('确认已通过角色卡'),
    });
    expect(store.confirmCharacterSheet(room.id, playerA).ok).toBe(true);
    expect(store.confirmCharacterSheet(room.id, playerB).ok).toBe(true);
    const casting = store.updateRoomPhase(room.id, owner, 'casting');
    expect(casting.ok).toBe(true);
    expect(casting.ok ? casting.room.phase : null).toBe('casting');
  });

  it('rejects overbooked script character choices and preserves script dice in rooms', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = store.registerAccount({
      email: `script-choice-owner-${suffix}@example.com`,
      displayName: 'Choice KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const playerA = store.registerAccount({
      email: `script-choice-a-${suffix}@example.com`,
      displayName: 'Choice A',
      password: '123456',
    })!.account;
    const playerB = store.registerAccount({
      email: `script-choice-b-${suffix}@example.com`,
      displayName: 'Choice B',
      password: '123456',
    })!.account;
    const script = store.createScript(owner, {
      title: '名额与骰子',
      summary: '公开招募剧情',
      characters: [{ id: 'only-one', name: '唯一人设', count: 1, parameters: '', publicSummary: '唯一可选的公开人设', story: '公开人设背景' }],
      diceProfiles: [{ id: 'spot-check', label: '侦查检定', formula: '1d100<=60', probability: 0.6 }],
    });
    const room = store.createRoom({ owner, name: '名额房', scriptId: script.id });
    expect(room.diceProfiles).toEqual([
      expect.objectContaining({ id: 'spot-check', label: '侦查检定', formula: '1d100<=60' }),
    ]);
    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, playerA, 'player').ok).toBe(true);
    expect(store.joinRoom(room.id, playerB, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
    const draftA = store.upsertCharacterSheet(room.id, playerA, validSheetInput('A', { scriptCharacterId: 'only-one' }));
    const draftB = store.upsertCharacterSheet(room.id, playerB, validSheetInput('B', { scriptCharacterId: 'only-one' }));
    expect(draftA.ok).toBe(true);
    expect(draftB.ok).toBe(true);
    const submittedA = store.submitCharacterSheet(room.id, playerA, draftA.sheet);
    expect(submittedA.validation.ok).toBe(true);
    const submittedB = store.submitCharacterSheet(room.id, playerB, draftB.sheet);
    expect(submittedB.validation.ok).toBe(false);
    expect(submittedB.validation.errors.join('；')).toContain('唯一人设');
  });

  it('rejects room flow phase skips and premature review actions', () => {
    const owner = store.registerAccount({
      email: `phase-review-${Date.now()}@example.com`,
      displayName: 'Phase Review KP',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `phase-review-player-${Date.now()}@example.com`,
      displayName: 'Phase Review Player',
      password: '123456',
    })!.account;
    const room = store.createRoom({
      owner,
      name: 'Phase Review Room',
      system: 'COC 7th',
    });

    expect(enterRecruiting(room.id, owner).ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, owner, 'chargen').ok).toBe(true);
    const draft = store.upsertCharacterSheet(room.id, player, {
      name: 'Late Draft',
      occupation: '记者',
    });
    expect(draft.ok).toBe(true);
    expect(store.reviewCharacterSheet(room.id, owner, draft.sheet.id, { status: 'approved' })).toMatchObject({
      ok: false,
      error: 'Character sheets can only be reviewed during the review phase',
    });
  });

  it('supports the COC7 preparation flow from sheet submission to imported dice checks', () => {
    const keeper = store.registerAccount({
      email: `keeper-flow-${Date.now()}@example.com`,
      displayName: 'Flow Keeper',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `player-flow-${Date.now()}@example.com`,
      displayName: 'Flow Player',
      password: '123456',
      role: 'player',
    })!.account;

    const script = store.createScript(keeper, {
      title: '流程测试团',
      summary: '用于流程测试',
      maps: [
        {
          id: 'flow-map',
          name: '流程测试地图',
          width: 10,
          height: 8,
          notes: '',
          tokens: [{ id: 'script-token-reporter', characterId: 'sc-reporter', label: '记者', color: '#187a6d', x: 7, y: 6, status: 'ready' }],
        },
      ],
      characters: [
        {
          id: 'sc-reporter',
          name: '记者人设',
          count: 1,
          parameters: '隐藏战斗参数：携带禁忌物品',
          story: '最终真相：记者认识幕后黑手',
          occupation: '记者',
          publicSummary: '适合调查开局',
        },
      ],
    });
    const room = store.createRoom({ owner: keeper, name: '流程房', visibility: 'public', scriptId: script.id });
    const prepared = store.updateRoomPreparation(room.id, keeper, {
      summary: '公开剧情已经由KP改写',
      scriptCharacters: [
        {
          ...room.scriptCharacters[0],
          publicSummary: '改写后的公开人设',
          privateBrief: '只有KP能看的秘密',
          recommendedSkills: [{ name: '侦查', base: 50 }],
        },
      ],
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.ok && prepared.room.summary).toBe('公开剧情已经由KP改写');
    expect(prepared.ok && prepared.room.scriptCharacters[0].publicSummary).toBe('改写后的公开人设');
    expect(prepared.ok && prepared.room.scriptCharacters[0].privateBrief).toBe('只有KP能看的秘密');
    const recruiting = enterRecruiting(room.id, keeper);
    expect(recruiting.ok).toBe(true);
    const briefing = recruiting.ok
      ? recruiting.room.publicContent.find((item) => item.source?.blockId === '__room_public_briefing')
      : null;
    const rolePack = recruiting.ok
      ? recruiting.room.publicContent.find((item) => item.source?.blockId === '__room_public_role_pack')
      : null;
    expect(briefing).toMatchObject({
      title: '开场公开剧情',
      markdown: '公开剧情已经由KP改写',
    });
    expect(rolePack?.markdown).toContain('记者人设');
    expect(rolePack?.markdown).toContain('改写后的公开人设');
    expect(rolePack?.markdown).toContain('推荐技能：侦查 50');
    expect(rolePack?.markdown).not.toContain('只有KP能看的秘密');
    expect(rolePack?.markdown).not.toContain('隐藏战斗参数');
    expect(rolePack?.markdown).not.toContain('最终真相');
    expect(rolePack?.markdown).not.toContain('公开参数');
    expect(rolePack?.markdown).not.toContain('公开背景');
    expect(store.getRoom(room.id, player)?.publicContent.find((item) => item.source?.blockId === '__room_public_role_pack')?.markdown).toContain('改写后的公开人设');
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, keeper, 'chargen').ok).toBe(true);
    expect(store.upsertCharacterSheet(room.id, keeper, { name: 'KP卡' }).ok).toBe(false);

    const draft = store.upsertCharacterSheet(room.id, player, {
      scriptCharacterId: 'sc-reporter',
      name: '许闻',
      occupation: '记者',
      age: 32,
      sex: '男',
      residence: '上海',
      birthplace: '宁波',
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
        { key: 'locksmith', name: '锁匠', base: 1, occupation: 0, interest: 39, growth: 0 },
      ],
      background: {
        description: '调查记者，受雇追查异常失踪。',
        ideology: '',
        significantPeople: '',
        locations: '',
        possessions: '',
        traits: '',
      },
    });
    expect(draft.ok).toBe(true);
    expect(draft.validation.ok).toBe(true);

    const submitted = store.submitCharacterSheet(room.id, player, draft.sheet);
    expect(submitted.ok).toBe(true);
    expect(submitted.sheet.status).toBe('submitted');
    expect(submitted.room.phase).toBe('chargen');
    expect(store.upsertCharacterSheet(room.id, player, { ...submitted.sheet, name: '提交后不应改名' })).toMatchObject({
      ok: false,
      error: '角色卡已提交，等待 KP 审核；如需修改请等待 KP 驳回。',
    });
    expect(store.submitCharacterSheet(room.id, player, submitted.sheet)).toMatchObject({
      ok: false,
      error: '角色卡已提交，等待 KP 审核；如需修改请等待 KP 驳回。',
    });
    const reviewPhase = store.updateRoomPhase(room.id, keeper, 'review');
    expect(reviewPhase.ok).toBe(true);

    const reviewed = store.reviewCharacterSheet(room.id, keeper, submitted.sheet.id, { status: 'approved' });
    expect(reviewed.ok).toBe(true);
    expect(reviewed.sheet.status).toBe('approved');
    expect(reviewed.room.phase).toBe('review');
    expect(store.submitCharacterSheet(room.id, player, reviewed.sheet)).toMatchObject({
      ok: false,
      error: '角色卡已通过，不能继续编辑。',
    });
    expect(store.updateRoomPhase(room.id, keeper, 'casting')).toMatchObject({
      ok: false,
      error: expect.stringContaining('确认已通过角色卡'),
    });
    const confirmed = store.confirmCharacterSheet(room.id, player);
    expect(confirmed.ok).toBe(true);
    expect(confirmed.ok ? confirmed.sheet.confirmedAt : '').toBeTruthy();
    const castingPhase = store.updateRoomPhase(room.id, keeper, 'casting');
    expect(castingPhase.ok).toBe(true);
    expect(store.importApprovedSheets(room.id, player).ok).toBe(false);

    const imported = store.importApprovedSheets(room.id, keeper);
    expect(imported.ok).toBe(true);
    expect(imported.room.phase).toBe('playing');
    expect(imported.room.publicContent.filter((item) => item.source?.blockId === '__room_public_briefing')).toHaveLength(1);
    expect(imported.room.publicContent.filter((item) => item.source?.blockId === '__room_public_role_pack')).toHaveLength(1);
    expect(imported.room.publicContent.find((item) => item.source?.blockId === '__room_public_role_pack')?.markdown).not.toContain('只有KP能看的秘密');
    expect(imported.room.characters[0]).toMatchObject({ name: '许闻', accountId: player.id, hp: 11, sanity: 50 });
    expect(imported.room.characters[0].statBlock?.skills.spotHidden).toBe(45);
    expect(store.reviewCharacterSheet(room.id, keeper, submitted.sheet.id, { status: 'rejected' })).toMatchObject({
      ok: false,
      error: 'Character sheets can only be reviewed during the review phase',
    });
    expect(store.getRoom(room.id, keeper)?.phase).toBe('playing');
    expect(store.updateRoomPhase(room.id, keeper, 'review').ok).toBe(false);

    const sourceCharacter = imported.room.characters[0];
    const wounded = store.updateCharacter(room.id, {
      id: sourceCharacter.id,
      name: sourceCharacter.name,
      player: sourceCharacter.player,
      avatar: sourceCharacter.avatar,
      hp: 3,
      maxHp: sourceCharacter.maxHp,
      sanity: 12,
      maxSanity: sourceCharacter.maxSanity,
      initiative: sourceCharacter.initiative,
      tags: sourceCharacter.tags,
      notes: sourceCharacter.notes,
    });
    expect(wounded?.hp).toBe(3);
    expect(wounded?.accountId).toBe(player.id);
    expect(wounded?.sheetId).toBe(imported.room.characters[0].sheetId);
    expect(wounded?.statBlock?.skills.spotHidden).toBe(45);
    expect(wounded?.statBlock?.skills.locksmith).toBe(40);
    expect(imported.room.scene.tokens).toEqual([
      expect.objectContaining({
        id: 'script-token-reporter',
        characterId: imported.room.characters[0].id,
        x: 7,
        y: 6,
      }),
    ]);
    expect(imported.room.scene.tokens.some((token) => token.characterId === 'sc-reporter')).toBe(false);
    const reimported = store.importApprovedSheets(room.id, keeper);
    expect(reimported.ok).toBe(true);
    expect(reimported.room.characters[0]).toMatchObject({ hp: 3, sanity: 12 });

    const roll = store.rollCoc7Ability(room.id, player, '侦查');
    expect(roll.ok).toBe(true);
    expect(roll.ok && roll.roll.formula).toBe('1d100<=45');
    const attributeRoll = store.rollCoc7Ability(room.id, player, '力量');
    expect(attributeRoll.ok).toBe(true);
    expect(attributeRoll.ok && attributeRoll.roll.formula).toBe('1d100<=50');
    const customSkillRoll = store.rollCoc7Ability(room.id, player, '锁匠');
    expect(customSkillRoll.ok).toBe(true);
    expect(customSkillRoll.ok && customSkillRoll.roll.formula).toBe('1d100<=40');
  });

  it('does not review character sheets after the room has closed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T03:00:00.000Z'));
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const keeper = store.registerAccount({
      email: `closed-review-keeper-${suffix}@example.com`,
      displayName: 'Closed Review Keeper',
      password: '123456',
      role: 'keeper',
    })!.account;
    const player = store.registerAccount({
      email: `closed-review-player-${suffix}@example.com`,
      displayName: 'Closed Review Player',
      password: '123456',
    })!.account;
    const room = store.createRoom({ owner: keeper, name: 'Closed Review Room', system: 'COC 7th' });
    expect(enterRecruiting(room.id, keeper).ok).toBe(true);
    expect(store.joinRoom(room.id, player, 'player').ok).toBe(true);
    expect(store.updateRoomPhase(room.id, keeper, 'chargen').ok).toBe(true);
    const draft = store.upsertCharacterSheet(room.id, player, validSheetInput('Closed Sheet'));
    expect(draft.ok).toBe(true);
    const submitted = store.submitCharacterSheet(room.id, player, draft.sheet);
    expect(submitted.ok).toBe(true);
    const reviewPhase = store.updateRoomPhase(room.id, keeper, 'review');
    expect(reviewPhase.ok).toBe(true);
    expect(reviewPhase.ok ? reviewPhase.room.phase : null).toBe('review');

    expect(store.leaveRoom(room.id, player.id).ok).toBe(true);
    expect(store.leaveRoom(room.id, keeper.id).ok).toBe(true);
    vi.advanceTimersByTime(300_001);
    store.sweepExpiredRooms();
    expect(store.getRoom(room.id, keeper)?.online).toBe(false);

    expect(store.reviewCharacterSheet(room.id, keeper, submitted.sheet.id, { status: 'approved' })).toMatchObject({
      ok: false,
      error: 'Character sheets can only be reviewed during the review phase',
    });
    expect(store.getRoom(room.id, keeper)).toMatchObject({
      online: false,
      phase: 'closed',
      phaseBeforeClose: 'review',
    });
  });

  it('emits viewer-specific room states instead of generic redacted room states', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `viewer-state-owner-${suffix}@example.com`,
        displayName: 'Viewer State Owner',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `viewer-state-player-${suffix}@example.com`,
        displayName: 'Viewer State Player',
        password: '123456',
        role: 'player',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Viewer State Room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);
      expect(store.updateRoomPhase(room.id, ownerSession.account, 'chargen').ok).toBe(true);

      const socket = await connectSocket(baseUrl, playerSession.token);
      try {
        const joined = await emitAck<{ ok: true }>(socket, 'room:join', {
          roomId: room.id,
          role: 'player',
          token: playerSession.token,
        });
        expect(joined.ok).toBe(true);

        const nextState = waitForSocketEvent<{ characterSheets: Array<{ ownerId: string }> }>(socket, 'room:state');
        const saved = await api(baseUrl, `/api/rooms/${room.id}/character-sheets/me`, {
          method: 'PUT',
          token: playerSession.token,
          body: JSON.stringify(validSheetInput('Viewer State Sheet')),
        });
        expect(saved.status).toBe(200);
        await expect(nextState).resolves.toMatchObject({
          characterSheets: [expect.objectContaining({ ownerId: playerSession.account.id })],
        });
      } finally {
        socket.close();
      }
    });
  });

  it('requires joined room membership for REST room writes and derives chat identity server-side', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `rest-owner-${suffix}@example.com`,
        displayName: 'REST KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `rest-player-${suffix}@example.com`,
        displayName: 'REST Player',
        password: '123456',
      })!;
      const outsiderSession = store.registerAccount({
        email: `rest-outsider-${suffix}@example.com`,
        displayName: 'REST Outsider',
        password: '123456',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'REST security room',
        system: 'COC 7th',
      });
      const character = store.updateCharacter(room.id, {
        id: 'rest-security-character',
        name: 'REST 调查员',
        player: ownerSession.account.displayName,
        avatar: 'RT',
        hp: 10,
        maxHp: 10,
        sanity: 50,
        maxSanity: 50,
        initiative: 50,
        tags: ['调查员'],
        notes: 'REST security fixture',
      })!;
      const token = store.upsertToken(room.id, {
        id: 'rest-security-token',
        characterId: character.id,
        label: 'RT',
        color: '#187a6d',
        x: 1,
        y: 1,
        status: 'ready',
      })!;

      expect((await api(baseUrl, '/api/rooms')).status).toBe(401);
      expect((await api(baseUrl, `/api/rooms/${room.id}`)).status).toBe(401);
      expect((await api(baseUrl, `/api/rooms/${room.id}/characters`)).status).toBe(401);
      expect((await api(baseUrl, `/api/rooms/${room.id}`, { token: outsiderSession.token })).status).toBe(403);
      expect((await api(baseUrl, `/api/rooms/${room.id}/characters`, { token: outsiderSession.token })).status).toBe(403);

      expect(
        (
          await api(baseUrl, `/api/rooms/${room.id}/messages`, {
            method: 'POST',
            body: JSON.stringify({ text: 'hello' }),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await api(baseUrl, `/api/rooms/${room.id}/messages`, {
            method: 'POST',
            token: outsiderSession.token,
            body: JSON.stringify({ text: 'hello' }),
          })
        ).status,
      ).toBe(403);

      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);
      expect((await api(baseUrl, `/api/rooms/${room.id}`, { token: playerSession.token })).status).toBe(200);

      const blankChat = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ text: '   ' }),
      });
      expect(blankChat.status).toBe(400);
      expect(blankChat.body).toEqual({ error: '消息内容需为 1-2000 个字符。' });

      const tooLongChat = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ text: 'x'.repeat(2001) }),
      });
      expect(tooLongChat.status).toBe(400);
      expect(tooLongChat.body).toEqual({ error: '消息内容需为 1-2000 个字符。' });

      const chat = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ author: 'Fake KP', role: 'keeper', text: '  real text  ' }),
      });
      expect(chat.status).toBe(201);
      expect(chat.body).toMatchObject({
        author: 'REST Player',
        role: 'player',
        text: 'real text',
      });
      const reply = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ text: 'reply text', replyToId: chat.body.id }),
      });
      expect(reply.status).toBe(201);
      expect(reply.body).toMatchObject({
        replyTo: {
          id: chat.body.id,
          author: 'REST Player',
          text: 'real text',
        },
      });

      const idempotentChat = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ text: 'dedupe over rest', clientMessageId: 'rest-chat-once' }),
      });
      const retriedIdempotentChat = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ text: 'dedupe over rest retry', clientMessageId: 'rest-chat-once' }),
      });
      expect(idempotentChat.status).toBe(201);
      expect(retriedIdempotentChat.status).toBe(201);
      expect(retriedIdempotentChat.body.id).toBe(idempotentChat.body.id);
      expect(retriedIdempotentChat.body.text).toBe('dedupe over rest');

      expect(
        (
          await api(baseUrl, `/api/rooms/${room.id}/characters/${character.id}`, {
            method: 'PUT',
            body: JSON.stringify(character),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await api(baseUrl, `/api/rooms/${room.id}/characters/${character.id}`, {
            method: 'PUT',
            token: outsiderSession.token,
            body: JSON.stringify(character),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api(baseUrl, `/api/rooms/${room.id}/characters/${character.id}`, {
            method: 'PUT',
            token: ownerSession.token,
            body: JSON.stringify({ ...character, accountId: playerSession.account.id, player: 'REST Player' }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api(baseUrl, `/api/rooms/${room.id}/characters/${character.id}`, {
            method: 'PUT',
            token: playerSession.token,
            body: JSON.stringify({ ...character, player: 'REST Player', hp: character.hp - 1 }),
          })
        ).status,
      ).toBe(200);

      expect(
        (
          await api(baseUrl, `/api/rooms/${room.id}/tokens/move`, {
            method: 'POST',
            token: outsiderSession.token,
            body: JSON.stringify({ tokenId: token.id, x: 2, y: 2 }),
          })
        ).status,
      ).toBe(403);
      const moved = await api(baseUrl, `/api/rooms/${room.id}/tokens/move`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ tokenId: token.id, x: 2, y: 2 }),
      });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ id: token.id, x: 2, y: 2 });
      store.upsertToken(room.id, {
        ...token,
        x: 2,
        y: 2,
        status: 'hidden',
      });
      const hiddenMove = await api(baseUrl, `/api/rooms/${room.id}/tokens/move`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ tokenId: token.id, x: 3, y: 3 }),
      });
      expect(hiddenMove.status).toBe(403);
      expect(hiddenMove.body).toEqual({ error: 'Only the keeper can move hidden tokens' });

      expect(
        (
          await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
            method: 'POST',
            token: outsiderSession.token,
            body: JSON.stringify({ formula: '1d6' }),
          })
        ).status,
      ).toBe(403);
      const dice = await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ formula: '1d100<=100', replyToId: chat.body.id }),
      });
      expect(dice.status).toBe(201);
      expect(dice.body).toMatchObject({
        message: {
          author: 'REST Player',
          role: 'player',
          replyTo: {
            id: chat.body.id,
          },
          roll: {
            formula: '1d100<=100',
            outcome: 'success',
          },
        },
        roll: {
          formula: '1d100<=100',
          outcome: 'success',
        },
      });
      const idempotentDice = await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ formula: '1d100<=100', clientMessageId: 'rest-dice-once' }),
      });
      const retriedIdempotentDice = await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ formula: '1d100<=1', clientMessageId: 'rest-dice-once' }),
      });
      expect(idempotentDice.status).toBe(201);
      expect(retriedIdempotentDice.status).toBe(201);
      expect(retriedIdempotentDice.body.message.id).toBe(idempotentDice.body.message.id);
      expect(retriedIdempotentDice.body.roll.formula).toBe(idempotentDice.body.roll.formula);

      const importedRest = createImportedCoc7Room('rest-protected');
      const maliciousRestCharacter = {
        ...importedRest.character,
        hp: importedRest.character.hp - 2,
        accountId: outsiderSession.account.id,
        sheetId: 'forged-sheet',
        statBlock: importedRest.character.statBlock
          ? {
              ...importedRest.character.statBlock,
              accountId: outsiderSession.account.id,
              skills: {
                ...importedRest.character.statBlock.skills,
                spotHidden: 99,
              },
            }
          : undefined,
      };
      const protectedRestUpdate = await api(
        baseUrl,
        `/api/rooms/${importedRest.room.id}/characters/${importedRest.character.id}`,
        {
          method: 'PUT',
          token: importedRest.playerSession.token,
          body: JSON.stringify(maliciousRestCharacter),
        },
      );
      expect(protectedRestUpdate.status).toBe(200);
      expect(protectedRestUpdate.body).toMatchObject({
        hp: importedRest.character.hp - 2,
        accountId: importedRest.playerSession.account.id,
        sheetId: importedRest.character.sheetId,
        statBlock: {
          accountId: importedRest.playerSession.account.id,
          skills: {
            spotHidden: 45,
          },
        },
      });
      const protectedRestRoll = await api(baseUrl, `/api/rooms/${importedRest.room.id}/dice/roll`, {
        method: 'POST',
        token: importedRest.playerSession.token,
        body: JSON.stringify({ formula: '.ra 侦查' }),
      });
      expect(protectedRestRoll.status).toBe(201);
      expect(protectedRestRoll.body).toMatchObject({
        roll: {
          formula: '1d100<=45',
        },
      });
      const restImpersonator = importedRest.otherSession;
      expect(store.requestFriend(importedRest.ownerSession.account.id, restImpersonator.account.email)?.direction).toBe('outgoing');
      expect(store.acceptFriend(restImpersonator.account.id, importedRest.ownerSession.account.id)?.status).toBe('accepted');
      expect(store.inviteRoomFriend(importedRest.room.id, importedRest.ownerSession.account, restImpersonator.account.id).ok).toBe(true);
      expect(store.joinRoom(importedRest.room.id, restImpersonator.account, 'player').ok).toBe(true);
      const renamedRestImpersonator = store.updateProfile(restImpersonator.account.id, {
        displayName: importedRest.character.player,
      })!;
      const importedRestToken = importedRest.room.scene.tokens.find(
        (item) => item.characterId === importedRest.character.id,
      );
      expect(importedRestToken).toBeDefined();
      const impersonatedRestCharacter = await api(
        baseUrl,
        `/api/rooms/${importedRest.room.id}/characters/${importedRest.character.id}`,
        {
          method: 'PUT',
          token: restImpersonator.token,
          body: JSON.stringify({
            ...importedRest.character,
            player: renamedRestImpersonator.displayName,
            hp: importedRest.character.hp - 3,
          }),
        },
      );
      expect(impersonatedRestCharacter.status).toBe(403);
      const impersonatedRestToken = await api(baseUrl, `/api/rooms/${importedRest.room.id}/tokens/move`, {
        method: 'POST',
        token: restImpersonator.token,
        body: JSON.stringify({ tokenId: importedRestToken!.id, x: 4, y: 4 }),
      });
      expect(impersonatedRestToken.status).toBe(403);

      expect(
        (
          await api(baseUrl, '/api/livekit/token', {
            method: 'POST',
            body: JSON.stringify({ roomId: room.id, identity: 'Fake KP' }),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await api(baseUrl, '/api/livekit/token', {
            method: 'POST',
            token: outsiderSession.token,
            body: JSON.stringify({ roomId: room.id, identity: 'Fake KP' }),
          })
        ).status,
      ).toBe(403);
      const voice = await api(baseUrl, '/api/livekit/token', {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ roomId: room.id, identity: 'Fake KP', voiceSessionId: 'voice-session-a' }),
      });
      expect(voice.status).toBe(200);
      expect(voice.body).toMatchObject({
        configured: expect.any(Boolean),
        identity: `${playerSession.account.id}:voice-session-a`,
      });
      const secondVoice = await api(baseUrl, '/api/livekit/token', {
        method: 'POST',
        token: playerSession.token,
        body: JSON.stringify({ roomId: room.id, identity: 'Fake KP', voiceSessionId: 'voice-session-b' }),
      });
      expect(secondVoice.status).toBe(200);
      expect(secondVoice.body).toMatchObject({
        configured: expect.any(Boolean),
        identity: `${playerSession.account.id}:voice-session-b`,
      });
      expect((secondVoice.body as { identity?: string }).identity).not.toBe((voice.body as { identity?: string }).identity);
      const previousLiveKitUrl = process.env.LIVEKIT_URL;
      const previousLiveKitApiUrl = process.env.LIVEKIT_API_URL;
      const previousLiveKitKey = process.env.LIVEKIT_API_KEY;
      const previousLiveKitSecret = process.env.LIVEKIT_API_SECRET;
      process.env.LIVEKIT_URL = 'wss://livekit.example.test';
      delete process.env.LIVEKIT_API_URL;
      process.env.LIVEKIT_API_KEY = 'devkey';
      process.env.LIVEKIT_API_SECRET = 'devsecret';
      try {
        await expect(livekit.getLiveKitStatus()).resolves.toMatchObject({
          enabled: true,
          clientUrlConfigured: true,
          adminConfigured: true,
          adminUrlSource: 'LIVEKIT_URL',
          clientUrlProtocol: 'wss:',
          adminUrlProtocol: 'https:',
        });
        process.env.LIVEKIT_API_URL = 'http://livekit:7880';
        await expect(livekit.getLiveKitStatus()).resolves.toMatchObject({
          enabled: true,
          adminConfigured: true,
          adminUrlSource: 'LIVEKIT_API_URL',
          adminUrlProtocol: 'http:',
        });
        delete process.env.LIVEKIT_API_URL;
        const firstLiveKit = await api(baseUrl, '/api/livekit/token', {
          method: 'POST',
          token: playerSession.token,
          body: JSON.stringify({ roomId: room.id, voiceSessionId: 'voice-session-c' }),
        });
        expect(firstLiveKit.status).toBe(200);
        expect(firstLiveKit.body).toMatchObject({ url: 'wss://livekit.example.test' });
        expect(store.getRoom(room.id, playerSession.account)?.voice.participants).toEqual([]);
        const firstRoomName = (decodeJwtPayload(firstLiveKit.body.token as string).video as { room: string }).room;

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-05-19T04:00:00.000Z'));
        expect(store.leaveRoom(room.id, playerSession.account.id)).toMatchObject({
          ok: true,
          liveKitRoomName: firstRoomName,
        });
        expect(store.leaveRoom(room.id, ownerSession.account.id).ok).toBe(true);
        vi.setSystemTime(new Date('2026-05-19T04:05:00.001Z'));
        store.sweepExpiredRooms();
        expect(store.joinRoom(room.id, ownerSession.account, 'keeper').ok).toBe(true);
        expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);

        const secondLiveKit = await api(baseUrl, '/api/livekit/token', {
          method: 'POST',
          token: playerSession.token,
          body: JSON.stringify({ roomId: room.id, voiceSessionId: 'voice-session-d' }),
        });
        expect(secondLiveKit.status).toBe(200);
        const secondRoomName = (decodeJwtPayload(secondLiveKit.body.token as string).video as { room: string }).room;
        expect(secondRoomName).not.toBe(firstRoomName);
        expect(secondRoomName.startsWith(`${room.id}:`)).toBe(true);
      } finally {
        if (previousLiveKitUrl === undefined) {
          delete process.env.LIVEKIT_URL;
        } else {
          process.env.LIVEKIT_URL = previousLiveKitUrl;
        }
        if (previousLiveKitApiUrl === undefined) {
          delete process.env.LIVEKIT_API_URL;
        } else {
          process.env.LIVEKIT_API_URL = previousLiveKitApiUrl;
        }
        if (previousLiveKitKey === undefined) {
          delete process.env.LIVEKIT_API_KEY;
        } else {
          process.env.LIVEKIT_API_KEY = previousLiveKitKey;
        }
        if (previousLiveKitSecret === undefined) {
          delete process.env.LIVEKIT_API_SECRET;
        } else {
          process.env.LIVEKIT_API_SECRET = previousLiveKitSecret;
        }
        vi.useRealTimers();
      }

      expect(
        (
          await api(baseUrl, '/api/scripts', {
            method: 'POST',
            token: ownerSession.token,
            body: JSON.stringify({ title: 'Invalid script', maps: [{ id: 'bad' }] }),
          })
        ).status,
      ).toBe(400);
      const invalidDiceScript = await api(baseUrl, '/api/scripts', {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({
          title: 'Invalid dice script',
          diceProfiles: [{ id: 'bad-dice', label: '坏骰子', formula: 'spot hidden', probability: 0.5 }],
        }),
      });
      expect(invalidDiceScript.status).toBe(400);
      expect(JSON.stringify(invalidDiceScript.body)).toContain('骰子公式格式错误');
      const validDiceScript = await api(baseUrl, '/api/scripts', {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({
          title: 'Valid dice script',
          diceProfiles: [
            { id: 'spot-check', label: '侦查检定', formula: '1d100<=60', probability: 0.6 },
            { id: 'ability-check', label: '角色侦查', formula: '.ra 侦查', probability: 0.5 },
          ],
        }),
      });
      expect(validDiceScript.status).toBe(201);
      expect((await api(baseUrl, '/api/scripts')).status).toBe(401);
      const createdScript = await api(baseUrl, '/api/scripts', {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({ title: 'Disposable script' }),
      });
      expect(createdScript.status).toBe(201);
      expect(
        (
          await api(baseUrl, `/api/scripts/${(createdScript.body as { id: string }).id}`, {
            method: 'DELETE',
            token: ownerSession.token,
          })
        ).status,
      ).toBe(204);
    });
  });

  it('enforces script update versions through the REST API', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `script-api-owner-${suffix}@example.com`,
        displayName: 'Script API Owner',
        password: '123456',
        role: 'keeper',
      })!;
      const otherSession = store.registerAccount({
        email: `script-api-other-${suffix}@example.com`,
        displayName: 'Script API Other',
        password: '123456',
      })!;

      const created = await api(baseUrl, '/api/scripts', {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({
          title: 'API 并发剧本',
          visibility: 'public',
          summary: 'v1',
        }),
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ title: 'API 并发剧本', version: 1 });
      expect(created.body).not.toHaveProperty('ok');
      expect(created.body).not.toHaveProperty('script');

      const createdBody = created.body as { id: string; version: number };
      const listed = await api(baseUrl, '/api/scripts', { token: ownerSession.token });
      expect(listed.status).toBe(200);
      expect((listed.body as Array<{ id: string; version: number }>).find((item) => item.id === createdBody.id)?.version).toBe(
        1,
      );
      const loaded = await api(baseUrl, `/api/scripts/${createdBody.id}`, { token: ownerSession.token });
      expect(loaded.status).toBe(200);
      expect(loaded.body).toMatchObject({ id: createdBody.id, version: 1 });

      const missingVersion = await api(baseUrl, `/api/scripts/${createdBody.id}`, {
        method: 'PUT',
        token: ownerSession.token,
        body: JSON.stringify({ title: 'Missing version' }),
      });
      expect(missingVersion.status).toBe(400);

      const invalidVersion = await api(baseUrl, `/api/scripts/${createdBody.id}`, {
        method: 'PUT',
        token: ownerSession.token,
        body: JSON.stringify({ title: 'Invalid version', version: 1.5 }),
      });
      expect(invalidVersion.status).toBe(400);

      const updated = await api(baseUrl, `/api/scripts/${createdBody.id}`, {
        method: 'PUT',
        token: ownerSession.token,
        body: JSON.stringify({
          title: '服务器当前剧本',
          summary: 'v2',
          version: createdBody.version,
        }),
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        id: createdBody.id,
        title: '服务器当前剧本',
        summary: 'v2',
        version: 2,
      });
      expect(updated.body).not.toHaveProperty('ok');
      expect(updated.body).not.toHaveProperty('script');

      const stale = await api(baseUrl, `/api/scripts/${createdBody.id}`, {
        method: 'PUT',
        token: ownerSession.token,
        body: JSON.stringify({
          title: '过期草稿不应覆盖',
          summary: 'stale',
          version: createdBody.version,
        }),
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        error: 'Script version conflict',
        currentVersion: 2,
        current: {
          id: createdBody.id,
          title: '服务器当前剧本',
          summary: 'v2',
          version: 2,
        },
      });

      const afterConflict = await api(baseUrl, `/api/scripts/${createdBody.id}`, { token: ownerSession.token });
      expect(afterConflict.body).toMatchObject({
        title: '服务器当前剧本',
        summary: 'v2',
        version: 2,
      });

      const nonOwner = await api(baseUrl, `/api/scripts/${createdBody.id}`, {
        method: 'PUT',
        token: otherSession.token,
        body: JSON.stringify({ title: 'No leak', version: 2 }),
      });
      expect(nonOwner.status).toBe(404);
      expect(nonOwner.body).not.toHaveProperty('current');
      expect(nonOwner.body).not.toHaveProperty('currentVersion');
    });
  });

  it('rolls room dice profiles over REST and sockets by dice id', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `dice-id-owner-${suffix}@example.com`,
        displayName: 'Dice ID KP',
        password: '123456',
        role: 'keeper',
      })!;
      const script = store.createScript(ownerSession.account, {
        title: 'Dice ID Script',
        diceProfiles: [{ id: 'script-check', label: '剧本检定', formula: '1d100<=60', probability: 0.6 }],
      });
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Dice ID Room',
        scriptId: script.id,
      });

      const restRoll = await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({ diceId: 'script-check' }),
      });
      expect(restRoll.status).toBe(201);
      expect(restRoll.body).toMatchObject({
        roll: {
          formula: '1d100<=60',
        },
      });
      const restMissing = await api(baseUrl, `/api/rooms/${room.id}/dice/roll`, {
        method: 'POST',
        token: ownerSession.token,
        body: JSON.stringify({ diceId: 'missing-dice' }),
      });
      expect(restMissing.status).toBe(400);
      expect(restMissing.body).toMatchObject({ error: 'Dice profile not found' });

      const socket = await connectSocket(baseUrl);
      try {
        const joined = await emitAck<{ ok: true; room: { id: string } }>(socket, 'room:join', {
          roomId: room.id,
          token: ownerSession.token,
          role: 'keeper',
        });
        expect(joined.ok).toBe(true);
        const socketRoll = await emitAck<{ ok: true; data: { roll: { formula: string } } }>(socket, 'dice:roll', {
          roomId: room.id,
          token: ownerSession.token,
          diceId: 'script-check',
        });
        expect(socketRoll).toMatchObject({
          ok: true,
          data: {
            roll: {
              formula: '1d100<=60',
            },
          },
        });
        const socketMissing = await emitAck<{ ok: false; error: string }>(socket, 'dice:roll', {
          roomId: room.id,
          token: ownerSession.token,
          diceId: 'missing-dice',
        });
        expect(socketMissing).toMatchObject({ ok: false, error: 'Dice profile not found' });
      } finally {
        socket.close();
      }
    });
  });

  it('requires joined room membership for socket writes and derives chat identity server-side', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `socket-owner-${suffix}@example.com`,
        displayName: 'Socket KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `socket-player-${suffix}@example.com`,
        displayName: 'Socket Player',
        password: '123456',
      })!;
      const outsiderSession = store.registerAccount({
        email: `socket-outsider-${suffix}@example.com`,
        displayName: 'Socket Outsider',
        password: '123456',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Socket security room',
        system: 'COC 7th',
      });
      const character = store.updateCharacter(room.id, {
        id: 'socket-security-character',
        name: 'Socket 调查员',
        player: playerSession.account.displayName,
        accountId: playerSession.account.id,
        avatar: 'SK',
        hp: 10,
        maxHp: 10,
        sanity: 50,
        maxSanity: 50,
        initiative: 50,
        tags: ['调查员'],
        notes: 'Socket security fixture',
      })!;
      const token = store.upsertToken(room.id, {
        id: 'socket-security-token',
        characterId: character.id,
        label: 'SK',
        color: '#187a6d',
        x: 1,
        y: 1,
        status: 'ready',
      })!;

      const outsiderSocket = await connectSocket(baseUrl);
      try {
        const rejected = await emitAck<{ ok: false; error: string }>(outsiderSocket, 'scene:moveToken', {
          roomId: room.id,
          token: outsiderSession.token,
          tokenId: token.id,
          x: 3,
          y: 3,
        });
        expect(rejected).toMatchObject({ ok: false, error: 'Join an online room first' });
      } finally {
        outsiderSocket.close();
      }

      const socket = await connectSocket(baseUrl);
      try {
        expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
        const joined = await emitAck<{ ok: true; room: { members: Array<{ accountId: string; role: string }> } }>(
          socket,
          'room:join',
          {
            roomId: room.id,
            role: 'player',
            token: playerSession.token,
          },
        );
        expect(joined.ok).toBe(true);
        expect(joined.room.members.find((member) => member.accountId === playerSession.account.id)?.role).toBe('player');

        const blankChat = await emitAck<{ ok: false; error: unknown }>(
          socket,
          'chat:send',
          {
            roomId: room.id,
            token: playerSession.token,
            message: { text: '   ' },
          },
        );
        expect(blankChat.ok).toBe(false);

        const chat = await emitAck<{ ok: true; data: { id: string; author: string; role: string; text: string } }>(
          socket,
          'chat:send',
          {
            roomId: room.id,
            token: playerSession.token,
            message: { author: 'Fake KP', role: 'keeper', text: '  socket text  ' },
          },
        );
        expect(chat).toMatchObject({
          ok: true,
          data: {
            author: 'Socket Player',
            role: 'player',
            text: 'socket text',
          },
        });

        const reply = await emitAck<{ ok: true; data: { replyTo: { id: string; author: string; text: string } } }>(
          socket,
          'chat:send',
          {
            roomId: room.id,
            token: playerSession.token,
            message: { text: 'socket reply', replyToId: chat.data.id },
          },
        );
        expect(reply.data.replyTo).toMatchObject({
          id: chat.data.id,
          author: 'Socket Player',
          text: 'socket text',
        });

        const idempotentChat = await emitAck<{ ok: true; data: { id: string; text: string; clientMessageId?: string } }>(
          socket,
          'chat:send',
          {
            roomId: room.id,
            token: playerSession.token,
            message: { text: 'socket once', clientMessageId: 'socket-chat-once' },
          },
        );
        const retriedIdempotentChat = await emitAck<{ ok: true; data: { id: string; text: string; clientMessageId?: string } }>(
          socket,
          'chat:send',
          {
            roomId: room.id,
            token: playerSession.token,
            message: { text: 'socket retry should reuse', clientMessageId: 'socket-chat-once' },
          },
        );
        expect(retriedIdempotentChat.data.id).toBe(idempotentChat.data.id);
        expect(retriedIdempotentChat.data.text).toBe('socket once');
        expect(retriedIdempotentChat.data.clientMessageId).toBe('socket-chat-once');

        const dice = await emitAck<{ ok: true; data: { message: { author: string; role: string; replyTo: { id: string }; roll: { outcome: string } }; roll: { formula: string; outcome: string } } }>(
          socket,
          'dice:roll',
          {
            roomId: room.id,
            token: playerSession.token,
            formula: '1d100>100',
            replyToId: chat.data.id,
          },
        );
        expect(dice).toMatchObject({
          ok: true,
          data: {
            message: {
              author: 'Socket Player',
              role: 'player',
              replyTo: {
                id: chat.data.id,
              },
              roll: {
                outcome: 'failure',
              },
            },
            roll: {
              formula: '1d100>100',
              outcome: 'failure',
            },
          },
        });

        const idempotentDice = await emitAck<{ ok: true; data: { message: { id: string }; roll: { formula: string } } }>(
          socket,
          'dice:roll',
          {
            roomId: room.id,
            token: playerSession.token,
            formula: '1d100<=100',
            clientMessageId: 'socket-dice-once',
          },
        );
        const retriedIdempotentDice = await emitAck<{ ok: true; data: { message: { id: string }; roll: { formula: string } } }>(
          socket,
          'dice:roll',
          {
            roomId: room.id,
            token: playerSession.token,
            formula: '1d100<=1',
            clientMessageId: 'socket-dice-once',
          },
        );
        expect(retriedIdempotentDice.data.message.id).toBe(idempotentDice.data.message.id);
        expect(retriedIdempotentDice.data.roll.formula).toBe(idempotentDice.data.roll.formula);

        const movedToken = await emitAck<{ ok: true; data: { id: string; x: number; y: number; status: string } }>(
          socket,
          'scene:moveToken',
          {
            roomId: room.id,
            token: playerSession.token,
            tokenId: token.id,
            x: 2,
            y: 2,
          },
        );
        expect(movedToken).toMatchObject({
          ok: true,
          data: {
            id: token.id,
            x: 2,
            y: 2,
            status: 'ready',
          },
        });
        store.upsertToken(room.id, {
          ...token,
          x: 2,
          y: 2,
          status: 'hidden',
        });
        const hiddenTokenMove = await emitAck<{ ok: false; error: string }>(
          socket,
          'scene:moveToken',
          {
            roomId: room.id,
            token: playerSession.token,
            tokenId: token.id,
            x: 3,
            y: 3,
          },
        );
        expect(hiddenTokenMove).toEqual({ ok: false, error: 'Only the keeper can move hidden tokens' });

        const importedSocket = createImportedCoc7Room('socket-protected');
        const importedPlayerSocket = await connectSocket(baseUrl);
        try {
          const importedJoin = await emitAck<{ ok: true; room: { id: string } }>(importedPlayerSocket, 'room:join', {
            roomId: importedSocket.room.id,
            role: 'keeper',
            token: importedSocket.playerSession.token,
          });
          expect(importedJoin.ok).toBe(true);

          const protectedSocketUpdate = await emitAck<{
            ok: true;
            data: {
              hp: number;
              accountId: string;
              sheetId: string;
              statBlock: { accountId: string; skills: { spotHidden: number } };
            };
          }>(importedPlayerSocket, 'character:update', {
            roomId: importedSocket.room.id,
            token: importedSocket.playerSession.token,
            character: {
              ...importedSocket.character,
              hp: importedSocket.character.hp - 2,
              accountId: outsiderSession.account.id,
              sheetId: 'forged-sheet',
              statBlock: importedSocket.character.statBlock
                ? {
                    ...importedSocket.character.statBlock,
                    accountId: outsiderSession.account.id,
                    skills: {
                      ...importedSocket.character.statBlock.skills,
                      spotHidden: 99,
                    },
                  }
                : undefined,
            },
          });
          expect(protectedSocketUpdate).toMatchObject({
            ok: true,
            data: {
              hp: importedSocket.character.hp - 2,
              accountId: importedSocket.playerSession.account.id,
              sheetId: importedSocket.character.sheetId,
              statBlock: {
                accountId: importedSocket.playerSession.account.id,
                skills: {
                  spotHidden: 45,
                },
              },
            },
          });

          const protectedSocketRoll = await emitAck<{
            ok: true;
            data: { roll: { formula: string } };
          }>(importedPlayerSocket, 'dice:roll', {
            roomId: importedSocket.room.id,
            token: importedSocket.playerSession.token,
            formula: '.ra 侦查',
          });
          expect(protectedSocketRoll).toMatchObject({
            ok: true,
            data: {
              roll: {
                formula: '1d100<=45',
              },
            },
          });
        } finally {
          importedPlayerSocket.close();
        }
        const socketImpersonator = importedSocket.otherSession;
        expect(store.requestFriend(importedSocket.ownerSession.account.id, socketImpersonator.account.email)?.direction).toBe('outgoing');
        expect(store.acceptFriend(socketImpersonator.account.id, importedSocket.ownerSession.account.id)?.status).toBe('accepted');
        expect(store.inviteRoomFriend(importedSocket.room.id, importedSocket.ownerSession.account, socketImpersonator.account.id).ok).toBe(true);
        expect(store.joinRoom(importedSocket.room.id, socketImpersonator.account, 'player').ok).toBe(true);
        const renamedSocketImpersonator = store.updateProfile(socketImpersonator.account.id, {
          displayName: importedSocket.character.player,
        })!;
        const importedSocketToken = importedSocket.room.scene.tokens.find(
          (item) => item.characterId === importedSocket.character.id,
        );
        expect(importedSocketToken).toBeDefined();
        const impersonatorSocket = await connectSocket(baseUrl);
        try {
          const impersonatedSocketCharacter = await emitAck<{ ok: false; error: string }>(impersonatorSocket, 'character:update', {
            roomId: importedSocket.room.id,
            token: socketImpersonator.token,
            character: {
              ...importedSocket.character,
              player: renamedSocketImpersonator.displayName,
              hp: importedSocket.character.hp - 3,
            },
          });
          expect(impersonatedSocketCharacter).toMatchObject({
            ok: false,
            error: 'Only the keeper or assigned player can edit this character',
          });
          const impersonatedSocketToken = await emitAck<{ ok: false; error: string }>(impersonatorSocket, 'scene:moveToken', {
            roomId: importedSocket.room.id,
            token: socketImpersonator.token,
            tokenId: importedSocketToken!.id,
            x: 4,
            y: 4,
          });
          expect(impersonatedSocketToken).toMatchObject({
            ok: false,
            error: 'Only the keeper or token owner can move this token',
          });
        } finally {
          impersonatorSocket.close();
        }

        const roomStateEvents: unknown[] = [];
        socket.on('room:state', (nextRoom) => {
          roomStateEvents.push(nextRoom);
        });

        const emptyVoiceUpdate = await emitAck<{ ok: false; error: unknown }>(socket, 'voice:update', {
          roomId: room.id,
          token: playerSession.token,
        });
        expect(emptyVoiceUpdate.ok).toBe(false);

        const voiceJoinedState = waitForSocketEvent<{
          roomId: string;
          participants: Array<{ id: string; muted: boolean; speaking: boolean }>;
        }>(socket, 'voice:state');
        const voiceJoined = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string; muted: boolean; speaking: boolean }> } } }>(
          socket,
          'voice:join',
          {
            roomId: room.id,
            token: playerSession.token,
            muted: false,
          },
        );
        expect(voiceJoined.room.voice.participants).toEqual([
          expect.objectContaining({ id: playerSession.account.id, muted: false, speaking: false }),
        ]);
        await expect(voiceJoinedState).resolves.toMatchObject({
          roomId: room.id,
          participants: [expect.objectContaining({ id: playerSession.account.id, muted: false, speaking: false })],
        });

        const voiceUpdatedState = waitForSocketEvent<{
          roomId: string;
          participants: Array<{ id: string; muted: boolean; speaking: boolean; quality: string }>;
        }>(socket, 'voice:state');
        const voiceUpdated = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string; muted: boolean; speaking: boolean; quality: string }> } } }>(
          socket,
          'voice:update',
          {
            roomId: room.id,
            token: playerSession.token,
            muted: true,
            speaking: true,
            quality: 'relay',
          },
        );
        expect(voiceUpdated.room.voice.participants).toEqual([
          expect.objectContaining({ id: playerSession.account.id, muted: true, speaking: true, quality: 'relay' }),
        ]);
        await expect(voiceUpdatedState).resolves.toMatchObject({
          roomId: room.id,
          participants: [expect.objectContaining({ id: playerSession.account.id, muted: true, speaking: true, quality: 'relay' })],
        });

        const voiceLeftState = waitForSocketEvent<{
          roomId: string;
          participants: Array<{ id: string }>;
        }>(socket, 'voice:state');
        const voiceLeft = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string }> } } }>(
          socket,
          'voice:leave',
          {
            roomId: room.id,
            token: playerSession.token,
          },
        );
        expect(voiceLeft.room.voice.participants).toEqual([]);
        await expect(voiceLeftState).resolves.toMatchObject({
          roomId: room.id,
          participants: [],
        });
        expect(roomStateEvents).toHaveLength(0);

        const missingLogin = await emitAck<{ ok: false; error: string }>(socket, 'character:update', {
          roomId: room.id,
          character,
        });
        expect(missingLogin).toMatchObject({ ok: false, error: 'Login required' });
      } finally {
        socket.close();
      }
    });
  });

  it('keeps room and voice presence while the same account has another socket connected', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session = store.registerAccount({
        email: `multi-socket-${suffix}@example.com`,
        displayName: 'Multi Socket',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: session.account,
        name: 'Multi socket room',
        system: 'COC 7th',
      });

      const firstSocket = await connectSocket(baseUrl);
      const secondSocket = await connectSocket(baseUrl);
      try {
        const joinPayload = {
          roomId: room.id,
          role: 'keeper',
          token: session.token,
        };
        expect((await emitAck<{ ok: boolean }>(firstSocket, 'room:join', joinPayload)).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(secondSocket, 'room:join', joinPayload)).ok).toBe(true);
        expect(
          (
            await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string }> } } }>(
              firstSocket,
              'voice:join',
              { roomId: room.id, token: session.token },
            )
          ).room.voice.participants,
        ).toEqual([expect.objectContaining({ id: session.account.id })]);

        secondSocket.close();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const savedRoom = store.getRoom(room.id, session.account);
        expect(savedRoom?.members.map((member) => member.accountId)).toContain(session.account.id);
        expect(savedRoom?.voice.participants.map((participant) => participant.id)).toContain(session.account.id);
        expect(savedRoom?.closeAt).toBeNull();
      } finally {
        firstSocket.close();
        secondSocket.close();
      }
    });
  });

  it('keeps voice presence until the last same-account voice socket leaves', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session = store.registerAccount({
        email: `multi-voice-${suffix}@example.com`,
        displayName: 'Multi Voice',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: session.account,
        name: 'Multi voice room',
        system: 'COC 7th',
      });

      const firstSocket = await connectSocket(baseUrl);
      const secondSocket = await connectSocket(baseUrl);
      try {
        const joinPayload = {
          roomId: room.id,
          role: 'keeper',
          token: session.token,
        };
        expect((await emitAck<{ ok: boolean }>(firstSocket, 'room:join', joinPayload)).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(secondSocket, 'room:join', joinPayload)).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(firstSocket, 'voice:join', {
          roomId: room.id,
          token: session.token,
          muted: false,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(secondSocket, 'voice:join', {
          roomId: room.id,
          token: session.token,
          muted: true,
        })).ok).toBe(true);

        const firstLeftState = waitForSocketEvent<{
          roomId: string;
          participants: Array<{ id: string; muted: boolean }>;
        }>(secondSocket, 'voice:state');
        const firstLeft = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string; muted: boolean }> } } }>(
          firstSocket,
          'voice:leave',
          {
            roomId: room.id,
            token: session.token,
          },
        );
        expect(firstLeft.room.voice.participants).toEqual([
          expect.objectContaining({ id: session.account.id, muted: true }),
        ]);
        await expect(firstLeftState).resolves.toMatchObject({
          roomId: room.id,
          participants: [expect.objectContaining({ id: session.account.id, muted: true })],
        });

        const finalLeftState = waitForSocketEvent<{
          roomId: string;
          participants: Array<{ id: string }>;
        }>(firstSocket, 'voice:state');
        const finalLeft = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string }> } } }>(
          secondSocket,
          'voice:leave',
          {
            roomId: room.id,
            token: session.token,
          },
        );
        expect(finalLeft.room.voice.participants).toEqual([]);
        await expect(finalLeftState).resolves.toMatchObject({
          roomId: room.id,
          participants: [],
        });
      } finally {
        firstSocket.close();
        secondSocket.close();
      }
    });
  });

  it('aggregates speaking state across same-account voice sockets', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session = store.registerAccount({
        email: `multi-speaking-${suffix}@example.com`,
        displayName: 'Multi Speaking',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: session.account,
        name: 'Multi speaking room',
        system: 'COC 7th',
      });

      const firstSocket = await connectSocket(baseUrl);
      const secondSocket = await connectSocket(baseUrl);
      try {
        const joinPayload = {
          roomId: room.id,
          role: 'keeper',
          token: session.token,
        };
        expect((await emitAck<{ ok: boolean }>(firstSocket, 'room:join', joinPayload)).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(secondSocket, 'room:join', joinPayload)).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(firstSocket, 'voice:join', {
          roomId: room.id,
          token: session.token,
          muted: false,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(secondSocket, 'voice:join', {
          roomId: room.id,
          token: session.token,
          muted: false,
        })).ok).toBe(true);

        const firstSpeaking = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string; speaking: boolean }> } } }>(
          firstSocket,
          'voice:update',
          {
            roomId: room.id,
            token: session.token,
            speaking: true,
          },
        );
        expect(firstSpeaking.room.voice.participants).toEqual([
          expect.objectContaining({ id: session.account.id, speaking: true }),
        ]);

        const secondStillSilent = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string; speaking: boolean }> } } }>(
          secondSocket,
          'voice:update',
          {
            roomId: room.id,
            token: session.token,
            speaking: false,
          },
        );
        expect(secondStillSilent.room.voice.participants).toEqual([
          expect.objectContaining({ id: session.account.id, speaking: true }),
        ]);

        const allSilent = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string; speaking: boolean }> } } }>(
          firstSocket,
          'voice:update',
          {
            roomId: room.id,
            token: session.token,
            speaking: false,
          },
        );
        expect(allSilent.room.voice.participants).toEqual([
          expect.objectContaining({ id: session.account.id, speaking: false }),
        ]);
      } finally {
        firstSocket.close();
        secondSocket.close();
      }
    });
  });

  it('clears socket voice session state after REST leave before the next voice join', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session = store.registerAccount({
        email: `voice-rest-leave-${suffix}@example.com`,
        displayName: 'Voice REST Leave',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: session.account,
        name: 'Voice REST cleanup room',
        system: 'COC 7th',
      });

      const socket = await connectSocket(baseUrl);
      try {
        expect((await emitAck<{ ok: boolean }>(socket, 'room:join', {
          roomId: room.id,
          role: 'keeper',
          token: session.token,
        })).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(socket, 'voice:join', {
          roomId: room.id,
          token: session.token,
          muted: false,
        })).ok).toBe(true);
        const staleSpeaking = await emitAck<{ ok: true; room: { voice: { participants: Array<{ muted: boolean; quality: string; speaking: boolean }> } } }>(
          socket,
          'voice:update',
          {
            roomId: room.id,
            token: session.token,
            muted: true,
            speaking: true,
            quality: 'relay',
          },
        );
        expect(staleSpeaking.room.voice.participants).toEqual([
          expect.objectContaining({ muted: true, quality: 'relay', speaking: true }),
        ]);

        const left = await api(baseUrl, `/api/rooms/${room.id}/leave`, {
          method: 'POST',
          token: session.token,
        });
        expect(left.status).toBe(200);

        const rejectedStaleUpdate = await emitAck<{ ok: false; error: string }>(socket, 'voice:update', {
          roomId: room.id,
          token: session.token,
          speaking: true,
        });
        expect(rejectedStaleUpdate).toMatchObject({ ok: false, error: 'Join voice first' });

        const rejoined = await api(baseUrl, `/api/rooms/${room.id}/join`, {
          method: 'POST',
          token: session.token,
          body: JSON.stringify({ role: 'keeper' }),
        });
        expect(rejoined.status).toBe(200);
        const nextVoiceJoin = await emitAck<{ ok: true; room: { voice: { participants: Array<{ muted: boolean; quality: string; speaking: boolean }> } } }>(
          socket,
          'voice:join',
          {
            roomId: room.id,
            token: session.token,
            muted: false,
          },
        );
        expect(nextVoiceJoin.room.voice.participants).toEqual([
          expect.objectContaining({ muted: false, quality: 'excellent', speaking: false }),
        ]);
      } finally {
        socket.close();
      }
    });
  });

  it('binds voice-only sockets to the room before broadcasting voice state', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `voice-bind-owner-${suffix}@example.com`,
        displayName: 'Voice Bind KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `voice-bind-player-${suffix}@example.com`,
        displayName: 'Voice Bind Player',
        password: '123456',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Voice bind room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);
      expect(store.joinRoom(room.id, playerSession.account, 'player').ok).toBe(true);

      const playerSocket = await connectSocket(baseUrl, playerSession.token);
      try {
        const voiceState = waitForSocketEvent<{
          roomId: string;
          participants: Array<{ id: string; muted: boolean }>;
        }>(playerSocket, 'voice:state');
        const joined = await emitAck<{ ok: true; room: { voice: { participants: Array<{ id: string; muted: boolean }> } } }>(
          playerSocket,
          'voice:join',
          {
            roomId: room.id,
            token: playerSession.token,
            muted: false,
          },
        );
        expect(joined.room.voice.participants).toEqual([
          expect.objectContaining({ id: playerSession.account.id, muted: false }),
        ]);
        await expect(voiceState).resolves.toMatchObject({
          roomId: room.id,
          participants: [expect.objectContaining({ id: playerSession.account.id, muted: false })],
        });
      } finally {
        playerSocket.close();
      }
    });
  });

  it('removes account sockets from room broadcasts after leaving through REST', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `rest-leave-owner-${suffix}@example.com`,
        displayName: 'REST Leave KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `rest-leave-player-${suffix}@example.com`,
        displayName: 'REST Leave Player',
        password: '123456',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'REST leave socket room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);

      const playerSocket = await connectSocket(baseUrl);
      try {
        const joined = await emitAck<{ ok: true; room: { id: string } }>(playerSocket, 'room:join', {
          roomId: room.id,
          role: 'player',
          token: playerSession.token,
        });
        expect(joined.ok).toBe(true);

        const leave = await api(baseUrl, `/api/rooms/${room.id}/leave`, {
          method: 'POST',
          token: playerSession.token,
        });
        expect(leave.status).toBe(200);

        const leakedMessage = waitForNoSocketEvent(playerSocket, 'chat:message');
        const sent = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: 'message after REST leave' }),
        });
        expect(sent.status).toBe(201);
        await expect(leakedMessage).resolves.toBeNull();
      } finally {
        playerSocket.close();
      }
    });
  });

  it('removes stale sockets from room broadcasts after an expired room sweep closes the room', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `sweep-stale-owner-${suffix}@example.com`,
        displayName: 'Sweep Stale KP',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Sweep stale socket room',
        system: 'COC 7th',
      });

      const socket = await connectSocket(baseUrl);
      try {
        const joined = await emitAck<{ ok: true; room: { id: string } }>(socket, 'room:join', {
          roomId: room.id,
          role: 'keeper',
          token: ownerSession.token,
        });
        expect(joined.ok).toBe(true);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-05-19T04:00:00.000Z'));
        expect(store.disconnectRoomMember(room.id, ownerSession.account.id).ok).toBe(true);
        vi.setSystemTime(new Date('2026-05-19T04:05:00.001Z'));
        const closedEvent = waitForSocketEvent<{ id: string; online: boolean }>(socket, 'room:closed');
        const triggerSweep = await api(baseUrl, '/api/rooms', {
          token: ownerSession.token,
        });
        expect(triggerSweep.status).toBe(200);
        const closedPayload = await closedEvent;
        expect(closedPayload).toMatchObject({ id: room.id, online: false });
        expect(closedPayload).not.toHaveProperty('scene');
        expect(closedPayload).not.toHaveProperty('characters');
        expect(closedPayload).not.toHaveProperty('messages');
        vi.useRealTimers();

        const reopened = await api(baseUrl, `/api/rooms/${room.id}/join`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ role: 'keeper' }),
        });
        expect(reopened.status).toBe(200);

        const leakedMessage = waitForNoSocketEvent<ChatMessage>(socket, 'chat:message');
        const sent = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: 'message after sweep close and reopen' }),
        });
        expect(sent.status).toBe(201);
        await expect(leakedMessage).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
        socket.close();
      }
    });
  });

  it('notifies same-account sockets when the account leaves a room through socket', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session = store.registerAccount({
        email: `socket-left-${suffix}@example.com`,
        displayName: 'Socket Left User',
        password: '123456',
        role: 'keeper',
      })!;
      const room = store.createRoom({
        owner: session.account,
        name: 'Socket left room',
        system: 'COC 7th',
      });

      const firstSocket = await connectSocket(baseUrl, session.token);
      const secondSocket = await connectSocket(baseUrl, session.token);
      try {
        const joinPayload = {
          roomId: room.id,
          role: 'keeper',
          token: session.token,
        };
        expect((await emitAck<{ ok: boolean }>(firstSocket, 'room:join', joinPayload)).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(secondSocket, 'room:join', joinPayload)).ok).toBe(true);

        const leftEvent = waitForSocketEvent<{ roomId: string }>(secondSocket, 'room:left');
        const left = await emitAck<{ ok: true; room: { id: string } }>(firstSocket, 'room:leave', {
          roomId: room.id,
          token: session.token,
        });
        expect(left.ok).toBe(true);
        await expect(leftEvent).resolves.toEqual({ roomId: room.id });
      } finally {
        firstSocket.close();
        secondSocket.close();
      }
    });
  });

  it('includes roomId on room chat socket broadcasts', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `chat-roomid-owner-${suffix}@example.com`,
        displayName: 'Chat RoomId KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `chat-roomid-player-${suffix}@example.com`,
        displayName: 'Chat RoomId Player',
        password: '123456',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Chat room id socket room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);

      const playerSocket = await connectSocket(baseUrl);
      try {
        const joined = await emitAck<{ ok: true; room: { id: string } }>(playerSocket, 'room:join', {
          roomId: room.id,
          role: 'player',
          token: playerSession.token,
        });
        expect(joined.ok).toBe(true);

        const nextMessage = waitForSocketEvent<ChatMessage>(playerSocket, 'chat:message');
        const sent = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: 'message with room id' }),
        });
        expect(sent.status).toBe(201);
        await expect(nextMessage).resolves.toMatchObject({
          roomId: room.id,
          text: 'message with room id',
        });
      } finally {
        playerSocket.close();
      }
    });
  });

  it('removes all account sockets from room broadcasts after leaving through socket', async () => {
    await withServer(async (baseUrl) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerSession = store.registerAccount({
        email: `socket-leave-owner-${suffix}@example.com`,
        displayName: 'Socket Leave KP',
        password: '123456',
        role: 'keeper',
      })!;
      const playerSession = store.registerAccount({
        email: `socket-leave-player-${suffix}@example.com`,
        displayName: 'Socket Leave Player',
        password: '123456',
      })!;
      const room = store.createRoom({
        owner: ownerSession.account,
        name: 'Socket leave multi client room',
        system: 'COC 7th',
      });
      expect(enterRecruiting(room.id, ownerSession.account).ok).toBe(true);

      const firstSocket = await connectSocket(baseUrl);
      const secondSocket = await connectSocket(baseUrl);
      try {
        const joinPayload = {
          roomId: room.id,
          role: 'player',
          token: playerSession.token,
        };
        expect((await emitAck<{ ok: boolean }>(firstSocket, 'room:join', joinPayload)).ok).toBe(true);
        expect((await emitAck<{ ok: boolean }>(secondSocket, 'room:join', joinPayload)).ok).toBe(true);

        const left = await emitAck<{ ok: true; room: { id: string } }>(firstSocket, 'room:leave', {
          roomId: room.id,
          token: playerSession.token,
        });
        expect(left.ok).toBe(true);

        const leakedMessage = waitForNoSocketEvent<ChatMessage>(secondSocket, 'chat:message');
        const sent = await api(baseUrl, `/api/rooms/${room.id}/messages`, {
          method: 'POST',
          token: ownerSession.token,
          body: JSON.stringify({ text: 'message after socket leave' }),
        });
        expect(sent.status).toBe(201);
        await expect(leakedMessage).resolves.toBeNull();
      } finally {
        firstSocket.close();
        secondSocket.close();
      }
    });
  });
});

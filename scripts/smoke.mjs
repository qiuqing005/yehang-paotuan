import dns from 'node:dns';
import { io as ioClient } from 'socket.io-client';

const backendBaseUrl = process.env.SMOKE_BACKEND_URL ?? 'http://localhost:8787';
const frontendBaseUrl = process.env.SMOKE_FRONTEND_URL ?? 'http://localhost:5173';
const useCloudMail = process.env.SMOKE_REQUIRE_CLOUD_MAIL === 'true';
const cloudMailBaseUrl = process.env.SMOKE_CLOUD_MAIL_BASE_URL ?? 'https://mail.example.com';
const cloudMailEmail = process.env.SMOKE_CLOUD_MAIL_EMAIL ?? '';
const cloudMailPassword = process.env.SMOKE_CLOUD_MAIL_PASSWORD ?? '';
const cloudMailToken = process.env.SMOKE_CLOUD_MAIL_TOKEN ?? '';
const emailDomain = process.env.SMOKE_EMAIL_DOMAIN ?? 'example.com';
const resolveIp = process.env.SMOKE_RESOLVE_IP ?? '';
const resolveHosts = new Set(
  (process.env.SMOKE_RESOLVE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
);

if (resolveIp) {
  const backendHost = new URL(backendBaseUrl).hostname;
  const frontendHost = new URL(frontendBaseUrl).hostname;
  const forcedHosts = resolveHosts.size > 0 ? resolveHosts : new Set([backendHost, frontendHost]);
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

const summary = {
  backendBaseUrl,
  frontendBaseUrl,
  checks: {},
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();

  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { response, json };
}

async function requestVerificationCode(baseUrl, email) {
  const result = await requestJson(baseUrl, '/api/auth/verification-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  assert(result.response.status === 202, `/api/auth/verification-code returned ${result.response.status}`);
  return result.json;
}

async function cloudMailLogin() {
  if (cloudMailToken) {
    return cloudMailToken;
  }

  assert(cloudMailEmail && cloudMailPassword, 'Cloud Mail login credentials are required');
  const response = await requestJson(cloudMailBaseUrl, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: cloudMailEmail, password: cloudMailPassword }),
  });
  assert(response.response.ok, `/api/login returned ${response.response.status}`);
  assert(response.json?.code === 200, `/api/login failed: ${response.json?.message ?? 'unknown error'}`);
  assert(typeof response.json?.data?.token === 'string', 'Cloud Mail login missing token');
  return response.json.data.token;
}

async function cloudMailCreateMailbox(token, email) {
  const result = await requestJson(cloudMailBaseUrl, '/api/account/add', {
    method: 'POST',
    headers: {
      Authorization: token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  assert(result.response.ok, `/api/account/add returned ${result.response.status}`);
  assert(result.json?.code === 200, `/api/account/add failed: ${result.json?.message ?? 'unknown error'}`);
  return result.json;
}

async function cloudMailLatestMail(token, email) {
  const result = await requestJson(
    cloudMailBaseUrl,
    `/api/allEmail/list?type=receive&accountEmail=${encodeURIComponent(email)}&size=1`,
    {
      headers: { Authorization: token },
    },
  );

  assert(result.response.ok, `/api/allEmail/list returned ${result.response.status}`);
  assert(result.json?.code === 200, `/api/allEmail/list failed: ${result.json?.message ?? 'unknown error'}`);
  return result.json?.data?.list?.[0] ?? null;
}

async function waitForCloudMailCode(token, email, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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

function auth(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function connectSocket(token) {
  const socket = ioClient(backendBaseUrl, {
    auth: token ? { token } : undefined,
    transports: ['websocket'],
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function emitAck(socket, event, payload, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForSocketEvent(socket, event, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`${event} event timed out`));
    }, timeoutMs);
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });
}

async function checkHealth() {
  const { response, json } = await requestJson(backendBaseUrl, '/health');
  assert(response.ok, `/health returned ${response.status}`);
  assert(json?.ok === true, '/health missing ok=true');
  assert(json?.service === 'paotuan-server', '/health missing service');
  assert(!('emailDelivery' in json), '/health should not expose email delivery details');

  summary.checks.health = {
    status: response.status,
    service: json.service,
  };

  return json;
}

async function checkHealthDetails(token) {
  const checkLiveKitAdmin = process.env.SMOKE_CHECK_LIVEKIT_ADMIN === 'true';
  const path = checkLiveKitAdmin ? '/api/health/details?checkLiveKit=1' : '/api/health/details';
  const { response, json } = await requestJson(backendBaseUrl, path, {
    headers: auth(token),
  });
  assert(response.ok, `/api/health/details returned ${response.status}`);
  assert(typeof json?.livekitEnabled === 'boolean', '/health missing livekitEnabled');
  assert(typeof json?.livekit?.enabled === 'boolean', '/health missing livekit.enabled');
  assert(typeof json?.livekit?.adminConfigured === 'boolean', '/health missing livekit.adminConfigured');
  assert(typeof json?.livekit?.cleanup?.attemptedCount === 'number', '/health missing livekit.cleanup.attemptedCount');
  assert(typeof json?.livekit?.cleanup?.failedCount === 'number', '/health missing livekit.cleanup.failedCount');
  assert(typeof json?.livekit?.cleanup?.pendingCount === 'number', '/health missing livekit.cleanup.pendingCount');
  if (json.livekit.cleanup.lastFailure) {
    assert(typeof json.livekit.cleanup.lastFailure.at === 'string', '/health livekit.cleanup.lastFailure missing at');
    assert(typeof json.livekit.cleanup.lastFailure.error === 'string', '/health livekit.cleanup.lastFailure missing error');
    assert(typeof json.livekit.cleanup.lastFailure.operation === 'string', '/health livekit.cleanup.lastFailure missing operation');
    assert(typeof json.livekit.cleanup.lastFailure.trigger === 'string', '/health livekit.cleanup.lastFailure missing trigger');
    assert(!('roomName' in json.livekit.cleanup.lastFailure), '/health livekit.cleanup.lastFailure should not expose roomName');
    assert(!('accountId' in json.livekit.cleanup.lastFailure), '/health livekit.cleanup.lastFailure should not expose accountId');
  }
  assert(typeof json?.emailDeliveryEnabled === 'boolean', '/health missing emailDeliveryEnabled');
  assert(typeof json?.emailDelivery?.provider === 'string', '/health missing emailDelivery.provider');
  if (checkLiveKitAdmin && json.livekit.enabled) {
    assert(json.livekit.adminConfigured === true, '/health livekit.adminConfigured is not true');
    assert(json.livekit.adminReachable === true, `/health livekit admin is not reachable: ${json.livekit.adminError ?? 'unknown error'}`);
  }
  if (process.env.SMOKE_REQUIRE_SMTP === 'true') {
    assert(json.emailDelivery.smtpVerified === true, '/health emailDelivery.smtpVerified is not true');
  }
  if (useCloudMail) {
    assert(json.emailDelivery.provider === 'cloud-mail', '/health emailDelivery.provider is not cloud-mail');
    assert(json.emailDelivery.cloudMailVerified === true, '/health cloud mail is not verified');
  }

  summary.checks.healthDetails = {
    status: response.status,
    livekitEnabled: json.livekitEnabled,
    livekit: json.livekit,
    emailDeliveryEnabled: json.emailDeliveryEnabled,
    emailDelivery: json.emailDelivery,
  };

  return json;
}

async function registerUser(prefix, role = 'player') {
  const safePrefix = prefix.replace(/[^a-z0-9]/gi, '').slice(0, useCloudMail ? 6 : 24) || 'smoke';
  const suffix = useCloudMail
    ? `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${safePrefix}-${suffix}@${emailDomain}`;
  const password = `pass-${suffix}`;
  const displayName = `${prefix} ${suffix}`;
  let cloudMailTokenForInbox = null;
  if (useCloudMail) {
    cloudMailTokenForInbox = await cloudMailLogin();
    await cloudMailCreateMailbox(cloudMailTokenForInbox, email);
  }
  const verification = await requestVerificationCode(backendBaseUrl, email);
  let verificationCode = verification?.debugCode ?? process.env.SMOKE_VERIFICATION_CODE ?? '';
  if (!verificationCode && useCloudMail) {
    verificationCode = await waitForCloudMailCode(cloudMailTokenForInbox, email);
  }
  assert(/^\d{6}$/.test(verificationCode), 'verification code missing or invalid');

  const result = await requestJson(backendBaseUrl, '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      displayName,
      verificationCode,
      role,
    }),
  });

  assert(result.response.status === 201, `/api/auth/register returned ${result.response.status}`);
  assert(typeof result.json?.token === 'string' && result.json.token.length > 0, 'register missing token');
  assert(result.json?.account?.email === email, 'register returned unexpected email');

  return {
    email,
    password,
    token: result.json.token,
    account: result.json.account,
  };
}

async function checkAuthAndProfile() {
  const user = await registerUser('smoke-user');

  const loginResult = await requestJson(backendBaseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      password: user.password,
    }),
  });

  assert(loginResult.response.ok, `/api/auth/login returned ${loginResult.response.status}`);
  assert(typeof loginResult.json?.token === 'string' && loginResult.json.token.length > 0, 'login missing token');

  const profileResult = await requestJson(backendBaseUrl, '/api/profile', {
    method: 'PATCH',
    headers: auth(loginResult.json.token),
    body: JSON.stringify({
      displayName: 'Smoke Renamed',
      avatar: 'SR',
    }),
  });

  assert(profileResult.response.ok, `/api/profile returned ${profileResult.response.status}`);
  assert(profileResult.json?.displayName === 'Smoke Renamed', 'profile did not update displayName');

  summary.checks.auth = {
    registerStatus: 201,
    loginStatus: loginResult.response.status,
    profileStatus: profileResult.response.status,
  };

  return {
    ...user,
    token: loginResult.json.token,
    account: profileResult.json,
  };
}

async function checkFriendsAndPrivateRooms() {
  const owner = await registerUser('smoke-owner', 'keeper');
  const friend = await registerUser('smoke-friend');
  const outsider = await registerUser('smoke-outsider');

  const requestResult = await requestJson(backendBaseUrl, '/api/friends', {
    method: 'POST',
    headers: auth(friend.token),
    body: JSON.stringify({ email: owner.email }),
  });
  assert(requestResult.response.status === 201, `/api/friends returned ${requestResult.response.status}`);

  const acceptResult = await requestJson(backendBaseUrl, `/api/friends/${friend.account.id}/accept`, {
    method: 'POST',
    headers: auth(owner.token),
  });
  assert(acceptResult.response.ok, `/api/friends/:id/accept returned ${acceptResult.response.status}`);
  assert(acceptResult.json?.status === 'accepted', 'friendship was not accepted');

  const roomResult = await requestJson(backendBaseUrl, '/api/rooms', {
    method: 'POST',
    headers: auth(owner.token),
    body: JSON.stringify({
      name: 'Smoke Private Room',
      system: 'COC 7th',
      visibility: 'private',
    }),
  });
  assert(roomResult.response.status === 201, `/api/rooms POST returned ${roomResult.response.status}`);
  assert(roomResult.json?.visibility === 'private', 'created room is not private');

  const preparationResult = await requestJson(backendBaseUrl, `/api/rooms/${roomResult.json.id}/preparation`, {
    method: 'PATCH',
    headers: auth(owner.token),
    body: JSON.stringify({
      summary: 'Smoke private room recruitment premise.',
      scriptCharacters: [
        {
          id: 'smoke-investigator',
          name: 'Smoke Investigator',
          count: 4,
          occupation: 'Reporter',
          publicSummary: 'A player-facing investigator role for smoke testing.',
          story: 'Has a clear reason to join the private investigation.',
          parameters: '',
          privateBrief: '',
          recommendedSkills: [],
        },
      ],
    }),
  });
  assert(preparationResult.response.ok, `/api/rooms/:id/preparation returned ${preparationResult.response.status}`);

  const recruitingResult = await requestJson(backendBaseUrl, `/api/rooms/${roomResult.json.id}/phase`, {
    method: 'PATCH',
    headers: auth(owner.token),
    body: JSON.stringify({ phase: 'recruiting' }),
  });
  assert(recruitingResult.response.ok, `/api/rooms/:id/phase recruiting returned ${recruitingResult.response.status}`);

  const outsiderJoin = await requestJson(backendBaseUrl, `/api/rooms/${roomResult.json.id}/join`, {
    method: 'POST',
    headers: auth(outsider.token),
  });
  assert(outsiderJoin.response.status === 403, 'outsider should not join private room');

  const friendJoin = await requestJson(backendBaseUrl, `/api/rooms/${roomResult.json.id}/join`, {
    method: 'POST',
    headers: auth(friend.token),
  });
  assert(friendJoin.response.ok, `/api/rooms/:id/join returned ${friendJoin.response.status}`);

  for (let index = 1; index <= 25; index += 1) {
    const directResult = await requestJson(backendBaseUrl, `/api/friends/${friend.account.id}/messages`, {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({
        text: `Smoke direct ${String(index).padStart(2, '0')}`,
        clientMessageId: `smoke-direct-${index}`,
      }),
    });
    assert(directResult.response.status === 201, `/api/friends/:id/messages returned ${directResult.response.status}`);
  }
  const latestDirect = await requestJson(backendBaseUrl, `/api/friends/${owner.account.id}/messages?limit=20`, {
    headers: auth(friend.token),
  });
  assert(latestDirect.response.ok, `/api/friends/:id/messages?limit returned ${latestDirect.response.status}`);
  assert(latestDirect.json?.messages?.length === 20, 'direct latest page should contain 20 messages');
  assert(latestDirect.json.messages[0].text === 'Smoke direct 06', 'direct latest page should start at message 06');
  assert(latestDirect.json.hasMore === true, 'direct latest page should report more history');

  const olderDirect = await requestJson(
    backendBaseUrl,
    `/api/friends/${owner.account.id}/messages?limit=20&before=${encodeURIComponent(latestDirect.json.messages[0].id)}`,
    { headers: auth(friend.token) },
  );
  assert(olderDirect.response.ok, `/api/friends/:id/messages older returned ${olderDirect.response.status}`);
  assert(olderDirect.json?.messages?.[0]?.text === 'Smoke direct 01', 'direct older page should include message 01');

  const readVisible = await requestJson(backendBaseUrl, `/api/friends/${owner.account.id}/messages/read`, {
    method: 'POST',
    headers: auth(friend.token),
    body: JSON.stringify({ lastReadMessageId: latestDirect.json.messages.at(-1).id }),
  });
  assert(readVisible.response.ok, `/api/friends/:id/messages/read returned ${readVisible.response.status}`);
  assert(readVisible.json?.unreadCount === 0, 'direct unread count should be cleared after read cursor');

  summary.checks.friendsAndRooms = {
    friendRequestStatus: requestResult.response.status,
    acceptStatus: acceptResult.response.status,
    privateRoomStatus: roomResult.response.status,
    outsiderJoinStatus: outsiderJoin.response.status,
    friendJoinStatus: friendJoin.response.status,
    directLatestCount: latestDirect.json.messages.length,
    directOlderCount: olderDirect.json.messages.length,
    directUnreadAfterRead: readVisible.json.unreadCount,
  };

  return { friend, owner, room: roomResult.json };
}

async function deleteRoom(token, roomId) {
  const result = await requestJson(backendBaseUrl, `/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  assert(result.response.status === 200, `/api/rooms/${roomId} DELETE returned ${result.response.status}`);
}

async function deleteScript(token, scriptId) {
  const result = await requestJson(backendBaseUrl, `/api/scripts/${scriptId}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  assert(result.response.status === 204, `/api/scripts/${scriptId} DELETE returned ${result.response.status}`);
}

async function checkScripts(owner) {
  const createResult = await requestJson(backendBaseUrl, '/api/scripts', {
    method: 'POST',
    headers: auth(owner.token),
    body: JSON.stringify({
      title: 'Smoke Script',
      system: 'COC 7th',
      visibility: 'private',
      summary: 'Smoke editable script',
      maps: [{ id: 'map-smoke', name: 'Smoke Map', width: 10, height: 8, notes: 'test' }],
      characters: [{ id: 'sc-smoke', name: 'NPC', count: 2, parameters: 'HP 8', publicSummary: 'Smoke public role', story: 'test' }],
      diceProfiles: [{ id: 'dice-smoke', label: 'Check', formula: '1d100', probability: 0.5 }],
      chapters: [
        {
          id: 'chapter-smoke',
          title: 'Start',
          blocks: [{ id: 'block-smoke', type: 'narrative', title: 'Text', markdown: 'Hello' }],
        },
      ],
    }),
  });
  assert(createResult.response.status === 201, `/api/scripts POST returned ${createResult.response.status}`);

  const importResult = await requestJson(backendBaseUrl, '/api/scripts/import', {
    method: 'POST',
    headers: auth(owner.token),
    body: JSON.stringify({
      title: 'Imported Smoke Script',
      system: 'COC 7th',
      rawText: 'Chapter one\nA useful clue is on the table.',
    }),
  });
  assert(importResult.response.status === 201, `/api/scripts/import returned ${importResult.response.status}`);

  const listResult = await requestJson(backendBaseUrl, '/api/scripts', {
    headers: auth(owner.token),
  });
  assert(listResult.response.ok, `/api/scripts returned ${listResult.response.status}`);
  assert(Array.isArray(listResult.json), '/api/scripts did not return an array');
  assert(listResult.json.some((script) => script.id === createResult.json.id), 'created script missing from list');

  summary.checks.scripts = {
    createStatus: createResult.response.status,
    importStatus: importResult.response.status,
    count: listResult.json.length,
  };

  await deleteScript(owner.token, createResult.json.id);
  await deleteScript(owner.token, importResult.json.id);
}

async function checkLiveKit(roomId, token, voiceSessionId, livekitEnabled) {
  const { response, json } = await requestJson(backendBaseUrl, '/api/livekit/token', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ roomId, voiceSessionId }),
  });

  assert(response.ok, `/api/livekit/token returned ${response.status}`);
  assert(typeof json?.configured === 'boolean', '/api/livekit/token missing configured');
  assert(String(json?.identity ?? '').endsWith(`:${voiceSessionId}`), '/api/livekit/token identity missing voiceSessionId');
  assert(typeof json?.roomName === 'string' && json.roomName.length > 0, '/api/livekit/token missing roomName');

  if (livekitEnabled === false) {
    assert(json.configured === false, '/api/livekit/token should return configured=false when LiveKit is disabled');
  } else if (json.configured === true) {
    assert(typeof json?.token === 'string' && json.token.length > 0, 'configured LiveKit response missing token');
    assert(typeof json?.url === 'string' && json.url.length > 0, 'configured LiveKit response missing url');
  }

  summary.checks.livekit = {
    status: response.status,
    configured: json.configured,
  };
}

async function checkDirectLiveKit(owner, friend, room, livekitEnabled) {
  const callId = `smoke-direct-${Date.now().toString(36)}`;
  const beforeAccept = await requestJson(backendBaseUrl, '/api/livekit/direct-token', {
    method: 'POST',
    headers: auth(owner.token),
    body: JSON.stringify({ friendId: friend.account.id, callId, voiceSessionId: 'smokedir0' }),
  });
  assert(beforeAccept.response.status === 404, `/api/livekit/direct-token before invite returned ${beforeAccept.response.status}`);

  const ownerSocket = await connectSocket(owner.token);
  const friendSocket = await connectSocket(friend.token);
  try {
    const invite = await emitAck(ownerSocket, 'direct-call:invite', {
      token: owner.token,
      friendId: friend.account.id,
      callId,
    });
    assert(invite?.ok === true, `direct-call:invite failed: ${JSON.stringify(invite)}`);

    const ringingToken = await requestJson(backendBaseUrl, '/api/livekit/direct-token', {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({ friendId: friend.account.id, callId, voiceSessionId: 'smokedir1' }),
    });
    assert(ringingToken.response.status === 403, `/api/livekit/direct-token while ringing returned ${ringingToken.response.status}`);

    const roomVoiceJoin = await emitAck(ownerSocket, 'voice:join', {
      token: owner.token,
      roomId: room.id,
      muted: true,
    });
    assert(roomVoiceJoin?.ok === true, `voice:join before direct-ready failed: ${JSON.stringify(roomVoiceJoin)}`);

    const accepted = await emitAck(friendSocket, 'direct-call:accept', {
      token: friend.token,
      friendId: owner.account.id,
      callId,
    });
    assert(accepted?.ok === true, `direct-call:accept failed: ${JSON.stringify(accepted)}`);

    const readyBeforeToken = await requestJson(backendBaseUrl, '/api/livekit/direct-ready', {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({ friendId: friend.account.id, callId }),
    });
    assert(readyBeforeToken.response.status === 403, `/api/livekit/direct-ready before token returned ${readyBeforeToken.response.status}`);

    const ownerVoice = await requestJson(backendBaseUrl, '/api/livekit/direct-token', {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({ friendId: friend.account.id, callId, voiceSessionId: 'smokedir2' }),
    });
    const friendVoice = await requestJson(backendBaseUrl, '/api/livekit/direct-token', {
      method: 'POST',
      headers: auth(friend.token),
      body: JSON.stringify({ friendId: owner.account.id, callId, voiceSessionId: 'smokedir3' }),
    });
    assert(ownerVoice.response.ok, `/api/livekit/direct-token owner returned ${ownerVoice.response.status}`);
    assert(friendVoice.response.ok, `/api/livekit/direct-token friend returned ${friendVoice.response.status}`);
    assert(ownerVoice.json?.configured === friendVoice.json?.configured, 'direct LiveKit configured mismatch');
    assert(ownerVoice.json?.roomName === friendVoice.json?.roomName, 'direct LiveKit peers should share roomName');
    assert(String(ownerVoice.json?.roomName ?? '').startsWith('direct:'), 'direct LiveKit roomName should use direct prefix');
    assert(String(ownerVoice.json?.identity ?? '').includes(owner.account.id), 'owner direct identity missing account id');
    assert(String(friendVoice.json?.identity ?? '').includes(friend.account.id), 'friend direct identity missing account id');
    assert(String(ownerVoice.json?.identity ?? '').endsWith(':smokedir2'), 'owner direct identity missing voiceSessionId');
    assert(String(friendVoice.json?.identity ?? '').endsWith(':smokedir3'), 'friend direct identity missing voiceSessionId');
    if (livekitEnabled === false) {
      assert(ownerVoice.json?.configured === false, 'direct LiveKit should return configured=false when LiveKit is disabled');
    } else if (ownerVoice.json?.configured === true) {
      assert(typeof ownerVoice.json?.token === 'string' && ownerVoice.json.token.length > 0, 'direct LiveKit owner missing token');
      assert(typeof ownerVoice.json?.url === 'string' && ownerVoice.json.url.length > 0, 'direct LiveKit owner missing url');
    }

    if (ownerVoice.json?.configured !== true) {
      const readyAfterToken = await requestJson(backendBaseUrl, '/api/livekit/direct-ready', {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ friendId: friend.account.id, callId }),
      });
      assert(
        readyAfterToken.response.status === 403,
        `/api/livekit/direct-ready without configured LiveKit returned ${readyAfterToken.response.status}`,
      );
      const roomAfterBlockedReady = await requestJson(backendBaseUrl, `/api/rooms/${room.id}`, {
        headers: auth(owner.token),
      });
      assert(roomAfterBlockedReady.response.ok, `/api/rooms/${room.id} after blocked direct-ready returned ${roomAfterBlockedReady.response.status}`);
      assert(
        roomAfterBlockedReady.json?.voice?.participants?.some?.((participant) => participant.id === owner.account.id),
        'blocked direct-ready should keep owner in room voice participants',
      );

      const roomVoiceAfterBlockedReady = await requestJson(backendBaseUrl, '/api/livekit/token', {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ roomId: room.id, voiceSessionId: 'smokeroomblocked' }),
      });
      assert(
        roomVoiceAfterBlockedReady.response.ok,
        `/api/livekit/token after blocked direct-ready returned ${roomVoiceAfterBlockedReady.response.status}`,
      );

      const ended = await emitAck(ownerSocket, 'direct-call:end', {
        token: owner.token,
        friendId: friend.account.id,
        callId,
      });
      assert(ended?.ok === true, `direct-call:end failed: ${JSON.stringify(ended)}`);

      const roomVoiceAfterEnd = await requestJson(backendBaseUrl, '/api/livekit/token', {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ roomId: room.id, voiceSessionId: 'smokeroomended' }),
      });
      assert(roomVoiceAfterEnd.response.ok, `/api/livekit/token after direct-call:end returned ${roomVoiceAfterEnd.response.status}`);
      assert(String(roomVoiceAfterEnd.json?.identity ?? '').endsWith(':smokeroomended'), 'room voice identity after direct-call:end missing session id');

      summary.checks.directLivekit = {
        beforeInviteStatus: beforeAccept.response.status,
        ringingStatus: ringingToken.response.status,
        status: ownerVoice.response.status,
        configured: ownerVoice.json.configured,
        readyBeforeTokenStatus: readyBeforeToken.response.status,
        readyAfterTokenStatus: readyAfterToken.response.status,
        roomVoiceAfterReadyStatus: roomVoiceAfterBlockedReady.response.status,
        roomVoiceAfterEndStatus: roomVoiceAfterEnd.response.status,
      };
      return;
    }

    const voiceCleared = waitForSocketEvent(ownerSocket, 'voice:state');
    const readyAfterConfiguredToken = await requestJson(backendBaseUrl, '/api/livekit/direct-ready', {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({ friendId: friend.account.id, callId }),
    });
    assert(readyAfterConfiguredToken.response.ok, `/api/livekit/direct-ready after token returned ${readyAfterConfiguredToken.response.status}`);
    const voiceState = await voiceCleared;
    assert(voiceState?.roomId === room.id, 'direct-ready voice:state used unexpected room id');
    assert(
      !voiceState?.participants?.some?.((participant) => participant.id === owner.account.id),
      'direct-ready should remove owner from room voice participants',
    );

    const roomVoiceAfterReady = await requestJson(backendBaseUrl, '/api/livekit/token', {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({ roomId: room.id, voiceSessionId: 'smokeroomready' }),
    });
    assert(roomVoiceAfterReady.response.status === 403, `/api/livekit/token after direct-ready returned ${roomVoiceAfterReady.response.status}`);

    const ended = await emitAck(ownerSocket, 'direct-call:end', {
      token: owner.token,
      friendId: friend.account.id,
      callId,
    });
    assert(ended?.ok === true, `direct-call:end failed: ${JSON.stringify(ended)}`);

    const roomVoiceAfterEnd = await requestJson(backendBaseUrl, '/api/livekit/token', {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({ roomId: room.id, voiceSessionId: 'smokeroomended' }),
    });
    assert(roomVoiceAfterEnd.response.ok, `/api/livekit/token after direct-call:end returned ${roomVoiceAfterEnd.response.status}`);
    assert(String(roomVoiceAfterEnd.json?.identity ?? '').endsWith(':smokeroomended'), 'room voice identity after direct-call:end missing session id');

    const roomVoiceRejoin = await emitAck(ownerSocket, 'voice:join', {
      token: owner.token,
      roomId: room.id,
      muted: true,
    });
    assert(roomVoiceRejoin?.ok === true, `voice:join after direct-call:end failed: ${JSON.stringify(roomVoiceRejoin)}`);

    summary.checks.directLivekit = {
      beforeInviteStatus: beforeAccept.response.status,
      ringingStatus: ringingToken.response.status,
      status: ownerVoice.response.status,
      configured: ownerVoice.json.configured,
      readyBeforeTokenStatus: readyBeforeToken.response.status,
      readyAfterTokenStatus: readyAfterConfiguredToken.response.status,
      roomVoiceAfterReadyStatus: roomVoiceAfterReady.response.status,
      roomVoiceAfterEndStatus: roomVoiceAfterEnd.response.status,
    };
  } finally {
    ownerSocket.close();
    friendSocket.close();
  }
}

async function checkManifest() {
  const { response, json } = await requestJson(frontendBaseUrl, '/site.webmanifest');
  assert(response.ok, `/site.webmanifest returned ${response.status}`);
  assert(json?.name === '夜航跑团桌', '/site.webmanifest has unexpected name');
  assert(Array.isArray(json?.icons), '/site.webmanifest missing icons');

  summary.checks.manifest = {
    status: response.status,
    iconCount: json.icons.length,
  };
}

async function main() {
  await checkHealth();
  const authUser = await checkAuthAndProfile();
  const health = await checkHealthDetails(authUser.token);
  const { friend, owner, room } = await checkFriendsAndPrivateRooms();

  await checkScripts(owner);
  await checkLiveKit(room.id, owner.token, 'smokeroom0', health.livekitEnabled);
  await checkDirectLiveKit(owner, friend, room, health.livekitEnabled);
  await deleteRoom(owner.token, room.id);
  await checkManifest();

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, ...summary })}\n`);
  process.exit(1);
});

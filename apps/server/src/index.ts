import http from 'node:http';
import { randomInt } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { corsOrigin } from './cors-config.js';
import { isDiceFormulaSupported, rollDiceFormula } from './dice.js';
import { checkInteractionWriteRateLimit, interactionRateLimitError } from './interaction-rate-limit.js';
import {
  closeLiveKitRoom,
  getLiveKitCleanupStatus,
  getLiveKitStatus,
  issueLiveKitToken,
  observeLiveKitCleanup,
  removeLiveKitParticipantsByAccount,
} from './livekit.js';
import {
  getEmailDeliveryStatus,
  isEmailDeliveryEnabled,
  sendPasswordResetVerificationMail,
  sendRegistrationVerificationMail,
} from './mailer.js';
import { createSlidingWindowRateLimit, type RateLimitResult } from './rate-limit.js';
import { roomCharacterSchema } from './room-schemas.js';
import { registerSocketServer } from './socket.js';
import { store } from './store.js';
import type { Character } from './types.js';

export const app = express();

app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '2mb' }));

const avatarMaxLength = 300000;
const clientMessageIdSchema = z.string().trim().min(1).max(120).optional();
type RoomMembership = NonNullable<ReturnType<typeof store.getRoomMembership>>;

const getBearerToken = (authorization: string | undefined) => {
  if (!authorization?.startsWith('Bearer ')) {
    return undefined;
  }

  return authorization.slice('Bearer '.length);
};

function accountFromRequest(req: express.Request) {
  return store.getAccountByToken(getBearerToken(req.headers.authorization));
}

function requireAccount(req: express.Request, res: express.Response) {
  const account = accountFromRequest(req);
  if (!account) {
    res.status(401).json({ error: 'Login required' });
    return null;
  }
  return account;
}

function emitFriendState(...accountIds: string[]) {
  new Set(accountIds.filter(Boolean)).forEach((accountId) => {
    io.to(`account:${accountId}`).emit('friends:changed', store.listFriends(accountId));
  });
}

function emitPendingDirectCallEndedEvents() {
  store.sweepExpiredDirectCalls().forEach((event) => {
    const { liveKitRoomName, ...clientEvent } = event;
    io.to(`account:${event.fromId}`).to(`account:${event.toId}`).emit('direct-call:ended', clientEvent);
    observeLiveKitCleanup(closeLiveKitRoom(liveKitRoomName), {
      operation: 'close-room',
      trigger: 'expired-direct-call',
    });
  });
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function requestAddress(req: express.Request) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

const checkVerificationCodeRateLimit = createSlidingWindowRateLimit({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 20,
});
const checkLoginRateLimit = createSlidingWindowRateLimit({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 10,
});

function requireRoomMembership(req: express.Request, res: express.Response) {
  const account = requireAccount(req, res);
  if (!account) {
    return null;
  }

  const roomId = routeParam(req.params.roomId);
  if (!roomId) {
    res.status(400).json({ error: 'Room id is required' });
    return null;
  }

  const membership = store.getRoomMembership(roomId, account);
  broadcastExpiredRoomClosures();
  if (!membership) {
    const room = store.getRoom(roomId, account);
    broadcastExpiredRoomClosures();
    res.status(room ? 403 : 404).json({ error: room ? 'Join an online room first' : 'Room not found' });
    return null;
  }

  return membership;
}

function requireRoomDataAccess(req: express.Request, res: express.Response) {
  const account = requireAccount(req, res);
  if (!account) {
    return null;
  }

  const roomId = routeParam(req.params.roomId);
  if (!roomId) {
    res.status(400).json({ error: 'Room id is required' });
    return null;
  }

  const room = store.getRoom(roomId, account);
  broadcastExpiredRoomClosures();
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return null;
  }
  if (room.online && !room.memberIds.includes(account.id)) {
    res.status(403).json({ error: 'Join room first' });
    return null;
  }

  return { account, room };
}

function emitRoomState(roomId: string) {
  const room = store.getRoomBroadcastState(roomId);
  if (room) {
    store.getRoomViewerStates(room.id).forEach((viewer) => {
      io.to(`account:${viewer.accountId}`).emit('room:state', viewer.room);
    });
  }
  return room;
}

function closedRoomEvent(room: { id: string; online?: boolean; closedAt?: string | null }) {
  return {
    id: room.id,
    roomId: room.id,
    online: false,
    closedAt: room.closedAt ?? null,
  };
}

function broadcastExpiredRoomClosures() {
  const closedRooms = store.sweepExpiredRooms();
  if (closedRooms.length === 0) {
    return;
  }
  closedRooms.forEach((room) => {
    observeLiveKitCleanup(closeLiveKitRoom(room.liveKitRoomName), {
      operation: 'close-room',
      trigger: 'http-expired-room',
    });
    io.clearRoomVoiceSessions(room.id);
    emitRoomState(room.id);
    io.emitRoomVoiceState(room.id);
    io.to(room.id).emit('room:closed', closedRoomEvent(room));
    io.in(room.id).socketsLeave(room.id);
  });
  io.emit('rooms:changed');
}

app.use((_req, res, next) => {
  let drained = false;
  const drainClosedRooms = () => {
    if (drained) {
      return;
    }
    drained = true;
    broadcastExpiredRoomClosures();
  };

  res.once('finish', drainClosedRooms);
  res.once('close', drainClosedRooms);
  next();
});

function canEditCharacter(membership: RoomMembership, characterId: string) {
  if (membership.room.ownerId === membership.member.accountId) {
    return true;
  }

  const character = membership.room.characters.find((item) => item.id === characterId);
  return character?.accountId === membership.member.accountId;
}

function canMoveToken(membership: RoomMembership, tokenId: string) {
  const token = membership.room.scene.tokens.find((item) => item.id === tokenId);
  if (!token) {
    return { ok: false as const, status: 404, error: 'Room or token not found' };
  }
  if (membership.room.ownerId === membership.member.accountId) {
    return { ok: true as const };
  }
  if (token.status === 'hidden') {
    return { ok: false as const, status: 403, error: 'Only the keeper can move hidden tokens' };
  }

  const character = membership.room.characters.find((item) => item.id === token.characterId);
  const ownsCharacter = character?.accountId === membership.member.accountId;
  if (!ownsCharacter) {
    return { ok: false as const, status: 403, error: 'Only the keeper or token owner can move this token' };
  }

  return { ok: true as const };
}

function sanitizePlayerCharacterUpdate(membership: RoomMembership, character: Character): Character {
  if (membership.room.ownerId === membership.member.accountId) {
    return character;
  }

  const existing = membership.room.characters.find((item) => item.id === character.id);
  return {
    ...character,
    accountId: existing?.accountId,
    sheetId: existing?.sheetId,
    statBlock: existing?.statBlock,
    player: membership.member.displayName,
  };
}

async function healthDetails(options: { checkLiveKitAdmin?: boolean } = {}) {
  const livekit = await getLiveKitStatus({ checkAdmin: options.checkLiveKitAdmin });
  return {
    livekitEnabled: livekit.enabled,
    livekit: {
      ...livekit,
      cleanup: getLiveKitCleanupStatus(),
    },
    emailDeliveryEnabled: isEmailDeliveryEnabled(),
    emailDelivery: await getEmailDeliveryStatus(),
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'paotuan-server',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health/details', async (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  res.json({
    ok: true,
    service: 'paotuan-server',
    timestamp: new Date().toISOString(),
    ...(await healthDetails({
      checkLiveKitAdmin: req.query.checkLiveKit === '1' || req.query.checkLiveKitAdmin === '1',
    })),
  });
});

const verificationCodeSchema = z.object({
  email: z.string().trim().email().max(120),
});

const registerSchema = z.object({
  email: z.string().trim().email().max(120),
  displayName: z.string().trim().min(1).max(40),
  password: z.string().min(6).max(80),
  verificationCode: z.string().trim().regex(/^\d{6}$/),
  avatar: z.string().trim().max(avatarMaxLength).optional(),
  role: z.enum(['keeper', 'player']).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(120),
  password: z.string().min(6).max(80),
});

const resetPasswordSchema = z.object({
  email: z.string().trim().email().max(120),
  password: z.string().min(6).max(80),
  verificationCode: z.string().trim().regex(/^\d{6}$/),
});

function makeVerificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

app.post('/api/auth/verification-code', async (req, res) => {
  const parsed = verificationCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const rateLimit = checkVerificationCodeRateLimit(
    `${requestAddress(req)}:${parsed.data.email.toLowerCase()}`,
  );
  if (!rateLimit.ok) {
    res.status(429).json({
      error: 'Too many verification code requests',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const code = makeVerificationCode();
  const request = store.issueRegistrationCode(parsed.data.email, code);
  if (!request.ok) {
    const status = request.error === 'Email already exists' ? 409 : 429;
    res.status(status).json({
      error: request.error,
      retryAfterSeconds: 'retryAfterSeconds' in request ? request.retryAfterSeconds : undefined,
    });
    return;
  }

  const mail = await sendRegistrationVerificationMail({
    to: request.email,
    code,
    expiresInMinutes: Math.floor(store.emailVerificationPolicy.ttlSeconds / 60),
  });
  if (!mail.ok) {
    console.error('[verification-email] failed', {
      provider: mail.provider,
      error: mail.error,
    });
    store.deleteRegistrationCode(request.email);
    res.status(503).json({ error: 'Verification email could not be sent' });
    return;
  }

  res.status(202).json({
    ok: true,
    expiresInSeconds: store.emailVerificationPolicy.ttlSeconds,
    cooldownSeconds: store.emailVerificationPolicy.cooldownSeconds,
    debugCode: process.env.NODE_ENV === 'production' ? undefined : mail.debugCode,
  });
});

app.post('/api/auth/register', (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const verified = store.verifyRegistrationCode(parsed.data.email, parsed.data.verificationCode);
  if (!verified.ok) {
    res.status(400).json({ error: verified.error });
    return;
  }

  const { verificationCode: _verificationCode, ...accountInput } = parsed.data;
  const session = store.registerAccount({
    ...accountInput,
    role: accountInput.role ?? 'player',
  });

  if (!session) {
    res.status(409).json({ error: 'Email already exists' });
    return;
  }

  res.status(201).json(session);
});

app.post('/api/auth/password-reset-code', async (req, res) => {
  const parsed = verificationCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const rateLimit = checkVerificationCodeRateLimit(
    `reset:${requestAddress(req)}:${parsed.data.email.toLowerCase()}`,
  );
  if (!rateLimit.ok) {
    res.status(429).json({
      error: 'Too many verification code requests',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const code = makeVerificationCode();
  const request = store.issuePasswordResetCode(parsed.data.email, code);
  if (!request.ok) {
    const status = request.error === 'Account not found' ? 404 : 429;
    res.status(status).json({
      error: request.error,
      retryAfterSeconds: 'retryAfterSeconds' in request ? request.retryAfterSeconds : undefined,
    });
    return;
  }

  const mail = await sendPasswordResetVerificationMail({
    to: request.email,
    code,
    expiresInMinutes: Math.floor(store.emailVerificationPolicy.ttlSeconds / 60),
  });
  if (!mail.ok) {
    console.error('[password-reset-email] failed', {
      provider: mail.provider,
      error: mail.error,
    });
    store.deleteRegistrationCode(request.email);
    res.status(503).json({ error: 'Verification email could not be sent' });
    return;
  }

  res.status(202).json({
    ok: true,
    expiresInSeconds: store.emailVerificationPolicy.ttlSeconds,
    cooldownSeconds: store.emailVerificationPolicy.cooldownSeconds,
    debugCode: process.env.NODE_ENV === 'production' ? undefined : mail.debugCode,
  });
});

app.post('/api/auth/reset-password', (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const result = store.resetPassword(parsed.data);
  if (!result.ok) {
    res.status(result.error === 'Account not found' ? 404 : 400).json({ error: result.error });
    return;
  }

  io.revokeAccountSockets(result.account.id);
  res.status(204).end();
});

app.post('/api/auth/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const loginRateLimitKey = `${requestAddress(req)}:${parsed.data.email.toLowerCase()}`;
  const rateLimit = checkLoginRateLimit(loginRateLimitKey, { record: false });
  if (!rateLimit.ok) {
    res.status(429).json({
      error: 'Too many login attempts',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const session = store.loginAccount(parsed.data);
  if (!session) {
    checkLoginRateLimit(loginRateLimitKey);
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  res.json(session);
});

app.get('/api/auth/session', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  res.json(account);
});

app.post('/api/auth/logout', (req, res) => {
  const token = getBearerToken(req.headers.authorization);
  const account = store.getAccountByToken(token);
  store.revokeSession(token);
  if (account) {
    io.revokeAccountSockets(account.id, { token });
  }
  res.status(204).send();
});

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  avatar: z.string().trim().max(avatarMaxLength).optional(),
  password: z.string().min(6).max(80).optional(),
  currentPassword: z.string().min(6).max(80).optional(),
});

app.patch('/api/profile', (req, res) => {
  const token = getBearerToken(req.headers.authorization);
  const account = store.getAccountByToken(token);
  if (!account) {
    res.status(401).json({ error: 'Login required' });
    return;
  }

  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (parsed.data.password) {
    if (!parsed.data.currentPassword) {
      res.status(400).json({ error: 'Current password is required' });
      return;
    }
    if (!store.verifyAccountPassword(account.id, parsed.data.currentPassword)) {
      res.status(403).json({ error: 'Current password is incorrect' });
      return;
    }
  }

  const { currentPassword: _currentPassword, ...profileInput } = parsed.data;
  const nextAccount = store.updateProfile(account.id, profileInput);
  if (!nextAccount) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  if (profileInput.password) {
    store.revokeAccountSessions(account.id, token);
    io.revokeAccountSockets(account.id, { exceptToken: token });
  }

  emitFriendState(account.id, ...store.listFriends(account.id).map((friend) => friend.id));
  const affectedRoomIds = store.listAccountRoomIds(account.id);
  affectedRoomIds.forEach((roomId) => emitRoomState(roomId));
  if (affectedRoomIds.length > 0) {
    affectedRoomIds.forEach((roomId) => io.emitRoomVoiceState(roomId));
    io.emit('rooms:changed');
  }
  res.json(nextAccount);
});

app.get('/api/friends', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  res.json(store.listFriends(account.id));
});

const friendRequestSchema = z.object({
  email: z.string().trim().email().max(120),
});

app.post('/api/friends', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = friendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const friend = store.requestFriend(account.id, parsed.data.email);
  if (!friend) {
    res.status(404).json({ error: 'Target user not found' });
    return;
  }

  emitFriendState(account.id, friend.id);
  res.status(201).json(friend);
});

app.post('/api/friends/:friendId/accept', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const friend = store.acceptFriend(account.id, req.params.friendId);
  if (!friend) {
    res.status(404).json({ error: 'Friend request not found' });
    return;
  }

  emitFriendState(account.id, friend.id);
  res.json(friend);
});

app.delete('/api/friends/:friendId', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  if (!store.removeFriend(account.id, req.params.friendId)) {
    res.status(404).json({ error: 'Friend not found' });
    return;
  }

  emitFriendState(account.id, req.params.friendId);
  emitPendingDirectCallEndedEvents();
  res.status(204).end();
});

const directMessageSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  clientMessageId: clientMessageIdSchema,
  replyToId: z.string().trim().min(1).max(80).optional(),
});
const messageContentValidationError = '消息内容需为 1-2000 个字符。';

const directReadSchema = z.object({
  lastReadMessageId: z.string().trim().min(1).max(80).optional(),
});

const directMessageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().trim().min(1).optional(),
});

app.get('/api/friends/:friendId/messages', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = directMessageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (parsed.data.limit || parsed.data.before) {
    const page = store.listDirectMessagePage(account.id, req.params.friendId, parsed.data);
    if (!page) {
      res.status(403).json({ error: 'Friend access required' });
      return;
    }

    res.json(page);
    return;
  }

  const messages = store.listDirectMessages(account.id, req.params.friendId);
  if (!messages) {
    res.status(403).json({ error: 'Friend access required' });
    return;
  }

  res.json(messages);
});

app.post('/api/friends/:friendId/messages/read', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = directReadSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const friend = store.markDirectMessagesRead(account.id, req.params.friendId, parsed.data.lastReadMessageId);
  if (!friend) {
    res.status(403).json({ error: 'Friend access required' });
    return;
  }

  emitFriendState(account.id);
  res.json(friend);
});

app.post('/api/friends/:friendId/messages', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = directMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: messageContentValidationError });
    return;
  }

  if (!store.canMessageFriend(account.id, req.params.friendId)) {
    res.status(403).json({ error: 'Friend access required' });
    return;
  }

  const existingMessage = store.getDirectMessageByClientMessageId(
    account.id,
    req.params.friendId,
    parsed.data.clientMessageId,
  );
  if (existingMessage) {
    io.to(`account:${account.id}`).to(`account:${req.params.friendId}`).emit('direct:message', existingMessage);
    emitFriendState(account.id, req.params.friendId);
    res.status(201).json(existingMessage);
    return;
  }

  const reply = store.getDirectMessageReference(account.id, req.params.friendId, parsed.data.replyToId);
  if (!reply.ok) {
    res.status(reply.error === 'Friend access required' ? 403 : 400).json({ error: reply.error });
    return;
  }

  const rateLimit = checkInteractionWriteRateLimit({
    accountId: account.id,
    kind: 'direct-message',
  });
  if (!rateLimit.ok) {
    res.status(429).json({
      error: interactionRateLimitError('direct-message'),
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const message = store.addDirectMessage(
    account.id,
    req.params.friendId,
    parsed.data.text,
    parsed.data.clientMessageId,
    reply.replyTo,
  );
  if (!message) {
    res.status(403).json({ error: 'Friend access required' });
    return;
  }

  io.to(`account:${account.id}`).to(`account:${req.params.friendId}`).emit('direct:message', message);
  emitFriendState(account.id, req.params.friendId);
  res.status(201).json(message);
});

app.get('/api/rooms', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const status = req.query.status === 'closed' ? 'closed' : 'online';
  const rooms = store.listRooms(account, { status });
  broadcastExpiredRoomClosures();
  res.json(rooms);
});

const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(80),
  system: z.string().trim().min(1).max(80).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  scriptId: z.string().trim().min(1).optional(),
});

const inviteRoomSchema = z.object({
  friendId: z.string().trim().min(1),
});

app.post('/api/rooms', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = createRoomSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (store.getActiveMemberRoom(account.id)) {
    res.status(409).json({ error: 'Leave the active room before creating another room' });
    return;
  }

  const room = store.createRoom({ ...parsed.data, owner: account });
  io.emit('rooms:changed');
  res.status(201).json(room);
});

app.post('/api/rooms/:roomId/join', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = z.object({
    resume: z.boolean().optional(),
    role: z.enum(['keeper', 'player']).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const result = store.joinRoom(req.params.roomId, account, parsed.data.role, {
    openClosed: parsed.data.resume ? false : undefined,
  });
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    const status = result.error === 'Room not found' ? 404 : result.error === 'Room is closed' ? 409 : 403;
    res.status(status).json({ error: result.error });
    return;
  }

  const room = result.room;
  if (!room) {
    res.status(500).json({ error: 'Room state missing' });
    return;
  }
  emitRoomState(room.id);
  io.emit('rooms:changed');
  res.json(room);
});

app.post('/api/rooms/:roomId/leave', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const result = store.leaveRoom(req.params.roomId, account.id);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' ? 404 : 403).json({ error: result.error });
    return;
  }

  const room = result.room;
  if (!room) {
    res.status(500).json({ error: 'Room state missing' });
    return;
  }
  if (result.liveKitRoomName) {
    observeLiveKitCleanup(removeLiveKitParticipantsByAccount(result.liveKitRoomName, account.id), {
      operation: 'remove-account-participants',
      trigger: 'room-leave',
    });
  }
  io.clearAccountRoomVoiceSessions(room.id, account.id);
  io.to(`account:${account.id}`).emit('room:left', { roomId: room.id });
  io.in(`account:${account.id}`).socketsLeave(room.id);
  emitRoomState(room.id);
  io.emitRoomVoiceState(room.id);
  io.emit('rooms:changed');
  res.json(room);
});

app.post('/api/rooms/:roomId/close', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const result = store.closeRoom(req.params.roomId, account.id);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    const status = result.error === 'Room not found' ? 404 : result.error === 'Room is closed' ? 409 : 403;
    res.status(status).json({ error: result.error });
    return;
  }

  if (result.liveKitRoomName) {
    observeLiveKitCleanup(closeLiveKitRoom(result.liveKitRoomName), {
      operation: 'close-room',
      trigger: 'room-owner-close',
    });
  }
  io.clearRoomVoiceSessions(req.params.roomId);
  emitRoomState(req.params.roomId);
  io.emitRoomVoiceState(req.params.roomId);
  io.to(req.params.roomId).emit('room:closed', closedRoomEvent(result.room));
  io.in(req.params.roomId).socketsLeave(req.params.roomId);
  io.emit('rooms:changed');
  res.json(result.room);
});

app.post('/api/rooms/:roomId/invitations', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = inviteRoomSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const result = store.inviteRoomFriend(req.params.roomId, account, parsed.data.friendId);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Not found' ? 404 : 403).json({ error: result.error });
    return;
  }

  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.json(result.room);
});

app.delete('/api/rooms/:roomId', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const roomLiveKitName = store.getRoomLiveKitVoiceRoomName(req.params.roomId);
  const result = store.deleteRoom(req.params.roomId, account.id);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' ? 404 : 403).json({ error: result.error });
    return;
  }

  if (result.deleted) {
    observeLiveKitCleanup(closeLiveKitRoom(roomLiveKitName), {
      operation: 'close-room',
      trigger: 'room-delete',
    });
    io.clearRoomVoiceSessions(req.params.roomId);
    io.emitRoomVoiceState(req.params.roomId);
    io.to(req.params.roomId).emit('room:deleted', { roomId: req.params.roomId });
    io.in(req.params.roomId).socketsLeave(req.params.roomId);
  }
  io.emit('rooms:changed');
  res.json({ deleted: Boolean(result.deleted) });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const access = requireRoomDataAccess(req, res);
  if (!access) {
    return;
  }

  res.json(access.room);
});

const phaseSchema = z.object({
  phase: z.enum(['module_locked', 'module_editing', 'recruiting', 'chargen', 'review', 'casting', 'playing', 'closed']),
});

const recommendedSkillSchema = z.object({
  name: z.string().trim().min(1).max(80),
  base: z.number().int().min(0).max(100),
});

const roomScriptCharacterSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  count: z.number().int().min(1).max(20),
  parameters: z.string().max(4000),
  story: z.string().max(8000),
  occupation: z.string().trim().max(80).optional(),
  publicSummary: z.string().max(2000).optional(),
  privateBrief: z.string().max(4000).optional(),
  recommendedSkills: z.array(recommendedSkillSchema).max(20).optional(),
});

const roomPreparationSchema = z.object({
  summary: z.string().max(4000).optional(),
  scriptCharacters: z.array(roomScriptCharacterSchema).max(60).optional(),
});

const roomScriptBlockRevealSchema = z.object({
  chapterId: z.string().trim().min(1).max(120),
  blockId: z.string().trim().min(1).max(120),
});

const roomScriptMapSchema = z.object({
  mapId: z.string().trim().min(1).max(120),
});

app.patch('/api/rooms/:roomId/phase', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const parsed = phaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = store.updateRoomPhase(req.params.roomId, account, parsed.data.phase);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' ? 404 : 403).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.json(result.room);
});

app.patch('/api/rooms/:roomId/preparation', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const parsed = roomPreparationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = store.updateRoomPreparation(req.params.roomId, account, parsed.data);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' ? 404 : 403).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.json(result.room);
});

app.post('/api/rooms/:roomId/script-blocks/reveal', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const parsed = roomScriptBlockRevealSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = store.revealRoomScriptBlock(req.params.roomId, account, parsed.data);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    const status = result.error === '房间不存在' ? 404 : 403;
    res.status(status).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.json(result.room);
});

app.patch('/api/rooms/:roomId/script-map', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const parsed = roomScriptMapSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = store.switchRoomScriptMap(req.params.roomId, account, parsed.data);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    const status = result.error === '房间不存在' ? 404 : 403;
    res.status(status).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.json(result.room);
});

const coc7AttributesSchema = z.object({
  str: z.number().int(),
  con: z.number().int(),
  siz: z.number().int(),
  dex: z.number().int(),
  app: z.number().int(),
  int: z.number().int(),
  pow: z.number().int(),
  edu: z.number().int(),
  luck: z.number().int(),
});

const coc7SkillSchema = z.object({
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  base: z.number().int().min(0).max(100),
  occupation: z.number().int().min(0).max(100),
  interest: z.number().int().min(0).max(100),
  growth: z.number().int().min(0).max(100).optional().default(0),
});

const coc7BackgroundSchema = z.object({
  description: z.string().max(8000).default(''),
  ideology: z.string().max(1000).default(''),
  significantPeople: z.string().max(1000).default(''),
  locations: z.string().max(1000).default(''),
  possessions: z.string().max(1000).default(''),
  traits: z.string().max(1000).default(''),
});

const sheetPayloadSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  scriptCharacterId: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120),
  occupation: z.string().trim().min(1).max(80),
  age: z.number().int().min(15).max(90),
  sex: z.string().max(40).default(''),
  residence: z.string().max(120).default(''),
  birthplace: z.string().max(120).default(''),
  attributes: coc7AttributesSchema,
  skills: z.array(coc7SkillSchema).min(1).max(120),
  background: coc7BackgroundSchema,
});

app.put('/api/rooms/:roomId/character-sheets/me', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const parsed = sheetPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = store.upsertCharacterSheet(req.params.roomId, account, parsed.data);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' ? 404 : 403).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  res.json(result);
});

app.post('/api/rooms/:roomId/character-sheets/me/submit', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const parsed = sheetPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = store.submitCharacterSheet(req.params.roomId, account, parsed.data);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' ? 404 : 403).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.status(201).json(result);
});

app.post('/api/rooms/:roomId/character-sheets/me/confirm', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const result = store.confirmCharacterSheet(req.params.roomId, account);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' || result.error === 'Character sheet not found' ? 404 : 403).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.json(result);
});

const sheetReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reviewerNotes: z.string().max(4000).optional(),
});

app.patch('/api/rooms/:roomId/character-sheets/:sheetId/review', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const parsed = sheetReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = store.reviewCharacterSheet(req.params.roomId, account, req.params.sheetId, parsed.data);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' || result.error === 'Character sheet not found' ? 404 : 403).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.json(result);
});

app.post('/api/rooms/:roomId/character-sheets/import-approved', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const result = store.importApprovedSheets(req.params.roomId, account);
  broadcastExpiredRoomClosures();
  if (!result.ok) {
    res.status(result.error === 'Room not found' ? 404 : 403).json({ error: result.error });
    return;
  }
  emitRoomState(result.room.id);
  io.emit('rooms:changed');
  res.json(result.room);
});

const messageSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  replyToId: z.string().trim().min(1).max(80).optional(),
  clientMessageId: clientMessageIdSchema,
});

const roomMessageQuerySchema = directMessageQuerySchema;

app.get('/api/rooms/:roomId/messages', (req, res) => {
  const access = requireRoomDataAccess(req, res);
  if (!access) {
    return;
  }

  const parsed = roomMessageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const page = store.listRoomMessagePage(access.room.id, access.account, parsed.data);
  if (!page) {
    res.status(403).json({ error: 'Join room first' });
    return;
  }
  res.json(page);
});

app.post('/api/rooms/:roomId/messages', (req, res) => {
  const membership = requireRoomMembership(req, res);
  if (!membership) {
    return;
  }

  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: messageContentValidationError });
    return;
  }

  const existingMessage = store.getRoomMessageByClientMessageId(membership.room.id, parsed.data.clientMessageId, {
    senderId: membership.member.accountId,
    messageType: 'chat',
  });
  if (existingMessage) {
    io.to(membership.room.id).emit('chat:message', existingMessage);
    res.status(201).json(existingMessage);
    return;
  }

  const reply = store.getRoomMessageReference(membership.room.id, parsed.data.replyToId);
  if (!reply.ok) {
    res.status(400).json({ error: reply.error });
    return;
  }

  const rateLimit = checkInteractionWriteRateLimit({
    accountId: membership.member.accountId,
    kind: 'room-chat',
  });
  if (!rateLimit.ok) {
    res.status(429).json({
      error: interactionRateLimitError('room-chat'),
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const message = store.addMessage(membership.room.id, {
    clientMessageId: parsed.data.clientMessageId,
    senderId: membership.member.accountId,
    messageType: 'chat',
    author: membership.member.displayName,
    role: membership.member.role,
    text: parsed.data.text,
    replyTo: reply.replyTo,
  });
  if (!message) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  io.to(membership.room.id).emit('chat:message', message);
  res.status(201).json(message);
});

app.get('/api/rooms/:roomId/characters', (req, res) => {
  const access = requireRoomDataAccess(req, res);
  if (!access) {
    return;
  }

  res.json(access.room.characters);
});

const characterSchema = roomCharacterSchema;

app.put('/api/rooms/:roomId/characters/:characterId', (req, res) => {
  const membership = requireRoomMembership(req, res);
  if (!membership) {
    return;
  }

  const parsed = characterSchema.safeParse({
    ...req.body,
    id: req.params.characterId,
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (!canEditCharacter(membership, parsed.data.id)) {
    res.status(403).json({ error: 'Only the keeper or assigned player can edit this character' });
    return;
  }

  const character = store.updateCharacter(membership.room.id, sanitizePlayerCharacterUpdate(membership, parsed.data));
  if (!character) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  emitRoomState(membership.room.id);
  res.json(character);
});

const tokenMoveSchema = z.object({
  tokenId: z.string().min(1),
  x: z.number(),
  y: z.number(),
});

app.post('/api/rooms/:roomId/tokens/move', (req, res) => {
  const membership = requireRoomMembership(req, res);
  if (!membership) {
    return;
  }

  const parsed = tokenMoveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const permission = canMoveToken(membership, parsed.data.tokenId);
  if (!permission.ok) {
    res.status(permission.status).json({ error: permission.error });
    return;
  }

  const token = store.moveToken(membership.room.id, parsed.data.tokenId, parsed.data.x, parsed.data.y);
  if (!token) {
    res.status(404).json({ error: 'Room or token not found' });
    return;
  }

  emitRoomState(membership.room.id);
  res.json(token);
});

const diceRollSchema = z.object({
  formula: z.string().trim().min(2).max(80).optional(),
  diceId: z.string().trim().min(1).max(80).optional(),
  replyToId: z.string().trim().min(1).max(80).optional(),
  clientMessageId: clientMessageIdSchema,
}).refine((value) => value.formula || value.diceId, {
  message: 'Dice roll requires formula or diceId',
});

function resolveRoomDiceFormula(room: { diceProfiles?: Array<{ id: string; formula: string }> }, input: { formula?: string; diceId?: string }) {
  if (input.diceId) {
    const profile = room.diceProfiles?.find((dice) => dice.id === input.diceId);
    if (!profile) {
      return { ok: false as const, error: 'Dice profile not found' as const };
    }
    return { ok: true as const, formula: profile.formula };
  }
  return { ok: true as const, formula: input.formula ?? '' };
}

app.post('/api/rooms/:roomId/dice/roll', (req, res) => {
  const membership = requireRoomMembership(req, res);
  if (!membership) {
    return;
  }

  const parsed = diceRollSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const existingMessage = store.getRoomMessageByClientMessageId(membership.room.id, parsed.data.clientMessageId, {
    senderId: membership.member.accountId,
    messageType: 'dice',
  });
  if (existingMessage) {
    io.to(membership.room.id).emit('chat:message', existingMessage);
    res.status(201).json({ message: existingMessage, roll: existingMessage.roll });
    return;
  }

  const resolvedDice = resolveRoomDiceFormula(membership.room, parsed.data);
  if (!resolvedDice.ok) {
    res.status(400).json({ error: resolvedDice.error });
    return;
  }

  const rateLimit = checkInteractionWriteRateLimit({
    accountId: membership.member.accountId,
    kind: 'room-dice',
  });
  if (!rateLimit.ok) {
    res.status(429).json({
      error: interactionRateLimitError('room-dice'),
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const coc7Check = resolvedDice.formula.match(/^\.ra\s+(.+)$/i);
  const rollResult = coc7Check
    ? store.rollCoc7Ability(membership.room.id, { id: membership.member.accountId }, coc7Check[1])
    : null;
  if (rollResult && !rollResult.ok) {
    res.status(400).json({ error: rollResult.error });
    return;
  }
  const roll = rollResult?.ok ? rollResult.roll : rollDiceFormula(resolvedDice.formula);
  if (!roll) {
    res.status(400).json({ error: '骰子公式格式错误，请使用 1d100、2d6+1、1d100<=60、1d20>=10 或 .ra 侦查。' });
    return;
  }

  const reply = store.getRoomMessageReference(membership.room.id, parsed.data.replyToId);
  if (!reply.ok) {
    res.status(400).json({ error: reply.error });
    return;
  }

  const message = store.addMessage(membership.room.id, {
    clientMessageId: parsed.data.clientMessageId,
    senderId: membership.member.accountId,
    messageType: 'dice',
    author: membership.member.displayName,
    role: membership.member.role,
    text: coc7Check ? `检定：${roll.text}` : `骰子：${roll.text}`,
    replyTo: reply.replyTo,
    roll,
  });
  if (!message) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  io.to(membership.room.id).emit('chat:message', message);
  res.status(201).json({ message, roll: message.roll ?? roll });
});

app.get('/api/scripts', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  res.json(store.listScripts(account));
});

const mapFeatureSchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: z.enum(['wall', 'door', 'cover', 'hazard']),
  label: z.string().trim().min(1).max(120),
  x: z.number().int().min(1).max(10_000),
  y: z.number().int().min(1).max(10_000),
  w: z.number().int().min(1).max(10_000),
  h: z.number().int().min(1).max(10_000),
});

const mapTokenSchema = z.object({
  id: z.string().trim().min(1).max(80),
  characterId: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  x: z.number().int().min(1).max(10_000),
  y: z.number().int().min(1).max(10_000),
  status: z.enum(['ready', 'wounded', 'hidden', 'npc']),
});

const scriptMapSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  width: z.number().int().min(4).max(40),
  height: z.number().int().min(4).max(30),
  notes: z.string().max(2000),
  features: z.array(mapFeatureSchema).max(200).optional(),
  tokens: z.array(mapTokenSchema).max(200).optional(),
});

const scriptCharacterSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  count: z.number().int().min(1).max(20),
  parameters: z.string().max(4000),
  story: z.string().max(8000),
  occupation: z.string().trim().max(80).optional(),
  publicSummary: z.string().max(2000).optional(),
  privateBrief: z.string().max(4000).optional(),
  recommendedSkills: z.array(recommendedSkillSchema).max(20).optional(),
});

const diceProfileSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  formula: z.string().trim().min(2).max(32).refine(isDiceFormulaSupported, {
    message: '骰子公式格式错误，请使用 1d100、2d6+1、1d100<=60、1d20>=10 或 .ra 侦查。',
  }),
  probability: z.number().min(0).max(1),
});

const scriptBlockSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('narrative'),
    title: z.string().trim().min(1).max(120),
    markdown: z.string().max(30000),
  }),
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('map'),
    title: z.string().trim().min(1).max(120),
    mapId: z.string().trim().min(1).max(80),
    notes: z.string().max(4000),
  }),
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('character'),
    title: z.string().trim().min(1).max(120),
    characterId: z.string().trim().min(1).max(80),
    notes: z.string().max(4000),
  }),
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('check'),
    title: z.string().trim().min(1).max(120),
    diceId: z.string().trim().min(1).max(80),
    difficulty: z.number().int().min(0).max(1000),
    onPass: z.string().max(4000),
    onFail: z.string().max(4000),
  }),
]);

const scriptChapterSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  blocks: z.array(scriptBlockSchema).max(200),
});

const scriptPayloadSchema = z.object({
  title: z.string().trim().min(1).max(120),
  system: z.string().trim().min(1).max(80).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  summary: z.string().max(1000).optional(),
  tags: z.array(z.string().trim().max(30)).max(12).optional(),
  coverUrl: z.string().max(400).optional(),
  maps: z.array(scriptMapSchema).max(80).optional(),
  characters: z.array(scriptCharacterSchema).max(200).optional(),
  diceProfiles: z.array(diceProfileSchema).max(80).optional(),
  chapters: z.array(scriptChapterSchema).max(120).optional(),
});

const scriptUpdatePayloadSchema = scriptPayloadSchema.partial().extend({
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

app.post('/api/scripts', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = scriptPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  res.status(201).json(store.createScript(account, parsed.data));
});

const importScriptSchema = z.object({
  title: z.string().trim().min(1).max(120),
  system: z.string().trim().min(1).max(80).optional(),
  rawText: z.string().trim().min(1).max(200000),
});

app.post('/api/scripts/import', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = importScriptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  res.status(201).json(store.importScript(account, parsed.data));
});

app.get('/api/scripts/:scriptId', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const script = store.getScript(req.params.scriptId, account);
  if (!script) {
    res.status(404).json({ error: 'Script not found' });
    return;
  }

  res.json(script);
});

app.put('/api/scripts/:scriptId', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = scriptUpdatePayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const result = store.updateScript(req.params.scriptId, account, parsed.data);
  if (!result.ok && result.error === 'not-found') {
    res.status(404).json({ error: 'Script not found' });
    return;
  }
  if (!result.ok && result.error === 'conflict') {
    res.status(409).json({
      error: 'Script version conflict',
      currentVersion: result.currentVersion,
      current: result.current,
    });
    return;
  }

  res.json(result.script);
});

app.delete('/api/scripts/:scriptId', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const result = store.deleteScript(req.params.scriptId, account);
  if (!result.ok) {
    res.status(result.error === 'Script not found' ? 404 : 403).json({ error: result.error });
    return;
  }

  res.status(204).end();
});

const liveKitSchema = z.object({
  roomId: z.string().min(1),
  voiceSessionId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
});

const directLiveKitSchema = z.object({
  friendId: z.string().trim().min(1),
  callId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,120}$/),
  voiceSessionId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
});

app.post('/api/livekit/token', async (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = liveKitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const membership = store.getRoomMembership(parsed.data.roomId, account);
  if (!membership) {
    const room = store.getRoom(parsed.data.roomId, account);
    res.status(room ? 403 : 404).json({ error: room ? 'Join an online room first' : 'Room not found' });
    return;
  }

  const voiceRoomName = store.getVoiceRoomName(parsed.data.roomId, account);
  if (!voiceRoomName) {
    res.status(403).json({ error: 'Join an online room first' });
    return;
  }

  const token = await issueLiveKitToken(voiceRoomName, account.id, parsed.data.voiceSessionId);
  res.json(token);
});

app.post('/api/livekit/direct-token', async (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = directLiveKitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const directVoiceRoom = store.getDirectCallVoiceRoomName(account.id, parsed.data.friendId, parsed.data.callId, {
    allowRoomVoiceHandoff: true,
  });
  if (!directVoiceRoom.ok) {
    emitPendingDirectCallEndedEvents();
    res.status(directVoiceRoom.error === 'Call not found' ? 404 : 403).json({ error: directVoiceRoom.error });
    return;
  }

  const token = await issueLiveKitToken(directVoiceRoom.roomName, account.id, parsed.data.voiceSessionId);
  if (!token.configured) {
    res.json(token);
    return;
  }

  const issued = store.markDirectCallVoiceTokenIssued(account.id, parsed.data.friendId, parsed.data.callId);
  if (!issued.ok) {
    emitPendingDirectCallEndedEvents();
    res.status(issued.error === 'Call not found' ? 404 : 403).json({ error: issued.error });
    return;
  }
  res.json(token);
});

app.post('/api/livekit/direct-ready', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }

  const parsed = directLiveKitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const result = store.markDirectCallVoiceReady(account.id, parsed.data.friendId, parsed.data.callId);
  if (!result.ok) {
    emitPendingDirectCallEndedEvents();
    res.status(result.error === 'Call not found' ? 404 : 403).json({ error: result.error });
    return;
  }

  const liveKitTargets = store.getRoomVoiceLiveKitTargetsForAccount(account.id);
  const changedRoomIds = io.leaveRoomVoiceForAccounts([account.id]);
  liveKitTargets.forEach((target) => {
    observeLiveKitCleanup(removeLiveKitParticipantsByAccount(target.roomName, account.id), {
      operation: 'remove-account-participants',
      trigger: 'direct-ready-room-voice-handoff',
    });
  });
  res.json({ ok: true, changedRoomIds });
});

const port = Number(process.env.PORT ?? 8787);
export const server = http.createServer(app);

const io = registerSocketServer(server);

store.drainStartupLiveKitRoomCleanupRooms().forEach((roomName) => {
  observeLiveKitCleanup(closeLiveKitRoom(roomName), {
    operation: 'close-room',
    trigger: 'startup-stale-room',
  });
});

const roomSweepInterval = setInterval(() => {
  emitPendingDirectCallEndedEvents();
  store.sweepExpiredRooms().forEach((room) => {
    observeLiveKitCleanup(closeLiveKitRoom(room.liveKitRoomName), {
      operation: 'close-room',
      trigger: 'expired-room-sweep',
    });
    io.clearRoomVoiceSessions(room.id);
    emitRoomState(room.id);
    io.emitRoomVoiceState(room.id);
    io.to(room.id).emit('room:closed', closedRoomEvent(room));
    io.in(room.id).socketsLeave(room.id);
    io.emit('rooms:changed');
  });
}, 5_000);
roomSweepInterval.unref?.();

let shuttingDown = false;

function closeSocketServer() {
  return new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
}

function closeHttpServer() {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(roomSweepInterval);
  try {
    await closeSocketServer();
    await closeHttpServer();
    store.flushPersistState();
    process.exit(0);
  } catch (error) {
    console.error(`[shutdown] failed while handling ${signal}`, error);
    try {
      store.flushPersistState();
    } catch (flushError) {
      console.error('[shutdown] failed to flush state', flushError);
    }
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  server.listen(port, () => {
    console.log(`paotuan server listening on http://localhost:${port}`);
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

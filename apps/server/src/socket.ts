import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { isOriginAllowed, socketCorsOrigin } from './cors-config.js';
import { rollDiceFormula } from './dice.js';
import { checkInteractionWriteRateLimit, interactionRateLimitError } from './interaction-rate-limit.js';
import { closeLiveKitRoom, observeLiveKitCleanup, removeLiveKitParticipantsByAccount } from './livekit.js';
import { roomCharacterSchema } from './room-schemas.js';
import { store } from './store.js';
import type { Account, Character, DirectCallEvent, VoiceParticipant, VoiceStateEvent } from './types.js';

type RoomMembership = NonNullable<ReturnType<typeof store.getRoomMembership>>;
type VoiceStateRoom = {
  voice: {
    participants: VoiceStateEvent['participants'];
  };
};
type SocketErrorAck = { ok: false; error: unknown; retryAfterSeconds?: number };

export type RealtimeServer = Server & {
  clearAccountRoomVoiceSessions: (roomId: string, accountId: string) => void;
  clearRoomVoiceSessions: (roomId: string) => void;
  emitRoomVoiceState: (roomId: string) => void;
  leaveRoomVoiceForAccounts: (accountIds: string[]) => string[];
  revokeAccountSockets: (accountId: string, options?: { exceptToken?: string; token?: string }) => void;
};

const joinSchema = z.object({
  roomId: z.string().min(1),
  displayName: z.string().optional(),
  resume: z.boolean().optional(),
  role: z.enum(['keeper', 'player']).optional(),
  token: z.string().optional(),
});

const leaveSchema = z.object({
  roomId: z.string().min(1),
  token: z.string().optional(),
});

const voiceJoinSchema = z.object({
  roomId: z.string().min(1),
  token: z.string().optional(),
  muted: z.boolean().optional(),
  quality: z.enum(['excellent', 'good', 'relay', 'offline']).optional(),
});

const voiceUpdateSchema = z.object({
  roomId: z.string().min(1),
  token: z.string().optional(),
  muted: z.boolean().optional(),
  speaking: z.boolean().optional(),
  quality: z.enum(['excellent', 'good', 'relay', 'offline']).optional(),
}).refine((value) => value.muted !== undefined || value.speaking !== undefined || value.quality !== undefined, {
  message: 'Voice update requires muted, speaking, or quality',
});

const chatSchema = z.object({
  roomId: z.string().min(1),
  token: z.string().optional(),
  message: z.object({
    text: z.string().trim().min(1).max(2000),
    replyToId: z.string().trim().min(1).max(80).optional(),
    clientMessageId: z.string().trim().min(1).max(120).optional(),
  }),
});

const characterSchema = z.object({
  roomId: z.string().min(1),
  token: z.string().optional(),
  character: roomCharacterSchema,
});

const tokenMoveSchema = z.object({
  roomId: z.string().min(1),
  token: z.string().optional(),
  tokenId: z.string().min(1),
  x: z.number(),
  y: z.number(),
});

const diceRollSchema = z.object({
  roomId: z.string().min(1),
  token: z.string().optional(),
  formula: z.string().trim().min(2).max(80).optional(),
  diceId: z.string().trim().min(1).max(80).optional(),
  replyToId: z.string().trim().min(1).max(80).optional(),
  clientMessageId: z.string().trim().min(1).max(120).optional(),
}).refine((value) => value.formula || value.diceId, {
  message: 'Dice roll requires formula or diceId',
});

const directCallIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,120}$/);

const directCallBaseSchema = z.object({
  token: z.string().optional(),
  friendId: z.string().trim().min(1),
  callId: directCallIdSchema,
});

const directCallInviteSchema = directCallBaseSchema.extend({
  callId: directCallIdSchema.optional(),
});

const homeSyncSchema = z.object({
  token: z.string().optional(),
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

function emitVoiceState(io: Server, roomId: string, room: VoiceStateRoom | undefined) {
  if (!room) {
    return;
  }
  const payload: VoiceStateEvent = {
    roomId,
    participants: room.voice.participants,
  };
  io.to(roomId).emit('voice:state', payload);
}

function closedRoomEvent(room: { id: string; online?: boolean; closedAt?: string | null }) {
  return {
    id: room.id,
    roomId: room.id,
    online: false,
    closedAt: room.closedAt ?? null,
  };
}

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
    return { ok: false as const, error: 'Room or token not found' };
  }
  if (membership.room.ownerId === membership.member.accountId) {
    return { ok: true as const };
  }
  if (token.status === 'hidden') {
    return { ok: false as const, error: 'Only the keeper can move hidden tokens' };
  }

  const character = membership.room.characters.find((item) => item.id === token.characterId);
  const ownsCharacter = character?.accountId === membership.member.accountId;
  if (!ownsCharacter) {
    return { ok: false as const, error: 'Only the keeper or token owner can move this token' };
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

export function registerSocketServer(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: socketCorsOrigin,
    },
    allowRequest: (request, callback) => {
      callback(null, isOriginAllowed(request.headers.origin));
    },
  }) as RealtimeServer;
  const disconnectGraceMs = 15_000;
  const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingVoiceDisconnects = new Map<string, ReturnType<typeof setTimeout>>();
  const voiceSessions = new Map<string, Set<string>>();
  const voiceSessionAccounts = new Map<string, Account>();
  const voiceSessionStates = new Map<string, Map<string, Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>>>>();
  const socketAuth = new Map<string, { accountId: string; token?: string }>();
  const voiceQualityRank: Record<VoiceParticipant['quality'], number> = {
    excellent: 0,
    good: 1,
    relay: 2,
    offline: 3,
  };

  const emitRoomState = (roomId: string) => {
    const room = store.getRoomBroadcastState(roomId);
    if (room) {
      store.getRoomViewerStates(room.id).forEach((viewer) => {
        io.to(`account:${viewer.accountId}`).emit('room:state', viewer.room);
      });
    }
    return room;
  };

  const broadcastExpiredRoomClosures = () => {
    const closedRooms = store.sweepExpiredRooms();
    if (closedRooms.length === 0) {
      return;
    }
    closedRooms.forEach((room) => {
      observeLiveKitCleanup(closeLiveKitRoom(room.liveKitRoomName), {
        operation: 'close-room',
        trigger: 'socket-expired-room',
      });
      clearRoomVoiceSessions(room.id);
      emitRoomState(room.id);
      emitVoiceState(io, room.id, { voice: { participants: [] } });
      io.to(room.id).emit('room:closed', closedRoomEvent(room));
      io.in(room.id).socketsLeave(room.id);
    });
    io.emit('rooms:changed');
  };

  const broadcastExpiredDirectCalls = () => {
    store.sweepExpiredDirectCalls().forEach((event) => {
      const { liveKitRoomName, ...clientEvent } = event;
      io.to(`account:${event.fromId}`).to(`account:${event.toId}`).emit('direct-call:ended', clientEvent);
      observeLiveKitCleanup(closeLiveKitRoom(liveKitRoomName), {
        operation: 'close-room',
        trigger: 'socket-expired-direct-call',
      });
    });
  };

  const disconnectKey = (roomId: string, accountId: string) => `${roomId}:${accountId}`;
  const voiceSessionKey = (roomId: string, accountId: string) => `${roomId}:${accountId}`;
  const parseVoiceSessionKey = (key: string) => {
    const separator = key.lastIndexOf(':');
    if (separator < 0) {
      return null;
    }
    return {
      roomId: key.slice(0, separator),
      accountId: key.slice(separator + 1),
    };
  };

  const clearPendingDisconnect = (roomId: string, accountId: string) => {
    const key = disconnectKey(roomId, accountId);
    const timer = pendingDisconnects.get(key);
    if (timer) {
      clearTimeout(timer);
      pendingDisconnects.delete(key);
    }
  };

  const clearPendingVoiceDisconnect = (roomId: string, accountId: string) => {
    const key = voiceSessionKey(roomId, accountId);
    const timer = pendingVoiceDisconnects.get(key);
    if (timer) {
      clearTimeout(timer);
      pendingVoiceDisconnects.delete(key);
    }
  };

  const aggregateVoiceSessionState = (key: string) => {
    const states = [...(voiceSessionStates.get(key)?.values() ?? [])];
    if (states.length === 0) {
      return {};
    }
    const mutedValues = states
      .map((state) => state.muted)
      .filter((muted): muted is boolean => muted !== undefined);
    const qualityValues = states
      .map((state) => state.quality)
      .filter((quality): quality is VoiceParticipant['quality'] => quality !== undefined);
    return {
      muted: mutedValues.length > 0 ? mutedValues.every(Boolean) : undefined,
      speaking: states.some((state) => state.speaking),
      quality: qualityValues.length > 0
        ? qualityValues.reduce((worst, quality) => (voiceQualityRank[quality] > voiceQualityRank[worst] ? quality : worst), qualityValues[0])
        : undefined,
    };
  };

  const patchVoiceSocketState = (
    roomId: string,
    accountId: string,
    socketId: string,
    patch: Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>>,
  ) => {
    const key = voiceSessionKey(roomId, accountId);
    const states = voiceSessionStates.get(key) ?? new Map<string, Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>>>();
    const nextState = { ...(states.get(socketId) ?? {}) };
    if (patch.muted !== undefined) {
      nextState.muted = patch.muted;
    }
    if (patch.speaking !== undefined) {
      nextState.speaking = patch.speaking;
    }
    if (patch.quality !== undefined) {
      nextState.quality = patch.quality;
    }
    states.set(socketId, nextState);
    voiceSessionStates.set(key, states);
    return aggregateVoiceSessionState(key);
  };

  const snapshotVoiceSocketState = (key: string) => {
    const states = voiceSessionStates.get(key);
    return states ? new Map(states) : null;
  };

  const restoreVoiceSocketState = (
    key: string,
    snapshot: Map<string, Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>>> | null,
  ) => {
    if (snapshot) {
      voiceSessionStates.set(key, snapshot);
    } else {
      voiceSessionStates.delete(key);
    }
  };

  const deleteVoiceSocketState = (roomId: string, accountId: string, socketId: string) => {
    const key = voiceSessionKey(roomId, accountId);
    const states = voiceSessionStates.get(key);
    if (!states) {
      return aggregateVoiceSessionState(key);
    }
    states.delete(socketId);
    if (states.size === 0) {
      voiceSessionStates.delete(key);
      return {};
    }
    return aggregateVoiceSessionState(key);
  };

  const aggregateRequestedVoicePatch = (
    key: string,
    requested: Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>>,
  ) => {
    const aggregate = aggregateVoiceSessionState(key);
    const patch: Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>> = {};
    if (requested.muted !== undefined) {
      patch.muted = aggregate.muted ?? false;
    }
    if (requested.speaking !== undefined) {
      patch.speaking = aggregate.speaking ?? false;
    }
    if (requested.quality !== undefined) {
      patch.quality = aggregate.quality ?? 'excellent';
    }
    return patch;
  };

  const voiceAggregateForStore = (aggregate: Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>>) => ({
    muted: aggregate.muted ?? false,
    speaking: aggregate.speaking ?? false,
    quality: aggregate.quality ?? 'excellent',
  });

  const trackVoiceSession = (roomId: string, account: Account, socketId: string) => {
    const accountId = account.id;
    const key = voiceSessionKey(roomId, accountId);
    clearPendingVoiceDisconnect(roomId, accountId);
    const sessions = voiceSessions.get(key) ?? new Set<string>();
    sessions.add(socketId);
    voiceSessions.set(key, sessions);
    voiceSessionAccounts.set(key, account);
    return key;
  };

  const releaseVoiceSession = (roomId: string, accountId: string, socketId: string) => {
    const key = voiceSessionKey(roomId, accountId);
    const sessions = voiceSessions.get(key);
    if (!sessions) {
      return false;
    }
    sessions.delete(socketId);
    if (sessions.size > 0) {
      return true;
    }
    voiceSessions.delete(key);
    voiceSessionAccounts.delete(key);
    return false;
  };

  const clearVoiceSessions = (roomId: string, accountId: string) => {
    const key = voiceSessionKey(roomId, accountId);
    voiceSessions.delete(key);
    voiceSessionAccounts.delete(key);
    voiceSessionStates.delete(key);
    clearPendingVoiceDisconnect(roomId, accountId);
  };

  const clearRoomVoiceSessions = (roomId: string) => {
    const keys = new Set([
      ...voiceSessions.keys(),
      ...voiceSessionAccounts.keys(),
      ...voiceSessionStates.keys(),
      ...pendingVoiceDisconnects.keys(),
    ]);
    keys.forEach((key) => {
      const parsed = parseVoiceSessionKey(key);
      if (parsed?.roomId === roomId) {
        clearVoiceSessions(parsed.roomId, parsed.accountId);
      }
    });
  };

  io.clearAccountRoomVoiceSessions = clearVoiceSessions;
  io.clearRoomVoiceSessions = clearRoomVoiceSessions;
  io.emitRoomVoiceState = (roomId: string) => {
    emitVoiceState(io, roomId, store.getRoomBroadcastState(roomId) ?? { voice: { participants: [] } });
  };
  io.revokeAccountSockets = (accountId, options = {}) => {
    socketAuth.forEach((auth, socketId) => {
      if (auth.accountId !== accountId) {
        return;
      }
      if (options.exceptToken && auth.token === options.exceptToken) {
        return;
      }
      if (options.token && auth.token !== options.token) {
        return;
      }
      const target = io.sockets.sockets.get(socketId);
      target?.emit('auth:revoked');
      target?.leave(`account:${accountId}`);
      const timer = setTimeout(() => target?.disconnect(true), 0);
      timer.unref?.();
    });
  };

  const leaveRoomVoiceForAccounts = (accountIds: string[]) => {
    const changedRoomIds = new Set<string>();
    accountIds.forEach((accountId) => {
      store.leaveAllVoiceForAccount(accountId).forEach((room) => {
        clearVoiceSessions(room.id, accountId);
        changedRoomIds.add(room.id);
      });
    });
    changedRoomIds.forEach((roomId) => {
      emitRoomState(roomId);
      emitVoiceState(io, roomId, store.getRoomBroadcastState(roomId) ?? { voice: { participants: [] } });
    });
    if (changedRoomIds.size > 0) {
      io.emit('rooms:changed');
    }
    return [...changedRoomIds];
  };

  io.leaveRoomVoiceForAccounts = leaveRoomVoiceForAccounts;

  io.on('connection', (socket) => {
    const joinedRooms = new Set<string>();
    const joinedVoiceSessions = new Set<string>();
    const authToken = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined;
    const handshakeAccount = store.getAccountByToken(authToken);
    if (handshakeAccount) {
      socket.data.accountId = handshakeAccount.id;
      socket.join(`account:${handshakeAccount.id}`);
      socketAuth.set(socket.id, { accountId: handshakeAccount.id, token: authToken });
    }

    const resolveSocketAccount = (
      token: string | undefined,
      callback?: (response: SocketErrorAck) => void,
    ) => {
      const account = store.getAccountByToken(token);
      if (!account) {
        callback?.({ ok: false, error: 'Login required' });
        return null;
      }
      const boundAccountId = socket.data.accountId as string | undefined;
      if (boundAccountId && boundAccountId !== account.id) {
        callback?.({ ok: false, error: 'Socket account mismatch' });
        return null;
      }
      socket.data.accountId = account.id;
      socket.join(`account:${account.id}`);
      socketAuth.set(socket.id, { accountId: account.id, token });
      return account;
    };

    const resolveDirectCallAccounts = (
      token: string | undefined,
      friendId: string,
      callback?: (response: SocketErrorAck) => void,
    ) => {
      const account = resolveSocketAccount(token, callback);
      if (!account) {
        return null;
      }
      const friend = store.listFriends(account.id).find(
        (item) => item.id === friendId && item.direction === 'friend',
      );
      if (!friend) {
        callback?.({ ok: false, error: 'Friend access required' });
        return null;
      }
      return {
        account,
        friend: {
          id: friend.id,
          displayName: friend.displayName,
          avatar: friend.avatar,
        },
      };
    };

    const resolveDirectCallEvent = (
      callId: string,
      status: DirectCallEvent['status'],
      callback?: (response: SocketErrorAck) => void,
    ) => {
      const event = store.getDirectCallEvent(callId, status);
      if (!event) {
        callback?.({ ok: false, error: 'Call not found' });
        return null;
      }
      return event;
    };

    const emitCurrentDirectCall = (account: Account) => {
      const event = store.getDirectCallSyncForAccount(account.id);
      broadcastExpiredDirectCalls();
      socket.emit('direct-call:sync', { currentCall: event });
      if (!event || event.status === 'ended' || event.status === 'rejected') {
        return event;
      }
      socket.emit(event.status === 'accepted' ? 'direct-call:accepted' : 'direct-call:invite', event);
      return event;
    };

    socket.on('home:sync', (payload, callback) => {
      const parsed = homeSyncSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }
      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }
      const currentCall = emitCurrentDirectCall(account);
      callback?.({ ok: true, currentCall });
    });

    socket.on('room:join', (payload, callback) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const result = store.joinRoom(parsed.data.roomId, account, parsed.data.role, {
        openClosed: parsed.data.resume ? false : undefined,
      });
      broadcastExpiredRoomClosures();
      if (!result.ok) {
        callback?.({ ok: false, error: result.error });
        return;
      }
      clearPendingDisconnect(parsed.data.roomId, account.id);
      socket.join(parsed.data.roomId);
      joinedRooms.add(parsed.data.roomId);
      emitRoomState(parsed.data.roomId);
      io.emit('rooms:changed');
      callback?.({ ok: true, room: result.room, account });
    });

    socket.on('room:leave', (payload, callback) => {
      const parsed = leaveSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const result = store.leaveRoom(parsed.data.roomId, account.id);
      broadcastExpiredRoomClosures();
      if (!result.ok) {
        callback?.({ ok: false, error: result.error });
        return;
      }

      if (result.liveKitRoomName) {
    observeLiveKitCleanup(removeLiveKitParticipantsByAccount(result.liveKitRoomName, account.id), {
      operation: 'remove-account-participants',
      trigger: 'room-socket-leave',
    });
      }
      joinedRooms.delete(parsed.data.roomId);
      clearPendingDisconnect(parsed.data.roomId, account.id);
      clearVoiceSessions(parsed.data.roomId, account.id);
      joinedVoiceSessions.delete(voiceSessionKey(parsed.data.roomId, account.id));
      io.to(`account:${account.id}`).emit('room:left', { roomId: parsed.data.roomId });
      io.in(`account:${account.id}`).socketsLeave(parsed.data.roomId);
      emitRoomState(parsed.data.roomId);
      emitVoiceState(io, parsed.data.roomId, result.room);
      io.emit('rooms:changed');
      callback?.({ ok: true, room: result.room });
    });

    socket.on('chat:send', (payload, callback) => {
      const parsed = chatSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const membership = store.getRoomMembership(parsed.data.roomId, account);
      broadcastExpiredRoomClosures();
      if (!membership) {
        const room = store.getRoom(parsed.data.roomId, account);
        broadcastExpiredRoomClosures();
        callback?.({ ok: false, error: room ? 'Join an online room first' : 'Room not found' });
        return;
      }

      const existingMessage = store.getRoomMessageByClientMessageId(
        membership.room.id,
        parsed.data.message.clientMessageId,
        {
          senderId: membership.member.accountId,
          messageType: 'chat',
        },
      );
      if (existingMessage) {
        io.to(parsed.data.roomId).emit('chat:message', existingMessage);
        callback?.({ ok: true, data: existingMessage });
        return;
      }

      const reply = store.getRoomMessageReference(membership.room.id, parsed.data.message.replyToId);
      if (!reply.ok) {
        callback?.({ ok: false, error: reply.error });
        return;
      }

      const rateLimit = checkInteractionWriteRateLimit({
        accountId: membership.member.accountId,
        kind: 'room-chat',
      });
      if (!rateLimit.ok) {
        callback?.({
          ok: false,
          error: interactionRateLimitError('room-chat'),
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        });
        return;
      }

      const message = store.addMessage(membership.room.id, {
        clientMessageId: parsed.data.message.clientMessageId,
        senderId: membership.member.accountId,
        messageType: 'chat',
        author: membership.member.displayName,
        role: membership.member.role,
        text: parsed.data.message.text,
        replyTo: reply.replyTo,
      });
      if (!message) {
        callback?.({ ok: false, error: 'Room not found' });
        return;
      }

      io.to(parsed.data.roomId).emit('chat:message', message);
      callback?.({ ok: true, data: message });
    });

    socket.on('dice:roll', (payload, callback) => {
      const parsed = diceRollSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const membership = store.getRoomMembership(parsed.data.roomId, account);
      broadcastExpiredRoomClosures();
      if (!membership) {
        const room = store.getRoom(parsed.data.roomId, account);
        broadcastExpiredRoomClosures();
        callback?.({ ok: false, error: room ? 'Join an online room first' : 'Room not found' });
        return;
      }

      const existingMessage = store.getRoomMessageByClientMessageId(membership.room.id, parsed.data.clientMessageId, {
        senderId: membership.member.accountId,
        messageType: 'dice',
      });
      if (existingMessage) {
        io.to(parsed.data.roomId).emit('chat:message', existingMessage);
        callback?.({ ok: true, data: { message: existingMessage, roll: existingMessage.roll } });
        return;
      }

      const resolvedDice = resolveRoomDiceFormula(membership.room, parsed.data);
      if (!resolvedDice.ok) {
        callback?.({ ok: false, error: resolvedDice.error });
        return;
      }

      const rateLimit = checkInteractionWriteRateLimit({
        accountId: membership.member.accountId,
        kind: 'room-dice',
      });
      if (!rateLimit.ok) {
        callback?.({
          ok: false,
          error: interactionRateLimitError('room-dice'),
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        });
        return;
      }

      const coc7Check = resolvedDice.formula.match(/^\.ra\s+(.+)$/i);
      const rollResult = coc7Check
        ? store.rollCoc7Ability(membership.room.id, account, coc7Check[1])
        : null;
      if (rollResult && !rollResult.ok) {
        callback?.({ ok: false, error: rollResult.error });
        return;
      }
      const roll = rollResult?.ok ? rollResult.roll : rollDiceFormula(resolvedDice.formula);
      if (!roll) {
        callback?.({ ok: false, error: '骰子公式格式错误，请使用 1d100、2d6+1、1d100<=60、1d20>=10 或 .ra 侦查。' });
        return;
      }

      const reply = store.getRoomMessageReference(membership.room.id, parsed.data.replyToId);
      if (!reply.ok) {
        callback?.({ ok: false, error: reply.error });
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
        callback?.({ ok: false, error: 'Room not found' });
        return;
      }

      io.to(parsed.data.roomId).emit('chat:message', message);
      callback?.({ ok: true, data: { message, roll: message.roll ?? roll } });
    });

    socket.on('character:update', (payload, callback) => {
      const parsed = characterSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const membership = store.getRoomMembership(parsed.data.roomId, account);
      broadcastExpiredRoomClosures();
      if (!membership) {
        const room = store.getRoom(parsed.data.roomId, account);
        broadcastExpiredRoomClosures();
        callback?.({ ok: false, error: room ? 'Join an online room first' : 'Room not found' });
        return;
      }

      if (!canEditCharacter(membership, parsed.data.character.id)) {
        callback?.({ ok: false, error: 'Only the keeper or assigned player can edit this character' });
        return;
      }

      const character = store.updateCharacter(
        membership.room.id,
        sanitizePlayerCharacterUpdate(membership, parsed.data.character),
      );
      broadcastExpiredRoomClosures();
      if (!character) {
        callback?.({ ok: false, error: 'Room not found' });
        return;
      }

      emitRoomState(membership.room.id);
      callback?.({ ok: true, data: character });
    });

    socket.on('scene:moveToken', (payload, callback) => {
      const parsed = tokenMoveSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const membership = store.getRoomMembership(parsed.data.roomId, account);
      broadcastExpiredRoomClosures();
      if (!membership) {
        const room = store.getRoom(parsed.data.roomId, account);
        broadcastExpiredRoomClosures();
        callback?.({ ok: false, error: room ? 'Join an online room first' : 'Room not found' });
        return;
      }

      const permission = canMoveToken(membership, parsed.data.tokenId);
      if (!permission.ok) {
        callback?.({ ok: false, error: permission.error });
        return;
      }

      const token = store.moveToken(membership.room.id, parsed.data.tokenId, parsed.data.x, parsed.data.y);
      broadcastExpiredRoomClosures();
      if (!token) {
        callback?.({ ok: false, error: 'Room or token not found' });
        return;
      }

      emitRoomState(membership.room.id);
      callback?.({ ok: true, data: token });
    });

    socket.on('voice:join', (payload, callback) => {
      const parsed = voiceJoinSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const joinedKey = trackVoiceSession(parsed.data.roomId, account, socket.id);
      const aggregate = patchVoiceSocketState(parsed.data.roomId, account.id, socket.id, {
        muted: parsed.data.muted ?? false,
        speaking: false,
        quality: parsed.data.quality ?? 'excellent',
      });
      const result = store.joinVoice(parsed.data.roomId, account, voiceAggregateForStore(aggregate));
      broadcastExpiredRoomClosures();
      if (!result.ok) {
        deleteVoiceSocketState(parsed.data.roomId, account.id, socket.id);
        releaseVoiceSession(parsed.data.roomId, account.id, socket.id);
        callback?.({ ok: false, error: result.error });
        return;
      }

      joinedVoiceSessions.add(joinedKey);
      clearPendingDisconnect(parsed.data.roomId, account.id);
      socket.join(parsed.data.roomId);
      joinedRooms.add(parsed.data.roomId);
      emitVoiceState(io, parsed.data.roomId, result.room);
      callback?.({ ok: true, room: result.room });
    });

    socket.on('voice:update', (payload, callback) => {
      const parsed = voiceUpdateSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const key = voiceSessionKey(parsed.data.roomId, account.id);
      if (!voiceSessions.get(key)?.has(socket.id)) {
        callback?.({ ok: false, error: 'Join voice first' });
        return;
      }
      const snapshot = snapshotVoiceSocketState(key);
      patchVoiceSocketState(parsed.data.roomId, account.id, socket.id, {
        muted: parsed.data.muted,
        speaking: parsed.data.speaking,
        quality: parsed.data.quality,
      });
      const result = store.updateVoiceParticipant(parsed.data.roomId, account, aggregateRequestedVoicePatch(key, {
        muted: parsed.data.muted,
        speaking: parsed.data.speaking,
        quality: parsed.data.quality,
      }));
      broadcastExpiredRoomClosures();
      if (!result.ok) {
        const room = store.getRoomBroadcastState(parsed.data.roomId);
        const sessionStillTracked = voiceSessions.get(key)?.has(socket.id) ?? false;
        const participantStillOnline = room?.online === true && room.voice.participants.some((participant) => participant.id === account.id);
        if (sessionStillTracked && participantStillOnline) {
          restoreVoiceSocketState(key, snapshot);
        } else {
          clearVoiceSessions(parsed.data.roomId, account.id);
        }
        callback?.({ ok: false, error: result.error });
        return;
      }

      emitVoiceState(io, parsed.data.roomId, result.room);
      callback?.({ ok: true, room: result.room });
    });

    socket.on('voice:leave', (payload, callback) => {
      const parsed = leaveSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const account = resolveSocketAccount(parsed.data.token, callback);
      if (!account) {
        return;
      }

      const key = voiceSessionKey(parsed.data.roomId, account.id);
      const aggregateAfterLeave = deleteVoiceSocketState(parsed.data.roomId, account.id, socket.id);
      const hasOtherVoiceSession = releaseVoiceSession(parsed.data.roomId, account.id, socket.id);
      joinedVoiceSessions.delete(key);
      if (hasOtherVoiceSession) {
        const result = store.updateVoiceParticipant(parsed.data.roomId, account, voiceAggregateForStore(aggregateAfterLeave));
        broadcastExpiredRoomClosures();
        const room = result.ok ? result.room : store.getRoom(parsed.data.roomId, account);
        broadcastExpiredRoomClosures();
        emitVoiceState(io, parsed.data.roomId, room ?? undefined);
        callback?.({ ok: result.ok, room, error: result.ok ? undefined : result.error });
        return;
      }

      const result = store.leaveVoice(parsed.data.roomId, account.id);
      broadcastExpiredRoomClosures();
      if (!result.ok) {
        callback?.({ ok: false, error: result.error });
        return;
      }

      observeLiveKitCleanup(removeLiveKitParticipantsByAccount(result.liveKitRoomName, account.id), {
        operation: 'remove-account-participants',
        trigger: 'voice-leave',
      });
      emitVoiceState(io, parsed.data.roomId, result.room);
      callback?.({ ok: true, room: result.room });
    });

    socket.on('direct-call:invite', (payload, callback) => {
      const parsed = directCallInviteSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const accounts = resolveDirectCallAccounts(parsed.data.token, parsed.data.friendId, callback);
      if (!accounts) {
        return;
      }

      const result = store.createDirectCall(accounts.account.id, accounts.friend.id, parsed.data.callId);
      if (!result.ok) {
        callback?.({ ok: false, error: result.error });
        return;
      }

      const event = resolveDirectCallEvent(result.session.callId, 'ringing', callback);
      if (!event) {
        return;
      }
      io.to(`account:${accounts.account.id}`).to(`account:${accounts.friend.id}`).emit('direct-call:invite', event);
      callback?.({ ok: true, data: event });
    });

    socket.on('direct-call:accept', (payload, callback) => {
      const parsed = directCallBaseSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const accounts = resolveDirectCallAccounts(parsed.data.token, parsed.data.friendId, callback);
      if (!accounts) {
        return;
      }

      const result = store.acceptDirectCall(accounts.account.id, accounts.friend.id, parsed.data.callId);
      if (!result.ok) {
        callback?.({ ok: false, error: result.error });
        return;
      }

      const event = resolveDirectCallEvent(result.session.callId, 'accepted', callback);
      if (!event) {
        return;
      }
      io.to(`account:${accounts.account.id}`).to(`account:${accounts.friend.id}`).emit('direct-call:accepted', event);
      callback?.({ ok: true, data: event });
    });

    socket.on('direct-call:heartbeat', (payload, callback) => {
      const parsed = directCallBaseSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const accounts = resolveDirectCallAccounts(parsed.data.token, parsed.data.friendId, callback);
      if (!accounts) {
        return;
      }

      const result = store.heartbeatDirectCall(accounts.account.id, accounts.friend.id, parsed.data.callId);
      if (!result.ok) {
        broadcastExpiredDirectCalls();
        callback?.({ ok: false, error: result.error });
        return;
      }

      const event = resolveDirectCallEvent(result.session.callId, 'accepted', callback);
      if (!event) {
        return;
      }
      callback?.({ ok: true, data: event });
    });

    socket.on('direct-call:reject', (payload, callback) => {
      const parsed = directCallBaseSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const accounts = resolveDirectCallAccounts(parsed.data.token, parsed.data.friendId, callback);
      if (!accounts) {
        return;
      }

      const result = store.rejectDirectCall(accounts.account.id, accounts.friend.id, parsed.data.callId);
      if (!result.ok) {
        callback?.({ ok: false, error: result.error });
        return;
      }

      const event = resolveDirectCallEvent(result.session.callId, 'rejected', callback);
      if (!event) {
        return;
      }
      io.to(`account:${accounts.account.id}`).to(`account:${accounts.friend.id}`).emit('direct-call:rejected', event);
      callback?.({ ok: true, data: event });
    });

    socket.on('direct-call:end', (payload, callback) => {
      const parsed = directCallBaseSchema.safeParse(payload);
      if (!parsed.success) {
        callback?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const accounts = resolveDirectCallAccounts(parsed.data.token, parsed.data.friendId, callback);
      if (!accounts) {
        return;
      }

      const result = store.endDirectCall(accounts.account.id, accounts.friend.id, parsed.data.callId);
      if (!result.ok) {
        callback?.({ ok: false, error: result.error });
        return;
      }

      const event = resolveDirectCallEvent(result.session.callId, 'ended', callback);
      if (!event) {
        return;
      }
      io.to(`account:${accounts.account.id}`).to(`account:${accounts.friend.id}`).emit('direct-call:ended', event);
      observeLiveKitCleanup(closeLiveKitRoom(result.session.roomName), {
        operation: 'close-room',
        trigger: 'direct-call-end',
      });
      callback?.({ ok: true, data: event });
    });

    socket.on('disconnect', async () => {
      socketAuth.delete(socket.id);
      const accountId = socket.data.accountId as string | undefined;
      if (!accountId) {
        return;
      }

      for (const key of joinedVoiceSessions) {
        const parsedKey = parseVoiceSessionKey(key);
        if (!parsedKey) {
          continue;
        }
        const aggregateAfterLeave = deleteVoiceSocketState(parsedKey.roomId, parsedKey.accountId, socket.id);
        const hasOtherVoiceSession = releaseVoiceSession(parsedKey.roomId, parsedKey.accountId, socket.id);
        if (hasOtherVoiceSession) {
          const account = voiceSessionAccounts.get(key);
          if (account) {
            const result = store.updateVoiceParticipant(parsedKey.roomId, account, voiceAggregateForStore(aggregateAfterLeave));
            broadcastExpiredRoomClosures();
            if (result.ok) {
              emitVoiceState(io, parsedKey.roomId, result.room);
            }
          }
          continue;
        }
        if (pendingVoiceDisconnects.has(key)) {
          continue;
        }
        const timer = setTimeout(() => {
          pendingVoiceDisconnects.delete(key);
          if (voiceSessions.has(key)) {
            return;
          }
          const result = store.leaveVoice(parsedKey.roomId, parsedKey.accountId);
          broadcastExpiredRoomClosures();
          if (result.ok) {
              observeLiveKitCleanup(removeLiveKitParticipantsByAccount(result.liveKitRoomName, parsedKey.accountId), {
                operation: 'remove-account-participants',
                trigger: 'voice-disconnect-grace-expired',
              });
            emitVoiceState(io, parsedKey.roomId, result.room);
          }
        }, disconnectGraceMs);
        timer.unref?.();
        pendingVoiceDisconnects.set(key, timer);
      }
      joinedVoiceSessions.clear();

      for (const roomId of joinedRooms) {
        let roomSockets;
        try {
          roomSockets = await io.in(roomId).fetchSockets();
        } catch (error) {
          console.warn('Failed to inspect sockets during disconnect.', error);
          continue;
        }
        const hasAnotherConnection = roomSockets.some(
          (roomSocket) => roomSocket.id !== socket.id && roomSocket.data.accountId === accountId,
        );
        if (hasAnotherConnection) {
          continue;
        }

        const key = disconnectKey(roomId, accountId);
        if (pendingDisconnects.has(key)) {
          continue;
        }
        const timer = setTimeout(async () => {
          pendingDisconnects.delete(key);
          try {
            const freshRoomSockets = await io.in(roomId).fetchSockets();
            const reconnected = freshRoomSockets.some((roomSocket) => roomSocket.data.accountId === accountId);
            if (reconnected) {
              return;
            }
            const result = store.disconnectRoomMember(roomId, accountId);
            broadcastExpiredRoomClosures();
            if (result.ok) {
              if (result.liveKitRoomName) {
            observeLiveKitCleanup(removeLiveKitParticipantsByAccount(result.liveKitRoomName, accountId), {
              operation: 'remove-account-participants',
              trigger: 'room-disconnect-grace-expired',
            });
              }
              emitRoomState(roomId);
              io.emit('rooms:changed');
            }
          } catch (error) {
            console.warn('Failed to finalize delayed room disconnect.', error);
          }
        }, disconnectGraceMs);
        timer.unref?.();
        pendingDisconnects.set(key, timer);
      }
      joinedRooms.clear();
    });
  });

  return io;
}

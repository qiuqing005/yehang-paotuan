import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';
import type { VoiceTokenResponse } from './types.js';

type LiveKitAdminUrlSource = 'LIVEKIT_API_URL' | 'LIVEKIT_URL' | 'none';
type LiveKitCleanupOperation = 'close-room' | 'remove-account-participants';

type LiveKitCleanupContext = {
  operation: LiveKitCleanupOperation;
  trigger: string;
};

type LiveKitCleanupResult = {
  attempts?: number;
  attempted: boolean;
  configured: boolean;
  ok?: boolean;
  notFound?: boolean;
  error?: unknown;
};

type LiveKitCleanupFailure = {
  at: string;
  configured: boolean;
  error: string;
  operation: LiveKitCleanupOperation;
  trigger: string;
};

type LiveKitCleanupStatus = {
  attemptedCount: number;
  failedCount: number;
  lastAttemptAt?: string;
  lastFailure?: LiveKitCleanupFailure;
  lastSuccessAt?: string;
  notFoundCount: number;
  pendingCount: number;
  retryCount: number;
  skippedCount: number;
  successCount: number;
};

function cleanEnv(value: string | undefined) {
  return value?.trim() ?? '';
}

function deriveAdminUrl(clientUrl: string) {
  if (clientUrl.startsWith('wss://')) {
    return `https://${clientUrl.slice('wss://'.length)}`;
  }
  if (clientUrl.startsWith('ws://')) {
    return `http://${clientUrl.slice('ws://'.length)}`;
  }
  return clientUrl;
}

function protocolOf(value: string) {
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

function liveKitErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function redactSensitiveStatusText(value: string) {
  return value.replace(
    /\b(api[_ -]?key|api[_ -]?secret|authorization|bearer|password|secret|token)\b\s*[:=]?\s*["']?[^"',;\s]+["']?/gi,
    (_match, label: string) => `${label} [redacted]`,
  );
}

function truncateStatusText(value: unknown, maxLength = 240) {
  const text = redactSensitiveStatusText(String(value ?? '').replace(/\s+/g, ' ').trim());
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

const liveKitCleanupStatus: LiveKitCleanupStatus = {
  attemptedCount: 0,
  failedCount: 0,
  notFoundCount: 0,
  pendingCount: 0,
  retryCount: 0,
  skippedCount: 0,
  successCount: 0,
};

const liveKitCleanupRetryDelaysMs = process.env.NODE_ENV === 'test' ? [0, 0] : [250, 1_000];

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markLiveKitCleanupAttempt(context: LiveKitCleanupContext, result: LiveKitCleanupResult) {
  const timestamp = new Date().toISOString();
  if (!result.attempted) {
    liveKitCleanupStatus.skippedCount += 1;
    return;
  }

  liveKitCleanupStatus.attemptedCount += 1;
  liveKitCleanupStatus.retryCount += Math.max(0, Math.floor(result.attempts ?? 1) - 1);
  liveKitCleanupStatus.lastAttemptAt = timestamp;
  if (result.ok) {
    liveKitCleanupStatus.successCount += 1;
    liveKitCleanupStatus.lastSuccessAt = timestamp;
    if (result.notFound) {
      liveKitCleanupStatus.notFoundCount += 1;
    }
    return;
  }

  liveKitCleanupStatus.failedCount += 1;
  liveKitCleanupStatus.lastFailure = {
    at: timestamp,
    configured: result.configured,
    error: truncateStatusText(liveKitErrorMessage(result.error ?? 'Unknown LiveKit cleanup failure')),
    operation: context.operation,
    trigger: truncateStatusText(context.trigger, 80),
  };
}

function isLiveKitNotFoundError(error: unknown) {
  const message = liveKitErrorMessage(error).toLowerCase();
  return message.includes('not_found') || message.includes('not found') || message.includes('does not exist');
}

const getConfig = () => {
  const clientUrl = cleanEnv(process.env.LIVEKIT_URL);
  const explicitAdminUrl = cleanEnv(process.env.LIVEKIT_API_URL);
  const adminUrlSource: LiveKitAdminUrlSource = explicitAdminUrl
    ? 'LIVEKIT_API_URL'
    : clientUrl
      ? 'LIVEKIT_URL'
      : 'none';
  return {
    url: clientUrl,
    adminUrl: explicitAdminUrl || deriveAdminUrl(clientUrl),
    adminUrlSource,
    apiKey: cleanEnv(process.env.LIVEKIT_API_KEY),
    apiSecret: cleanEnv(process.env.LIVEKIT_API_SECRET),
  };
};

export const isLiveKitEnabled = () => {
  const config = getConfig();
  return Boolean(config.url && config.apiKey && config.apiSecret);
};

export const isLiveKitAdminConfigured = () => {
  const config = getConfig();
  return Boolean(config.adminUrl && config.apiKey && config.apiSecret);
};

let roomServiceClient: RoomServiceClient | null = null;
let roomServiceClientKey = '';

function getRoomServiceClient() {
  const config = getConfig();
  if (!config.adminUrl || !config.apiKey || !config.apiSecret) {
    return null;
  }

  const key = `${config.adminUrl}\n${config.apiKey}\n${config.apiSecret}`;
  if (!roomServiceClient || roomServiceClientKey !== key) {
    roomServiceClient = new RoomServiceClient(config.adminUrl, config.apiKey, config.apiSecret, {
      requestTimeout: 5,
    });
    roomServiceClientKey = key;
  }
  return roomServiceClient;
}

export async function getLiveKitStatus(options: { checkAdmin?: boolean } = {}) {
  const config = getConfig();
  const status: {
    enabled: boolean;
    clientUrlConfigured: boolean;
    adminConfigured: boolean;
    adminUrlSource: LiveKitAdminUrlSource;
    clientUrlProtocol?: string;
    adminUrlProtocol?: string;
    adminReachable?: boolean;
    adminError?: string;
  } = {
    enabled: isLiveKitEnabled(),
    clientUrlConfigured: Boolean(config.url),
    adminConfigured: isLiveKitAdminConfigured(),
    adminUrlSource: config.adminUrlSource,
    clientUrlProtocol: protocolOf(config.url),
    adminUrlProtocol: protocolOf(config.adminUrl),
  };

  if (!options.checkAdmin || !status.adminConfigured) {
    return status;
  }

  const roomService = getRoomServiceClient();
  if (!roomService) {
    return { ...status, adminReachable: false, adminError: 'LiveKit admin client is not configured.' };
  }

  try {
    await roomService.listRooms([]);
    return { ...status, adminReachable: true };
  } catch (error) {
    return {
      ...status,
      adminReachable: false,
      adminError: liveKitErrorMessage(error).slice(0, 240),
    };
  }
}

function fallbackVoiceSessionId() {
  return randomBytes(8).toString('hex');
}

export function buildLiveKitIdentity(accountId: string, voiceSessionId = fallbackVoiceSessionId()) {
  return `${accountId}:${voiceSessionId}`;
}

export async function issueLiveKitToken(
  roomName: string,
  accountId: string,
  voiceSessionId?: string,
): Promise<VoiceTokenResponse> {
  const config = getConfig();
  const identity = buildLiveKitIdentity(accountId, voiceSessionId);

  if (!config.url || !config.apiKey || !config.apiSecret) {
    return {
      configured: false,
      identity,
      roomName,
      reason: 'LIVEKIT_URL、LIVEKIT_API_KEY 或 LIVEKIT_API_SECRET 未配置。',
    };
  }

  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    ttl: '20m',
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  return {
    configured: true,
    url: config.url,
    identity,
    roomName,
    token: await token.toJwt(),
  };
}

export async function closeLiveKitRoom(roomName?: string | null) {
  const normalized = roomName?.trim();
  if (!normalized) {
    return { attempted: false as const, configured: isLiveKitAdminConfigured() };
  }

  const roomService = getRoomServiceClient();
  if (!roomService) {
    return { attempted: false as const, configured: false };
  }

  let attempts = 0;
  let lastError: unknown;
  for (let retryIndex = 0; retryIndex <= liveKitCleanupRetryDelaysMs.length; retryIndex += 1) {
    attempts += 1;
    try {
      await roomService.deleteRoom(normalized);
      return { attempted: true as const, attempts, configured: true, ok: true as const };
    } catch (error) {
      if (isLiveKitNotFoundError(error)) {
        return { attempted: true as const, attempts, configured: true, ok: true as const, notFound: true as const };
      }
      lastError = error;
      if (retryIndex < liveKitCleanupRetryDelaysMs.length) {
        await delay(liveKitCleanupRetryDelaysMs[retryIndex] ?? 0);
      }
    }
  }
  console.warn(`Failed to close LiveKit room ${normalized}.`, lastError);
  return { attempted: true as const, attempts, configured: true, ok: false as const, error: lastError };
}

export async function removeLiveKitParticipantsByAccount(roomName: string | null | undefined, accountId: string) {
  const normalizedRoom = roomName?.trim();
  const normalizedAccount = accountId.trim();
  if (!normalizedRoom || !normalizedAccount) {
    return { attempted: false as const, configured: isLiveKitAdminConfigured(), removed: 0 };
  }

  const roomService = getRoomServiceClient();
  if (!roomService) {
    return { attempted: false as const, configured: false, removed: 0 };
  }

  let attempts = 0;
  let lastError: unknown;
  for (let retryIndex = 0; retryIndex <= liveKitCleanupRetryDelaysMs.length; retryIndex += 1) {
    attempts += 1;
    try {
      const participants = await roomService.listParticipants(normalizedRoom);
      const identities = participants
        .map((participant) => participant.identity)
        .filter((identity): identity is string => Boolean(identity?.startsWith(`${normalizedAccount}:`)));

      await Promise.all(identities.map((identity) => roomService.removeParticipant(normalizedRoom, identity)));
      return { attempted: true as const, attempts, configured: true, ok: true as const, removed: identities.length };
    } catch (error) {
      if (isLiveKitNotFoundError(error)) {
        return { attempted: true as const, attempts, configured: true, ok: true as const, removed: 0, notFound: true as const };
      }
      lastError = error;
      if (retryIndex < liveKitCleanupRetryDelaysMs.length) {
        await delay(liveKitCleanupRetryDelaysMs[retryIndex] ?? 0);
      }
    }
  }
  console.warn(`Failed to remove LiveKit participants for account ${normalizedAccount} in room ${normalizedRoom}.`, lastError);
  return { attempted: true as const, attempts, configured: true, ok: false as const, removed: 0, error: lastError };
}

export function observeLiveKitCleanup(promise: Promise<LiveKitCleanupResult>, context: LiveKitCleanupContext) {
  liveKitCleanupStatus.pendingCount += 1;
  void promise
    .then((result) => {
      markLiveKitCleanupAttempt(context, result);
    })
    .catch((error) => {
      markLiveKitCleanupAttempt(context, {
        attempted: true,
        configured: isLiveKitAdminConfigured(),
        ok: false,
        error,
      });
    })
    .finally(() => {
      liveKitCleanupStatus.pendingCount = Math.max(0, liveKitCleanupStatus.pendingCount - 1);
    });
}

export function getLiveKitCleanupStatus() {
  return {
    ...liveKitCleanupStatus,
    lastFailure: liveKitCleanupStatus.lastFailure ? { ...liveKitCleanupStatus.lastFailure } : undefined,
  };
}

export function resetLiveKitCleanupStatusForTests() {
  liveKitCleanupStatus.attemptedCount = 0;
  liveKitCleanupStatus.failedCount = 0;
  liveKitCleanupStatus.lastAttemptAt = undefined;
  liveKitCleanupStatus.lastFailure = undefined;
  liveKitCleanupStatus.lastSuccessAt = undefined;
  liveKitCleanupStatus.notFoundCount = 0;
  liveKitCleanupStatus.pendingCount = 0;
  liveKitCleanupStatus.retryCount = 0;
  liveKitCleanupStatus.skippedCount = 0;
  liveKitCleanupStatus.successCount = 0;
}

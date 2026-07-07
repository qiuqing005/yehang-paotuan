import { createSlidingWindowRateLimit } from './rate-limit.js';

type InteractionWriteKind = 'direct-message' | 'room-chat' | 'room-dice';

const interactionWriteRateLimit = createSlidingWindowRateLimit({
  windowMs: 10_000,
  maxAttempts: 30,
  maxKeys: 20_000,
});

export function checkInteractionWriteRateLimit(input: {
  accountId: string;
  kind: InteractionWriteKind;
}) {
  return interactionWriteRateLimit(`message-write:${input.accountId}`);
}

export function interactionRateLimitError(kind: InteractionWriteKind) {
  return kind === 'room-dice'
    ? '掷骰过于频繁，请稍后再试。'
    : '发送过于频繁，请稍后再试。';
}

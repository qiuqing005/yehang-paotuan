export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function createSlidingWindowRateLimit(input: { windowMs: number; maxAttempts: number; maxKeys?: number }) {
  const attempts = new Map<string, number[]>();
  const maxKeys = input.maxKeys ?? 5000;

  return (key: string, options: { record?: boolean } = {}): RateLimitResult => {
    const timestamp = Date.now();
    const windowStart = timestamp - input.windowMs;
    if (attempts.size >= maxKeys) {
      attempts.forEach((items, attemptKey) => {
        const recentItems = items.filter((item) => item > windowStart);
        if (recentItems.length === 0) {
          attempts.delete(attemptKey);
        } else {
          attempts.set(attemptKey, recentItems);
        }
      });
    }
    while (attempts.size >= maxKeys && !attempts.has(key)) {
      const oldestKey = attempts.keys().next().value;
      if (!oldestKey) {
        break;
      }
      attempts.delete(oldestKey);
    }
    const recentAttempts = (attempts.get(key) ?? []).filter((item) => item > windowStart);
    if (recentAttempts.length >= input.maxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recentAttempts[0] + input.windowMs - timestamp) / 1000));
      attempts.set(key, recentAttempts);
      return { ok: false, retryAfterSeconds };
    }

    if (options.record !== false) {
      recentAttempts.push(timestamp);
      attempts.set(key, recentAttempts);
    } else {
      attempts.set(key, recentAttempts);
    }
    return { ok: true };
  };
}

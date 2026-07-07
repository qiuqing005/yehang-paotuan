import { beforeEach, describe, expect, it } from 'vitest';
import {
  getLiveKitCleanupStatus,
  observeLiveKitCleanup,
  resetLiveKitCleanupStatusForTests,
} from './livekit.js';

function waitForCleanupObserver() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('LiveKit cleanup diagnostics', () => {
  beforeEach(() => {
    resetLiveKitCleanupStatusForTests();
  });

  it('tracks cleanup success, skips, and sanitized failures', async () => {
    observeLiveKitCleanup(Promise.resolve({ attempted: false, configured: false }), {
      operation: 'close-room',
      trigger: 'empty-room-name',
    });
    observeLiveKitCleanup(Promise.resolve({ attempted: true, attempts: 2, configured: true, ok: true, notFound: true }), {
      operation: 'close-room',
      trigger: 'not-found-repeat-cleanup',
    });
    observeLiveKitCleanup(Promise.resolve({
      attempted: true,
      attempts: 3,
      configured: true,
      ok: false,
      error: new Error('admin secret abc123 failed with a long transient error'),
    }), {
      operation: 'remove-account-participants',
      trigger: 'voice-disconnect-grace-expired',
    });

    await waitForCleanupObserver();

    const status = getLiveKitCleanupStatus();
    expect(status.skippedCount).toBe(1);
    expect(status.attemptedCount).toBe(2);
    expect(status.successCount).toBe(1);
    expect(status.notFoundCount).toBe(1);
    expect(status.failedCount).toBe(1);
    expect(status.pendingCount).toBe(0);
    expect(status.retryCount).toBe(3);
    expect(status.lastFailure).toMatchObject({
      configured: true,
      operation: 'remove-account-participants',
      trigger: 'voice-disconnect-grace-expired',
    });
    expect(status.lastFailure?.error).toContain('secret [redacted]');
    expect(status.lastFailure?.error).not.toContain('abc123');
    expect(status.lastFailure).not.toHaveProperty('roomName');
    expect(status.lastFailure).not.toHaveProperty('accountId');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCorsOrigins = process.env.CORS_ORIGINS;
const originalAppDomain = process.env.APP_DOMAIN;

async function loadCorsConfig(env: { corsOrigins?: string; appDomain?: string }) {
  vi.resetModules();
  if (env.corsOrigins === undefined) {
    delete process.env.CORS_ORIGINS;
  } else {
    process.env.CORS_ORIGINS = env.corsOrigins;
  }
  if (env.appDomain === undefined) {
    delete process.env.APP_DOMAIN;
  } else {
    process.env.APP_DOMAIN = env.appDomain;
  }
  return import('./cors-config.js');
}

describe('cors config', () => {
  afterEach(() => {
    vi.resetModules();
    if (originalCorsOrigins === undefined) {
      delete process.env.CORS_ORIGINS;
    } else {
      process.env.CORS_ORIGINS = originalCorsOrigins;
    }
    if (originalAppDomain === undefined) {
      delete process.env.APP_DOMAIN;
    } else {
      process.env.APP_DOMAIN = originalAppDomain;
    }
  });

  it('derives allowed origins from APP_DOMAIN when CORS_ORIGINS is not set', async () => {
    const { isOriginAllowed } = await loadCorsConfig({ appDomain: 'table.example.com' });

    expect(isOriginAllowed('https://table.example.com')).toBe(true);
    expect(isOriginAllowed('http://table.example.com')).toBe(true);
    expect(isOriginAllowed('https://appassets.androidplatform.net')).toBe(true);
    expect(isOriginAllowed('paotuan://app')).toBe(true);
    expect(isOriginAllowed('file://')).toBe(true);
    expect(isOriginAllowed('https://other.example.com')).toBe(false);
  });

  it('keeps native shell origins when CORS_ORIGINS overrides APP_DOMAIN derived origins', async () => {
    const { isOriginAllowed } = await loadCorsConfig({
      appDomain: 'table.example.com',
      corsOrigins: 'https://explicit.example.com',
    });

    expect(isOriginAllowed('https://explicit.example.com')).toBe(true);
    expect(isOriginAllowed('https://table.example.com')).toBe(false);
    expect(isOriginAllowed('https://appassets.androidplatform.net')).toBe(true);
    expect(isOriginAllowed('paotuan://app')).toBe(true);
    expect(isOriginAllowed('file://')).toBe(true);
  });
});

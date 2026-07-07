import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadCloudMailMailer(fetchMock: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
  process.env.NODE_ENV = 'production';
  process.env.EMAIL_DELIVERY_MODE = '';
  process.env.EMAIL_DEBUG_CODE = 'false';
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';
  process.env.RESEND_API_KEY = '';
  process.env.RESEND_FROM = '';
  process.env.RESEND_FROM_NAME = '';
  process.env.CLOUD_MAIL_BASE_URL = 'https://mail.example.test';
  process.env.CLOUD_MAIL_EMAIL = 'admin@example.test';
  process.env.CLOUD_MAIL_PASSWORD = 'secret';
  process.env.CLOUD_MAIL_TOKEN = '';
  process.env.CLOUD_MAIL_ACCOUNT_ID = '';
  process.env.CLOUD_MAIL_FROM = '';
  process.env.CLOUD_MAIL_FROM_NAME = 'Night Table';
  return import('./mailer.js');
}

async function loadResendMailer(
  fetchMock: ReturnType<typeof vi.fn>,
  mode = 'resend',
  withCloudMail = false,
  apiKey = 're_test_key',
) {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
  process.env.NODE_ENV = 'production';
  process.env.EMAIL_DELIVERY_MODE = mode;
  process.env.EMAIL_DEBUG_CODE = 'false';
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';
  process.env.RESEND_API_KEY = apiKey;
  process.env.RESEND_FROM = 'no-reply@example.com';
  process.env.RESEND_FROM_NAME = 'Night Table';
  process.env.CLOUD_MAIL_BASE_URL = withCloudMail ? 'https://mail.example.test' : '';
  process.env.CLOUD_MAIL_EMAIL = withCloudMail ? 'admin@example.test' : '';
  process.env.CLOUD_MAIL_PASSWORD = withCloudMail ? 'secret' : '';
  process.env.CLOUD_MAIL_TOKEN = '';
  process.env.CLOUD_MAIL_ACCOUNT_ID = '';
  process.env.CLOUD_MAIL_FROM = '';
  process.env.CLOUD_MAIL_FROM_NAME = '';
  return import('./mailer.js');
}

describe('cloud mail delivery', () => {
  beforeEach(() => {
    resetEnv();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    resetEnv();
    vi.unstubAllGlobals();
  });

  it('reports verified Cloud Mail status with the account address', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const headers = new Headers(init?.headers);
      requests.push({ url: parsed.toString(), authorization: headers.get('Authorization') });

      if (parsed.pathname === '/api/login') {
        return jsonResponse({ code: 200, data: { token: 'token-1' } });
      }
      if (parsed.pathname === '/api/my/loginUserInfo') {
        return jsonResponse({
          code: 200,
          data: {
            email: 'admin@example.test',
            account: {
              accountId: 42,
              email: 'sender@example.test',
              name: 'Night Table',
            },
          },
        });
      }
      return jsonResponse({ code: 404, message: 'unexpected path', data: null }, 404);
    });

    const { getEmailDeliveryStatus } = await loadCloudMailMailer(fetchMock);
    const status = await getEmailDeliveryStatus();

    expect(status).toMatchObject({
      enabled: true,
      provider: 'cloud-mail',
      cloudMailConfigured: true,
      cloudMailVerified: true,
      cloudMailAccount: 'sender@example.test',
      smtpConfigured: false,
    });
    expect(requests).toEqual([
      { url: 'https://mail.example.test/api/login', authorization: null },
      { url: 'https://mail.example.test/api/my/loginUserInfo', authorization: 'token-1' },
    ]);
  });

  it('sends registration codes through the Cloud Mail send endpoint', async () => {
    const payloads: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const headers = new Headers(init?.headers);

      if (parsed.pathname === '/api/login') {
        return jsonResponse({ code: 200, data: { token: 'token-1' } });
      }
      if (parsed.pathname === '/api/my/loginUserInfo') {
        expect(headers.get('Authorization')).toBe('token-1');
        return jsonResponse({
          code: 200,
          data: {
            account: {
              accountId: 42,
              email: 'sender@example.test',
              name: 'Night Table',
            },
          },
        });
      }
      if (parsed.pathname === '/api/email/send') {
        expect(headers.get('Authorization')).toBe('token-1');
        payloads.push(JSON.parse(String(init?.body)));
        return jsonResponse({ code: 200, data: { id: 7 } });
      }
      return jsonResponse({ code: 404, message: 'unexpected path', data: null }, 404);
    });

    const { sendRegistrationVerificationMail } = await loadCloudMailMailer(fetchMock);
    const result = await sendRegistrationVerificationMail({
      to: 'player@example.test',
      code: '123456',
      expiresInMinutes: 10,
    });

    expect(result).toEqual({ ok: true, provider: 'cloud-mail' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      sendEmail: 'sender@example.test',
      receiveEmail: ['player@example.test'],
      accountId: 42,
      name: 'Night Table',
      sendType: '',
      emailId: 0,
      attachments: [],
      draftId: null,
    });
    expect(JSON.stringify(payloads[0])).toContain('123456');
  });

  it('reports configured Resend status when delivery mode is resend', async () => {
    const fetchMock = vi.fn();
    const { getEmailDeliveryStatus } = await loadResendMailer(fetchMock);
    const status = await getEmailDeliveryStatus();

    expect(status).toMatchObject({
      enabled: true,
      provider: 'resend',
      cloudMailConfigured: false,
      resendConfigured: true,
      resendFrom: 'no-reply@example.com',
      smtpConfigured: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends registration codes through Resend when selected', async () => {
    const payloads: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(String(url)).toBe('https://api.resend.com/emails');
      expect(headers.get('Authorization')).toBe('Bearer re_test_key');
      payloads.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: 'email-1' });
    });

    const { sendRegistrationVerificationMail } = await loadResendMailer(fetchMock);
    const result = await sendRegistrationVerificationMail({
      to: 'player@example.com',
      code: '654321',
      expiresInMinutes: 10,
    });

    expect(result).toEqual({ ok: true, provider: 'resend' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      from: '"Night Table" <no-reply@example.com>',
      to: ['player@example.com'],
    });
    expect(JSON.stringify(payloads[0])).toContain('654321');
  });

  it('uses Resend by default when both Resend and Cloud Mail are configured', async () => {
    const fetchMock = vi.fn();
    const { getEmailDeliveryStatus } = await loadResendMailer(fetchMock, '', true);
    const status = await getEmailDeliveryStatus();

    expect(status.provider).toBe('resend');
    expect(status.resendConfigured).toBe(true);
  });

  it('reports disabled when resend mode is selected without a Resend key', async () => {
    const fetchMock = vi.fn();
    const { getEmailDeliveryStatus, sendRegistrationVerificationMail } = await loadResendMailer(
      fetchMock,
      'resend',
      true,
      '',
    );

    await expect(getEmailDeliveryStatus()).resolves.toMatchObject({
      enabled: false,
      provider: 'disabled',
      cloudMailConfigured: true,
      resendConfigured: false,
    });
    await expect(
      sendRegistrationVerificationMail({
        to: 'player@example.com',
        code: '654321',
        expiresInMinutes: 10,
      }),
    ).resolves.toMatchObject({
      ok: false,
      provider: 'disabled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

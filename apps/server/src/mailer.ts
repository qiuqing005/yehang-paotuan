import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

type MailResult =
  | { ok: true; provider: 'cloud-mail' | 'resend' | 'smtp' | 'console'; debugCode?: string }
  | { ok: false; provider: 'disabled' | 'cloud-mail' | 'resend' | 'smtp'; error: string };

type VerificationMailInput = {
  to: string;
  code: string;
  expiresInMinutes: number;
};

type MailProvider = 'cloud-mail' | 'resend' | 'smtp' | 'console' | 'disabled';

type EmailDeliveryStatus = {
  enabled: boolean;
  provider: MailProvider;
  cloudMailConfigured: boolean;
  cloudMailVerified?: boolean;
  cloudMailAccount?: string;
  resendConfigured: boolean;
  resendFrom?: string;
  smtpConfigured: boolean;
  smtpVerified?: boolean;
  error?: string;
};

type CloudMailResponse<T> = {
  code: number;
  message?: string;
  data?: T;
};

type CloudMailLoginData = {
  token?: string;
};

type CloudMailAccountData = {
  accountId?: number;
  email?: string;
  name?: string;
};

type CloudMailUserInfo = {
  email?: string;
  name?: string;
  account?: CloudMailAccountData;
};

type CloudMailAuth = {
  token: string;
  accountId: number;
  accountEmail: string;
  accountName: string;
  expiresAt: number;
};

const readBoolean = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const clean = (value: string | undefined) => value?.trim() ?? '';

const smtpHost = process.env.SMTP_HOST ?? process.env.MAIL_SMTP_HOST ?? '';
const smtpPort = Number(process.env.SMTP_PORT ?? process.env.MAIL_SMTP_PORT ?? 587);
const smtpUser = process.env.SMTP_USER ?? process.env.MAIL_SMTP_USER ?? '';
const smtpPass = process.env.SMTP_PASS ?? process.env.MAIL_SMTP_PASS ?? '';
const smtpFrom = process.env.SMTP_FROM ?? process.env.MAIL_FROM ?? smtpUser;
const smtpSecure = readBoolean(process.env.SMTP_SECURE ?? process.env.MAIL_SMTP_SECURE) ?? smtpPort === 465;
const emailFromName = process.env.EMAIL_FROM_NAME ?? '夜航跑团桌';
const deliveryMode = clean(process.env.EMAIL_DELIVERY_MODE).toLowerCase();
const debugCodeEnabled = readBoolean(process.env.EMAIL_DEBUG_CODE) ?? false;
const parsedSmtpTimeoutMs = Number(process.env.SMTP_TIMEOUT_MS ?? 10_000);
const smtpTimeoutMs = Number.isFinite(parsedSmtpTimeoutMs) && parsedSmtpTimeoutMs > 0 ? parsedSmtpTimeoutMs : 10_000;
const resendApiKey = clean(process.env.RESEND_API_KEY);
const cloudMailBaseUrl = clean(process.env.CLOUD_MAIL_BASE_URL);
const cloudMailEmail = clean(process.env.CLOUD_MAIL_EMAIL);
const cloudMailPassword = clean(process.env.CLOUD_MAIL_PASSWORD);
const cloudMailToken = clean(process.env.CLOUD_MAIL_TOKEN);
const parsedCloudMailAccountId = Number(process.env.CLOUD_MAIL_ACCOUNT_ID ?? 0);
const cloudMailAccountId = Number.isFinite(parsedCloudMailAccountId) && parsedCloudMailAccountId > 0 ? parsedCloudMailAccountId : 0;
const cloudMailFrom = clean(process.env.CLOUD_MAIL_FROM);
const cloudMailFromName = clean(process.env.CLOUD_MAIL_FROM_NAME) || emailFromName;
const resendFrom = clean(process.env.RESEND_FROM) || cloudMailFrom || cloudMailEmail || smtpFrom;
const resendFromName = clean(process.env.RESEND_FROM_NAME) || cloudMailFromName || emailFromName;
const parsedCloudMailTimeoutMs = Number(process.env.CLOUD_MAIL_TIMEOUT_MS ?? smtpTimeoutMs);
const cloudMailTimeoutMs =
  Number.isFinite(parsedCloudMailTimeoutMs) && parsedCloudMailTimeoutMs > 0 ? parsedCloudMailTimeoutMs : smtpTimeoutMs;
const forcedConsoleDelivery = deliveryMode === 'console';
const consoleDeliveryEnabled =
  forcedConsoleDelivery || debugCodeEnabled || process.env.NODE_ENV !== 'production';

let transporter: Transporter | null = null;
let smtpVerifyCache: { checkedAt: number; ok: boolean; error?: string } | null = null;
let cloudMailAuthCache: CloudMailAuth | null = null;
let cloudMailVerifyCache: { checkedAt: number; ok: boolean; error?: string; account?: string } | null = null;

function hasSmtpConfig() {
  return Boolean(smtpHost && smtpFrom);
}

function hasCloudMailConfig() {
  return Boolean(cloudMailBaseUrl && (cloudMailToken || (cloudMailEmail && cloudMailPassword)));
}

function hasResendConfig() {
  return Boolean(resendApiKey && resendFrom);
}

function activeProvider(): MailProvider {
  if (forcedConsoleDelivery) {
    return 'console';
  }
  if (deliveryMode === 'resend') {
    return hasResendConfig() ? 'resend' : 'disabled';
  }
  if (deliveryMode === 'smtp') {
    return hasSmtpConfig() ? 'smtp' : 'disabled';
  }
  if (deliveryMode === 'cloud-mail') {
    return hasCloudMailConfig() ? 'cloud-mail' : 'disabled';
  }
  if (hasResendConfig()) {
    return 'resend';
  }
  if (hasCloudMailConfig()) {
    return 'cloud-mail';
  }
  if (hasSmtpConfig()) {
    return 'smtp';
  }
  if (consoleDeliveryEnabled) {
    return 'console';
  }
  return 'disabled';
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      connectionTimeout: smtpTimeoutMs,
      greetingTimeout: smtpTimeoutMs,
      socketTimeout: smtpTimeoutMs,
      auth: smtpUser || smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
    });
  }
  return transporter;
}

function fromAddress() {
  if (!emailFromName) {
    return smtpFrom;
  }
  return `"${emailFromName.replaceAll('"', '')}" <${smtpFrom}>`;
}

function resendFromAddress() {
  if (!resendFromName) {
    return resendFrom;
  }
  return `"${resendFromName.replaceAll('"', '')}" <${resendFrom}>`;
}

function cloudMailApiBase() {
  const base = cloudMailBaseUrl.replace(/\/+$/, '');
  return base.endsWith('/api') ? base : `${base}/api`;
}

function cloudMailUrl(path: string) {
  return new URL(path.replace(/^\//, ''), `${cloudMailApiBase()}/`).toString();
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cloudMailTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function cloudMailRequest<T>(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', token);
  }

  const response = await fetchWithTimeout(cloudMailUrl(path), { ...init, headers });
  const body = await response.text();
  let json: CloudMailResponse<T>;
  try {
    json = JSON.parse(body) as CloudMailResponse<T>;
  } catch {
    throw new Error(`Cloud Mail returned non-JSON response: HTTP ${response.status}`);
  }
  if (!response.ok || json.code !== 200) {
    throw new Error(json.message || `Cloud Mail request failed: HTTP ${response.status}`);
  }
  if (json.data === undefined) {
    throw new Error('Cloud Mail response is missing data');
  }
  return json.data;
}

async function sendWithResend(input: { to: string; subject: string; text: string; html: string }) {
  if (!hasResendConfig()) {
    throw new Error('Resend delivery is not configured');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: resendFromAddress(),
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html,
    }),
  });

  if (response.ok) {
    return;
  }

  const body = await response.text();
  try {
    const json = JSON.parse(body) as { message?: string; error?: string };
    throw new Error(json.message || json.error || `Resend request failed: HTTP ${response.status}`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Resend request failed: HTTP ${response.status}`);
    }
    throw error;
  }
}

async function getCloudMailAuth() {
  if (cloudMailAuthCache && cloudMailAuthCache.expiresAt > Date.now()) {
    return cloudMailAuthCache;
  }

  let token = cloudMailToken;
  if (!token) {
    const login = await cloudMailRequest<CloudMailLoginData>('/login', {
      method: 'POST',
      body: JSON.stringify({
        email: cloudMailEmail,
        password: cloudMailPassword,
      }),
    });
    token = login.token ?? '';
  }

  if (!token) {
    throw new Error('Cloud Mail login did not return a token');
  }

  const info = await cloudMailRequest<CloudMailUserInfo>('/my/loginUserInfo', {}, token);
  const accountId = cloudMailAccountId || info.account?.accountId || 0;
  const accountEmail = cloudMailFrom || info.account?.email || info.email || cloudMailEmail;
  const accountName = cloudMailFromName || info.account?.name || info.name || emailFromName;

  if (!accountId || !accountEmail) {
    throw new Error('Cloud Mail account information is incomplete');
  }

  cloudMailAuthCache = {
    token,
    accountId,
    accountEmail,
    accountName,
    expiresAt: Date.now() + 50 * 60 * 1000,
  };
  return cloudMailAuthCache;
}

async function verifyCloudMail() {
  const now = Date.now();
  if (!cloudMailVerifyCache || now - cloudMailVerifyCache.checkedAt > 60_000) {
    try {
      const auth = await getCloudMailAuth();
      cloudMailVerifyCache = { checkedAt: now, ok: true, account: auth.accountEmail };
    } catch (error) {
      cloudMailVerifyCache = {
        checkedAt: now,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return cloudMailVerifyCache;
}

export function isEmailDeliveryEnabled() {
  return activeProvider() !== 'disabled';
}

export async function getEmailDeliveryStatus(): Promise<EmailDeliveryStatus> {
  const provider = activeProvider();
  if (provider === 'console') {
    return {
      enabled: true,
      provider,
      cloudMailConfigured: hasCloudMailConfig(),
      resendConfigured: hasResendConfig(),
      resendFrom: hasResendConfig() ? resendFrom : undefined,
      smtpConfigured: hasSmtpConfig(),
    };
  }

  if (provider === 'resend') {
    return {
      enabled: true,
      provider,
      cloudMailConfigured: hasCloudMailConfig(),
      resendConfigured: hasResendConfig(),
      resendFrom,
      smtpConfigured: hasSmtpConfig(),
    };
  }

  if (provider === 'disabled') {
    return {
      enabled: false,
      provider,
      cloudMailConfigured: hasCloudMailConfig(),
      resendConfigured: hasResendConfig(),
      resendFrom: hasResendConfig() ? resendFrom : undefined,
      smtpConfigured: hasSmtpConfig(),
      error: 'Email delivery is not configured or selected provider is missing configuration',
    };
  }

  if (provider === 'cloud-mail') {
    const verified = await verifyCloudMail();
    return {
      enabled: true,
      provider,
      cloudMailConfigured: true,
      cloudMailVerified: verified.ok,
      cloudMailAccount: verified.account,
      resendConfigured: hasResendConfig(),
      resendFrom: hasResendConfig() ? resendFrom : undefined,
      smtpConfigured: hasSmtpConfig(),
      error: verified.error,
    };
  }

  if (!hasSmtpConfig()) {
    return {
      enabled: consoleDeliveryEnabled,
      provider: consoleDeliveryEnabled ? 'console' : 'disabled',
      cloudMailConfigured: hasCloudMailConfig(),
      resendConfigured: hasResendConfig(),
      resendFrom: hasResendConfig() ? resendFrom : undefined,
      smtpConfigured: false,
    };
  }

  const now = Date.now();
  if (!smtpVerifyCache || now - smtpVerifyCache.checkedAt > 60_000) {
    try {
      await getTransporter().verify();
      smtpVerifyCache = { checkedAt: now, ok: true };
    } catch (error) {
      smtpVerifyCache = {
        checkedAt: now,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    enabled: true,
    provider: 'smtp',
    cloudMailConfigured: hasCloudMailConfig(),
    resendConfigured: hasResendConfig(),
    resendFrom: hasResendConfig() ? resendFrom : undefined,
    smtpConfigured: true,
    smtpVerified: smtpVerifyCache.ok,
    error: smtpVerifyCache.error,
  };
}

export async function sendRegistrationVerificationMail(input: VerificationMailInput): Promise<MailResult> {
  const subject = `夜航跑团桌注册验证码：${input.code}`;
  const text = [
    `你的夜航跑团桌注册验证码是：${input.code}`,
    '',
    `验证码 ${input.expiresInMinutes} 分钟内有效。`,
    '如果不是你本人操作，可以忽略这封邮件。',
  ].join('\n');
  const html = [
    '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033">',
    '<h2>夜航跑团桌注册验证码</h2>',
    `<p>你的验证码是：<strong style="font-size:24px;letter-spacing:4px">${input.code}</strong></p>`,
    `<p>验证码 ${input.expiresInMinutes} 分钟内有效。</p>`,
    '<p>如果不是你本人操作，可以忽略这封邮件。</p>',
    '</div>',
  ].join('');

  const provider = activeProvider();

  if (provider === 'console') {
    console.info(`[email-verification] ${input.to} ${input.code}`);
    return {
      ok: true,
      provider: 'console',
      debugCode: debugCodeEnabled || process.env.NODE_ENV !== 'production' ? input.code : undefined,
    };
  }

  if (provider === 'disabled') {
    return { ok: false, provider: 'disabled', error: 'Email delivery is not configured or selected provider is missing configuration' };
  }

  if (provider === 'resend') {
    try {
      await sendWithResend({
        to: input.to,
        subject,
        text,
        html,
      });
      return { ok: true, provider: 'resend' };
    } catch (error) {
      return {
        ok: false,
        provider: 'resend',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (provider === 'cloud-mail') {
    try {
      const auth = await getCloudMailAuth();
      await cloudMailRequest('/email/send', {
        method: 'POST',
        body: JSON.stringify({
          sendEmail: auth.accountEmail,
          receiveEmail: [input.to],
          accountId: auth.accountId,
          name: auth.accountName,
          subject,
          content: html,
          sendType: '',
          text,
          emailId: 0,
          attachments: [],
          draftId: null,
        }),
      }, auth.token);
      return { ok: true, provider: 'cloud-mail' };
    } catch (error) {
      cloudMailAuthCache = null;
      cloudMailVerifyCache = null;
      return {
        ok: false,
        provider: 'cloud-mail',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!hasSmtpConfig()) {
    if (!consoleDeliveryEnabled) {
      return { ok: false, provider: 'disabled', error: 'Email delivery is not configured' };
    }
    console.info(`[email-verification] ${input.to} ${input.code}`);
    return {
      ok: true,
      provider: 'console',
      debugCode: debugCodeEnabled || process.env.NODE_ENV !== 'production' ? input.code : undefined,
    };
  }

  try {
    await getTransporter().sendMail({
      from: fromAddress(),
      to: input.to,
      subject,
      text,
      html,
    });
    return { ok: true, provider: 'smtp' };
  } catch (error) {
    return {
      ok: false,
      provider: 'smtp',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendPasswordResetVerificationMail(input: VerificationMailInput): Promise<MailResult> {
  const subject = `夜航跑团桌重置密码验证码：${input.code}`;
  const text = [
    `你的夜航跑团桌重置密码验证码是：${input.code}`,
    '',
    `验证码 ${input.expiresInMinutes} 分钟内有效。`,
    '如果不是你本人操作，可以忽略这封邮件。',
  ].join('\n');
  const html = [
    '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033">',
    '<h2>夜航跑团桌重置密码验证码</h2>',
    `<p>你的验证码是：<strong style="font-size:24px;letter-spacing:4px">${input.code}</strong></p>`,
    `<p>验证码 ${input.expiresInMinutes} 分钟内有效。</p>`,
    '<p>如果不是你本人操作，可以忽略这封邮件。</p>',
    '</div>',
  ].join('');

  const provider = activeProvider();

  if (provider === 'console') {
    console.info(`[password-reset-verification] ${input.to} ${input.code}`);
    return {
      ok: true,
      provider: 'console',
      debugCode: debugCodeEnabled || process.env.NODE_ENV !== 'production' ? input.code : undefined,
    };
  }

  if (provider === 'disabled') {
    return { ok: false, provider: 'disabled', error: 'Email delivery is not configured or selected provider is missing configuration' };
  }

  if (provider === 'resend') {
    try {
      await sendWithResend({ to: input.to, subject, text, html });
      return { ok: true, provider: 'resend' };
    } catch (error) {
      return {
        ok: false,
        provider: 'resend',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (provider === 'cloud-mail') {
    try {
      const auth = await getCloudMailAuth();
      await cloudMailRequest('/email/send', {
        method: 'POST',
        body: JSON.stringify({
          sendEmail: auth.accountEmail,
          receiveEmail: [input.to],
          accountId: auth.accountId,
          name: auth.accountName,
          subject,
          content: html,
          sendType: '',
          text,
          emailId: 0,
          attachments: [],
          draftId: null,
        }),
      }, auth.token);
      return { ok: true, provider: 'cloud-mail' };
    } catch (error) {
      cloudMailAuthCache = null;
      cloudMailVerifyCache = null;
      return {
        ok: false,
        provider: 'cloud-mail',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!hasSmtpConfig()) {
    if (!consoleDeliveryEnabled) {
      return { ok: false, provider: 'disabled', error: 'Email delivery is not configured' };
    }
    console.info(`[password-reset-verification] ${input.to} ${input.code}`);
    return {
      ok: true,
      provider: 'console',
      debugCode: debugCodeEnabled || process.env.NODE_ENV !== 'production' ? input.code : undefined,
    };
  }

  try {
    await getTransporter().sendMail({
      from: fromAddress(),
      to: input.to,
      subject,
      text,
      html,
    });
    return { ok: true, provider: 'smtp' };
  } catch (error) {
    return {
      ok: false,
      provider: 'smtp',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const nativeAllowedOrigins = [
  'https://appassets.androidplatform.net',
  'paotuan://app',
  'file://',
  'capacitor://localhost',
  'null',
];

const defaultAllowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  ...nativeAllowedOrigins,
];

function splitOrigins(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function originsFromAppDomain(value: string | undefined) {
  return splitOrigins(value).flatMap((domain) => {
    const normalized = domain.replace(/\/+$/, '');
    if (!normalized) {
      return [];
    }
    if (/^https?:\/\//i.test(normalized)) {
      try {
        return [new URL(normalized).origin];
      } catch {
        return [];
      }
    }
    return [`https://${normalized}`, `http://${normalized}`];
  });
}

function normalizeOrigin(origin: string) {
  const trimmed = origin.trim();
  return trimmed.endsWith('://') ? trimmed : trimmed.replace(/\/+$/, '');
}

const configuredAllowedOrigins = process.env.CORS_ORIGINS
  ? [...splitOrigins(process.env.CORS_ORIGINS), ...nativeAllowedOrigins]
  : [...defaultAllowedOrigins, ...originsFromAppDomain(process.env.APP_DOMAIN)];

export const allowedOrigins = Array.from(new Set(
  configuredAllowedOrigins
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean),
));

export function isOriginAllowed(origin: string | undefined) {
  return !origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

export function corsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
  callback(null, isOriginAllowed(origin));
}

export const socketCorsOrigin = allowedOrigins.includes('*') ? '*' : allowedOrigins;

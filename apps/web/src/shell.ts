export function shouldForceMobileShell(input: { hostname: string; userAgent: string }) {
  return input.hostname === 'appassets.androidplatform.net' || /YehangPaotuanAndroid|Android/i.test(input.userAgent)
}

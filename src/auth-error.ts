/** True for upstream auth failures (401 / invalid_grant / unauthenticated). */
export function isAuthError(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const code = e?.code ?? e?.status ?? e?.response?.status;
  if (code === 401 || code === '401') return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /\b401\b/.test(msg) ||
    msg.includes('invalid_grant') ||
    msg.includes('unauthenticated') ||
    msg.includes('invalid credentials')
  );
}

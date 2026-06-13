/**
 * Builds the `Authorization` header for a Bitbucket token. Bitbucket accepts
 * two shapes of credential, told apart by a colon:
 *
 * - `user:app_password` (Bitbucket Cloud app passwords, or any user:secret
 *   pair) → HTTP Basic.
 * - a bare token (Cloud repository/workspace access tokens, Server/Data Center
 *   HTTP access tokens) → Bearer.
 *
 * Returns `null` for an empty token so callers can omit the header entirely.
 */
export function bitbucketAuthHeader(token: string): string | null {
  const value = token.trim();
  if (!value) return null;
  if (value.includes(':')) return `Basic ${btoa(value)}`;
  return `Bearer ${value}`;
}

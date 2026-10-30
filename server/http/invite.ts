/**
 * Which link the join QR code may encode (audit SEC-9).
 *
 * The lobby asks the server for a QR of the address the host sees. Without a check, any page
 * could get a QR that sends phones to an arbitrary http host. Only this server's own addresses
 * are accepted: its LAN addresses on its port, or the Host the request arrived on.
 */

const MAX_INVITE_URL = 200;

export function pickInviteUrl(requested: unknown, allowedHosts: string[], fallback: string): string {
  if (typeof requested !== 'string' || requested.length > MAX_INVITE_URL) return fallback;
  let url: URL;
  try { url = new URL(requested); }
  catch { return fallback; }
  const pathOk = url.pathname === '/' && (url.search === '' || url.search === '?tv') && !url.hash;
  // Normalise like URL does (lower case, default port 80 dropped) before comparing.
  const normal = (host: string) => { try { return new URL(`http://${host}`).host; } catch { return ''; } };
  const hostOk = allowedHosts.map(normal).includes(url.host);
  return url.protocol === 'http:' && pathOk && hostOk ? `${url.origin}${url.search ? '/?tv' : ''}` : fallback;
}

/**
 * Who may talk to this server (audit SEC-3).
 *
 * Without a check, any web page a guest opens on the LAN could open a WebSocket here, join, and
 * become owner of an empty room. An Origin==Host check alone does not stop DNS rebinding: an
 * attacker's name can be pointed at 192.168.x.x so both headers match. So the Host itself must
 * be a name a LAN game is reached by: an IP literal, localhost, *.localhost, *.local, or this
 * machine's own name. Unusual setups (a router DNS name, a reverse proxy) use ALLOWED_HOSTS,
 * and ALLOW_ANY_ORIGIN=1 turns the guard off.
 */
import net from 'node:net';
import os from 'node:os';

export interface OriginPolicy {
  allowAny: boolean;
  /** Extra Host names (lower-case, no port) from ALLOWED_HOSTS. */
  allowedHosts: Set<string>;
  /** os.hostname(), lower-cased. Windows reports names like DESKTOP-ABC. */
  hostname: string;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env, hostname = os.hostname()): OriginPolicy {
  return {
    allowAny: env.ALLOW_ANY_ORIGIN === '1',
    // Entries may carry a port ("quiz.home:3000"); only the host part is compared.
    allowedHosts: new Set((env.ALLOWED_HOSTS ?? '').split(',').map(hostOnly).filter(Boolean)),
    hostname: hostname.toLowerCase(),
  };
}

/** "Host:port" to a lower-case host. IPv6 literals keep their address: "[fe80::1]:3000" → "fe80::1". */
export function hostOnly(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

function isAllowedHost(host: string, policy: OriginPolicy): boolean {
  return net.isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host === policy.hostname || policy.allowedHosts.has(host);
}

/** Returns why a request is refused, or null when it may proceed. */
export function refusalReason(headers: { host?: string; origin?: string }, policy: OriginPolicy): string | null {
  if (policy.allowAny) return null;
  const host = hostOnly(headers.host ?? '');
  if (!isAllowedHost(host, policy)) return `Host "${host}" is not allowed`;
  // Same-origin page loads and native clients send no Origin; a browser page elsewhere always does.
  if (headers.origin === undefined) return null;
  let originHost: string;
  try { originHost = new URL(headers.origin).host.toLowerCase(); }
  catch { return 'Origin is not a valid URL'; }
  if (originHost !== (headers.host ?? '').trim().toLowerCase()) return `Origin "${headers.origin}" does not match this server`;
  return null;
}

const warned = new Set<string>();

/** Logs each refused host once, with the setting that would let it in. */
export function logRefusal(headers: { host?: string }, reason: string): void {
  const key = hostOnly(headers.host ?? '');
  if (warned.has(key) || warned.size > 100) return;
  warned.add(key);
  console.warn(`[origin] Refused a connection: ${reason}. If this is your own setup, start the server with ` +
    `ALLOWED_HOSTS=${key || '<name>'} (or ALLOW_ANY_ORIGIN=1 to turn the check off).`);
}

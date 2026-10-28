/**
 * LAN helpers: figure out which IPv4 address(es) other devices should use.
 */
import os from 'node:os';

/** Ranks private ranges so the most likely "home Wi-Fi" address is listed first. */
function rank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

/** Names of adapters that are almost never the one guests can reach. */
const VIRTUAL_ADAPTER = /(vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|loopback|tailscale|zerotier|hamachi)/i;

/**
 * @returns {{ address: string, iface: string, likelyVirtual: boolean }[]}
 *          Non-internal IPv4 addresses, best candidates first.
 */
export function getLanAddresses() {
  const result = [];
  for (const [iface, entries] of Object.entries(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      const isV4 = e.family === 'IPv4' || e.family === 4;
      if (!isV4 || e.internal || e.address.startsWith('169.254.')) continue;
      result.push({ address: e.address, iface, likelyVirtual: VIRTUAL_ADAPTER.test(iface) });
    }
  }
  return result.sort(
    (a, b) => Number(a.likelyVirtual) - Number(b.likelyVirtual) || rank(a.address) - rank(b.address),
  );
}

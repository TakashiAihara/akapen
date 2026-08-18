/**
 * What to print for the address a server was actually bound to.
 *
 * `--host 0.0.0.0` is what every invocation read over a LAN passes, and printing it
 * back gives a line that opens nothing. A wildcard bind names no interface, so the
 * addresses of the interfaces it stands for are printed instead. A concrete bind is
 * printed unchanged: the caller has already said what they meant, and there is nothing
 * to derive.
 *
 * Deriving this rather than binding it into the caller is also what lets the same
 * address be recorded somewhere durable later — the port is only known once the socket
 * is listening, so this has to be answerable after `Bun.serve`, which is why nothing
 * here is asynchronous.
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** Bind addresses that mean "every interface" rather than naming one. */
const WILDCARD = new Set(['0.0.0.0', '::']);

/**
 * An IPv6 literal has to be bracketed or the port cannot be told from the address.
 * `http://::1:4300` is not a URL; `http://[::1]:4300` is the same host, openable.
 */
function asUrl(address: string, port: number): string {
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
}

/**
 * The interface carrying the default route, read out of Linux's routing table.
 *
 * Destination and mask both zero is the default route. Several can exist at once — a
 * VPN alongside the LAN — and the kernel picks the lowest metric, so this does too.
 *
 * Parsing is separated from reading because the file only exists on Linux: everywhere
 * else this returns null and the order is left as the OS reported it.
 */
export function defaultRouteInterface(routeTable: string): string | null {
  let best: { iface: string; metric: number } | null = null;
  // The first line is the column header.
  for (const line of routeTable.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    if (fields[1] !== '00000000' || fields[7] !== '00000000') continue;
    const parsed = Number(fields[6]);
    const metric = Number.isInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    if (!best || metric < best.metric) best = { iface: fields[0]!, metric };
  }
  return best?.iface ?? null;
}

/** Reading it must never be the reason akapen does not start, so a failure is "unknown". */
function defaultRouteName(): string | null {
  try {
    return defaultRouteInterface(readFileSync('/proc/net/route', 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every non-loopback IPv4 address of this machine, the one on `preferred` first.
 *
 * All of them, because a development host has several — a LAN address, docker bridges,
 * possibly a VPN — and picking one means guessing wrong on some machine. Ordering says
 * which is most likely without hiding the rest.
 *
 * IPv4 only: the non-loopback IPv6 addresses on a typical host are link-local, and a
 * link-local address without its zone identifier is a URL that cannot be opened, which
 * is the thing this module exists to stop printing.
 */
export function orderedIPv4(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  preferred: string | null,
): string[] {
  const names = Object.keys(interfaces);
  const ordered =
    preferred !== null && names.includes(preferred)
      ? [preferred, ...names.filter((name) => name !== preferred)]
      : names;

  const found: string[] = [];
  for (const name of ordered) {
    for (const info of interfaces[name] ?? []) {
      if (info.internal || info.family !== 'IPv4') continue;
      // One address can be reported under two names (an alias, a bridge member).
      if (!found.includes(info.address)) found.push(info.address);
    }
  }
  return found;
}

/** This machine's addresses, as printed. */
export function localAddresses(): string[] {
  return orderedIPv4(networkInterfaces(), defaultRouteName());
}

/**
 * The URLs to print for a server bound to `host` and listening on `port`.
 *
 * The first is the one to hand over; the rest are the same server reached another way.
 *
 * A wildcard bind with no non-loopback interface — an isolated container — falls back
 * to loopback rather than to the wildcard: the server does answer there, so it is the
 * one address that is both true and openable.
 */
export function urlsFor(
  host: string,
  port: number,
  addresses: string[] = localAddresses(),
): [string, ...string[]] {
  if (!WILDCARD.has(host)) return [asUrl(host, port)];
  // The tuple is the point: there is always a first URL to hand over, so no caller has
  // to answer what to print when the list came back empty.
  const [first, ...rest] = addresses;
  if (first === undefined) return [asUrl('127.0.0.1', port)];
  return [asUrl(first, port), ...rest.map((address) => asUrl(address, port))];
}

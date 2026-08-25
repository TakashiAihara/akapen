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
import { allowedHostnames } from './hosts.ts';

/**
 * Whether what was typed was meant as an address at all.
 *
 * Only used to choose which refusal to print, so it costs nothing when it is wrong: an
 * interface whose name happens to be spelled out of hex digits gets the other sentence,
 * and both say the value was not accepted.
 */
const ADDRESS_SHAPED = /^\[?[0-9a-f.:]+\]?$/i;

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

/**
 * Thrown when `--advertise` names something this server will not answer to.
 *
 * Its own class because the CLI prints it as a usage error — the value came from the
 * command line, and the person who typed it is the one who can fix it.
 */
export class AdvertiseError extends Error {}

/**
 * The address to advertise, out of what the operator asked for.
 *
 * Printing every address is honest and still leaves the reader picking one out of three
 * that cannot work, so the choice can be made once and pinned. What is pinned is checked
 * rather than believed: `allowedHostnames` is the set of names the server answers to, so
 * an address outside it would be advertised and then refused with a 403 by this same
 * process. Failing at startup names the mistake while the person who made it is looking.
 *
 * This is what separates it from the `--lan` / `--wan` flag #87 rejected. That was a
 * posture label nothing could verify; this is a selection out of a set already computed,
 * and with a wildcard bind every local address is in it — so pinning one changes what is
 * printed and nothing about what is served.
 *
 * A hostname is refused rather than resolved. `hosts.ts` leaves this machine's own name
 * out of the set on purpose: a name is the one entry somebody else on the network can
 * claim, and rebinding it yields a same-origin page rather than a cross-origin one.
 * Advertising a name would mean widening that set, which is a decision belonging to #9.
 *
 * @param requested  an address, or the name of an interface to take one from
 * @param bind       what `--host` was given, which decides what the server answers to
 */
export function resolveAdvertised(
  requested: string,
  bind: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  allowed: Set<string> = allowedHostnames(bind),
): string {
  const name = requested.trim();
  if (name === '') throw new AdvertiseError('--advertise needs an address or an interface name');

  // Addresses first, and `localhost` with them: an interface is never named like either,
  // so nothing is shadowed, and it means the common case never touches the interface list.
  const literal = name.toLowerCase();
  if (allowed.has(literal)) return literal;

  const iface = interfaces[name];
  if (iface === undefined) {
    // Two different mistakes reach here and the fix for each is different, so they are
    // not given the same sentence. An address that is merely not served is answered with
    // what is bound; telling somebody who typed an address that hostnames do not work
    // sends them looking in the wrong place.
    throw new AdvertiseError(
      ADDRESS_SHAPED.test(name)
        ? `--advertise: a server bound to ${bind} does not answer to ${name}`
        : `--advertise: no interface named ${JSON.stringify(name)}. ` +
            `A hostname cannot be advertised — only literal addresses and localhost are served.`,
    );
  }

  // Every IPv4 the interface carries, loopback included. Whether it can be served is the
  // next check's question, and `lo` is a legitimate thing to pin on a host reached by a
  // tunnel. IPv6 is left out for the same reason it is left out of the default listing.
  const address = iface.find((info) => info.family === 'IPv4')?.address.toLowerCase();
  if (address === undefined) {
    throw new AdvertiseError(`--advertise: ${name} has no IPv4 address`);
  }
  if (!allowed.has(address)) {
    throw new AdvertiseError(
      `--advertise: ${name} is ${address}, which a server bound to ${bind} does not answer to`,
    );
  }
  return address;
}

/**
 * What gets printed as the address to open.
 *
 * The failure this covers is not a crash: `http://0.0.0.0:4300` is a line that looks
 * right, is copied, and opens nothing. Every case here is a way of printing something
 * that cannot be opened — the wildcard itself, a link-local IPv6 address with no zone,
 * an unbracketed IPv6 literal, or a docker bridge put ahead of the LAN address.
 */
import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  AdvertiseError,
  defaultRouteInterface,
  orderedIPv4,
  resolveAdvertised,
  urlsFor,
} from '../src/addresses.ts';

const HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
const route = (...rows: string[]) => [HEADER, ...rows].join('\n');

/** Fields are Iface, Destination, Gateway, Flags, RefCnt, Use, Metric, Mask, and three more. */
const row = (iface: string, destination: string, metric: number, mask: string) =>
  [iface, destination, '0100A8C0', '0003', '0', '0', String(metric), mask, '0', '0', '0'].join('\t');

const DEFAULT_ROUTE = (iface: string, metric = 0) => row(iface, '00000000', metric, '00000000');
const SUBNET_ROUTE = (iface: string) => row(iface, '0000A8C0', 0, '00FFFFFF');

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

const ipv6 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/64`,
  scopeid: 2,
});

describe('the default route', () => {
  it('names the interface it leaves by', () => {
    expect(defaultRouteInterface(route(DEFAULT_ROUTE('eth0'), SUBNET_ROUTE('eth0')))).toBe('eth0');
  });

  it('takes the lowest metric when a VPN adds a second default route', () => {
    // eth0 is listed first and still loses: the kernel goes by metric, so this does too.
    const table = route(DEFAULT_ROUTE('eth0', 100), DEFAULT_ROUTE('wg0', 50));
    expect(defaultRouteInterface(table)).toBe('wg0');
  });

  it('does not mistake a subnet route for the default one', () => {
    expect(defaultRouteInterface(route(SUBNET_ROUTE('eth0'), SUBNET_ROUTE('docker0')))).toBe(null);
  });

  it('answers null rather than guessing when the table says nothing', () => {
    expect(defaultRouteInterface('')).toBe(null);
    expect(defaultRouteInterface(route())).toBe(null);
    expect(defaultRouteInterface('not a routing table at all')).toBe(null);
  });
});

describe('the addresses of this machine', () => {
  const INTERFACES = {
    lo: [ipv4('127.0.0.1', true), ipv6('::1', true)],
    docker0: [ipv4('172.17.0.1')],
    eth0: [ipv4('192.168.0.151'), ipv6('fe80::be24:11ff:fef1:429b')],
  };

  it('puts the default route interface first', () => {
    expect(orderedIPv4(INTERFACES, 'eth0')).toEqual(['192.168.0.151', '172.17.0.1']);
  });

  it('leaves the order alone when the default route is on an interface that is not listed', () => {
    // The other direction of the same rule: reordering has to be something it only does
    // when it knows which one to move, or a wrong guess replaces no guess at all.
    expect(orderedIPv4(INTERFACES, 'wg0')).toEqual(['172.17.0.1', '192.168.0.151']);
  });

  it('leaves the order alone when there is no default route to go by', () => {
    expect(orderedIPv4(INTERFACES, null)).toEqual(['172.17.0.1', '192.168.0.151']);
  });

  it('leaves out loopback, which is already printed by binding to it', () => {
    expect(orderedIPv4(INTERFACES, 'eth0')).not.toContain('127.0.0.1');
  });

  it('leaves out IPv6, whose non-loopback addresses here are link-local', () => {
    expect(orderedIPv4(INTERFACES, 'eth0').some((address) => address.includes(':'))).toBe(false);
  });

  it('lists an address reported under two interface names once', () => {
    const aliased = { eth0: [ipv4('192.168.0.151')], 'eth0:1': [ipv4('192.168.0.151')] };
    expect(orderedIPv4(aliased, 'eth0')).toEqual(['192.168.0.151']);
  });

  it('answers with nothing rather than inventing one when every interface is loopback', () => {
    expect(orderedIPv4({ lo: [ipv4('127.0.0.1', true)] }, null)).toEqual([]);
  });
});

describe('the URL to print', () => {
  it('prints a concrete bind unchanged, because it was already an answer', () => {
    expect(urlsFor('192.168.0.151', 4300, ['10.0.0.1'])).toEqual(['http://192.168.0.151:4300']);
    expect(urlsFor('127.0.0.1', 4300, ['10.0.0.1'])).toEqual(['http://127.0.0.1:4300']);
  });

  it('replaces a wildcard bind with the addresses it stands for', () => {
    expect(urlsFor('0.0.0.0', 4300, ['192.168.0.151', '172.17.0.1'])).toEqual([
      'http://192.168.0.151:4300',
      'http://172.17.0.1:4300',
    ]);
    expect(urlsFor('::', 4300, ['192.168.0.151'])).toEqual(['http://192.168.0.151:4300']);
  });

  it('never prints the wildcard itself, which is the line that opens nothing', () => {
    for (const url of urlsFor('0.0.0.0', 4300, ['192.168.0.151'])) expect(url).not.toContain('0.0.0.0');
    for (const url of urlsFor('0.0.0.0', 4300, [])) expect(url).not.toContain('0.0.0.0');
  });

  it('falls back to loopback when a wildcard bind has no interface to name', () => {
    // An isolated container. The server does answer on loopback, so it is the one
    // address that is both true and openable.
    expect(urlsFor('0.0.0.0', 4300, [])).toEqual(['http://127.0.0.1:4300']);
  });

  it('brackets an IPv6 literal so the port can be told from the address', () => {
    expect(urlsFor('::1', 4300, [])).toEqual(['http://[::1]:4300']);
    expect(urlsFor('0.0.0.0', 4300, ['fd00::1'])).toEqual(['http://[fd00::1]:4300']);
  });

  it('leaves an IPv6 literal that arrives already bracketed alone', () => {
    // Both spellings reach here: `--host` takes either, and `allowedHostnames` keeps
    // both, so `--advertise` can hand back a bracketed one. `http://[[::1]]:4300` is no
    // more openable than the unbracketed form the bracketing exists to prevent.
    expect(urlsFor('[::1]', 4300, [])).toEqual(['http://[::1]:4300']);
    expect(urlsFor('0.0.0.0', 4300, ['[fd00::1]'])).toEqual(['http://[fd00::1]:4300']);
  });

  it('treats [::] as the wildcard it is, not as an address to print back', () => {
    // `allowedHostnames` already reads both spellings as the wildcard. Calling it
    // concrete here printed the bind address back, which is the whole failure.
    expect(urlsFor('[::]', 4300, ['192.168.0.151'])).toEqual(['http://192.168.0.151:4300']);
    expect(urlsFor('::', 4300, ['192.168.0.151'])).toEqual(['http://192.168.0.151:4300']);
  });

  it('prints the port it was given, including the one the OS chose for -p 0', () => {
    expect(urlsFor('0.0.0.0', 51234, ['192.168.0.151'])).toEqual(['http://192.168.0.151:51234']);
  });
});

/**
 * What `--advertise` accepts, and what it refuses.
 *
 * The refusals are the point. A value that names something the server does not answer to
 * would be printed, handed over, and then met with the 403 this same process returns —
 * so every case here is one where failing at startup is the whole of the feature.
 */
describe('the address to advertise', () => {
  const IFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    eth0: [ipv4('192.168.0.151'), ipv6('fe80::be24:11ff:fef1:429b')],
    docker0: [ipv4('172.17.0.1')],
    lo: [ipv4('127.0.0.1', true), ipv6('::1', true)],
    tun0: [ipv6('fd00::1')],
  };
  /** What a wildcard bind answers to on the machine above. */
  const ALLOWED = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    '192.168.0.151',
    '172.17.0.1',
    'fe80::be24:11ff:fef1:429b',
    'fd00::1',
  ]);
  const resolve = (requested: string, bind = '0.0.0.0', allowed = ALLOWED) =>
    resolveAdvertised(requested, bind, IFACES, allowed);

  it('takes an address the server answers to', () => {
    expect(resolve('192.168.0.151')).toBe('192.168.0.151');
    expect(resolve('172.17.0.1')).toBe('172.17.0.1');
  });

  it('takes localhost, which is a name but not a resolved one', () => {
    // The one name in the set nobody else on the network can claim, which is why
    // `hosts.ts` keeps it and leaves this machine's own hostname out.
    expect(resolve('localhost')).toBe('localhost');
  });

  it('takes the IPv4 address of a named interface', () => {
    expect(resolve('eth0')).toBe('192.168.0.151');
    expect(resolve('docker0')).toBe('172.17.0.1');
  });

  it('takes loopback from lo, which the default listing leaves out', () => {
    // Left out of what is printed by default, because nobody wants it advertised by
    // accident. Asked for by name it is a legitimate thing to pin.
    expect(resolve('lo')).toBe('127.0.0.1');
  });

  it('ignores the case and the whitespace around what was typed', () => {
    expect(resolve(' 192.168.0.151 ')).toBe('192.168.0.151');
    expect(resolve('FD00::1')).toBe('fd00::1');
  });

  it('hands back a bracketed IPv6 address in the spelling it was given', () => {
    // Not normalised to the bare form: the caller puts it straight into a URL, and both
    // spellings are in the served set, so changing it would only move the bracketing bug.
    expect(resolve('[::1]')).toBe('[::1]');
    expect(resolve('::1')).toBe('::1');
  });

  it('refuses an address this server does not answer to, and says what it is bound to', () => {
    // Bound to one interface: the LAN address is real, and this server is not on it.
    const loopbackOnly = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    const refuse = () => resolve('192.168.0.151', '127.0.0.1', loopbackOnly);
    expect(refuse).toThrow(AdvertiseError);
    expect(refuse).toThrow('192.168.0.151');
    expect(refuse).toThrow('127.0.0.1');
  });

  it('does not tell somebody who typed an address that hostnames are the problem', () => {
    // The two refusals have different fixes — change the bind, or stop using a name —
    // and one sentence for both sends half the callers looking in the wrong place.
    const unserved = () => resolve('203.0.113.9', '0.0.0.0');
    expect(unserved).toThrow(AdvertiseError);
    expect(unserved).not.toThrow(/hostname/i);
    expect(unserved).not.toThrow(/interface named/i);
  });

  it('refuses an interface whose address this server does not answer to', () => {
    const loopbackOnly = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    // The interface exists and the address is real, so the message has to say which of
    // the two is the problem — naming the interface alone would read as "no such eth0".
    expect(() => resolve('eth0', '127.0.0.1', loopbackOnly)).toThrow('192.168.0.151');
    expect(() => resolve('eth0', '127.0.0.1', loopbackOnly)).toThrow('127.0.0.1');
  });

  it('refuses a hostname, and says a hostname is the thing that cannot work', () => {
    // Not "unknown value": resolving it would succeed and still be refused by the Host
    // check, so the message has to name the category rather than the typo.
    expect(() => resolve('akapen.d1.local')).toThrow(AdvertiseError);
    expect(() => resolve('akapen.d1.local')).toThrow(/hostname/i);
    expect(() => resolve('akapen.d1.local')).toThrow('akapen.d1.local');
  });

  it('refuses a link-local IPv6 address, which the served set does hold', () => {
    // The server answers on it, so the served-set check passes and cannot be what stops
    // it. Without a zone identifier it is still not a URL anybody can open — the same
    // reason the default listing never offers one.
    const refuse = () => resolve('fe80::be24:11ff:fef1:429b');
    expect(refuse).toThrow(AdvertiseError);
    expect(refuse).toThrow(/link-local/i);
    // Bracketed is the same address and has to be refused the same way.
    expect(() =>
      resolve('[fe80::be24:11ff:fef1:429b]', '0.0.0.0', new Set([...ALLOWED, '[fe80::be24:11ff:fef1:429b]'])),
    ).toThrow(/link-local/i);
  });

  it('still takes an IPv6 address that is not link-local', () => {
    // The refusal above is about the zone identifier, not about IPv6.
    expect(resolve('fd00::1')).toBe('fd00::1');
    expect(resolve('::1')).toBe('::1');
  });

  it('refuses an interface carrying no IPv4 address', () => {
    expect(() => resolve('tun0')).toThrow(AdvertiseError);
    expect(() => resolve('tun0')).toThrow('tun0');
  });

  it('refuses an empty value, and says what was missing rather than what was unknown', () => {
    // Asserted on the message, not the class: without the check of its own an empty
    // value falls through to the unknown-value refusal, which also throws AdvertiseError
    // and reports `this host does not answer to ""` — true, and no help at all.
    expect(() => resolve('')).toThrow(/needs an address or an interface name/);
    expect(() => resolve('   ')).toThrow(/needs an address or an interface name/);
  });
});

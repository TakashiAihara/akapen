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
import { defaultRouteInterface, orderedIPv4, urlsFor } from '../src/addresses.ts';

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

  it('prints the port it was given, including the one the OS chose for -p 0', () => {
    expect(urlsFor('0.0.0.0', 51234, ['192.168.0.151'])).toEqual(['http://192.168.0.151:51234']);
  });
});

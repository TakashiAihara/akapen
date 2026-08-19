/**
 * The names this host answers to.
 *
 * This is a security rule with a usability edge on both sides. Too strict and the server
 * refuses the address it was started on — every request a 403 with nothing wrong at the
 * other end. Too loose and the `Host` check stops closing DNS rebinding, which is the
 * only thing standing between a page the reader visits and a cookie the browser will
 * attach for it.
 */
import { hostname, networkInterfaces } from 'node:os';
import { describe, expect, it } from 'vitest';
import { allowedHostnames, hostnameOf } from '../src/hosts.ts';

describe('reading a name off a Host header', () => {
  it('drops the port', () => {
    expect(hostnameOf('localhost:4300')).toBe('localhost');
    expect(hostnameOf('192.168.0.10:4300')).toBe('192.168.0.10');
    expect(hostnameOf('localhost')).toBe('localhost');
  });

  it('keeps an IPv6 literal in its brackets, port or no port', () => {
    // The colons inside are not a port separator, which is the whole reason for brackets.
    expect(hostnameOf('[::1]:4300')).toBe('[::1]');
    expect(hostnameOf('[fd00::1]')).toBe('[fd00::1]');
  });

  it('reads a name spelled with the root dot as the same name', () => {
    // `localhost.` is `localhost` with the root of the DNS tree written out. Clients send
    // it, and a 403 there is a refusal with nothing wrong on the other end.
    expect(hostnameOf('localhost.:4300')).toBe('localhost');
    expect(hostnameOf('MCDEV.LOCAL.')).toBe('mcdev.local');
  });
});

describe('the names a bind address answers to', () => {
  it('always answers to loopback, in both spellings of IPv6', () => {
    const names = allowedHostnames('127.0.0.1');
    for (const name of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('answers to an explicit IPv6 bind, however the header spells it', () => {
    /**
     * `--host` takes an address bare; a browser and curl put a literal one in brackets.
     * Adding only what was passed in meant an explicit IPv6 bind refused every request it
     * had been started to serve — and `::1` hid it, because loopback is in the set above
     * in both forms already.
     */
    const names = allowedHostnames('fd00::1');
    expect(names.has('fd00::1')).toBe(true);
    expect(names.has('[fd00::1]')).toBe(true);
    // What `hostnameOf` will actually hand the check, from `Host: [fd00::1]:4300`.
    expect(names.has(hostnameOf('[fd00::1]:4300'))).toBe(true);
  });

  it('answers to a bracketed IPv6 bind too', () => {
    const names = allowedHostnames('[fd00::1]');
    expect(names.has('[fd00::1]')).toBe(true);
    expect(names.has('fd00::1')).toBe(true);
  });

  it('answers to this machine on a wildcard bind, and to its own name', () => {
    const names = allowedHostnames('0.0.0.0');
    const self = hostname().toLowerCase();
    expect(names.has(self)).toBe(true);
    expect(names.has(self.split('.')[0]!)).toBe(true);
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        expect(names.has(ni.address.toLowerCase()), ni.address).toBe(true);
      }
    }
  });

  it('does not answer to a name it was never given', () => {
    // The negative side. A set that answers to everything is not a check.
    const names = allowedHostnames('0.0.0.0');
    for (const name of ['evil.example', 'attacker.test', '0.0.0.0']) {
      expect(names.has(name), name).toBe(false);
    }
    // `0.0.0.0` in particular: some browsers treat http://0.0.0.0 as loopback, so serving
    // that name is the shape of the attack the Host check exists to refuse.
    expect(allowedHostnames('127.0.0.1').has('0.0.0.0')).toBe(false);
  });

  it('does not answer to every address on the machine when the bind is one of them', () => {
    // A bind to one interface answers there and nowhere else, so the wildcard's set would
    // be wrong here — and wrong in the direction that accepts too much.
    const names = allowedHostnames('127.0.0.1');
    expect(names.has(hostname().toLowerCase())).toBe(true); // reaching it by name is normal
    const other = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .find((ni) => !ni.internal);
    if (other) expect(names.has(other.address.toLowerCase())).toBe(false);
  });
});

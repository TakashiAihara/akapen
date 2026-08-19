/**
 * Which names this host answers to, and how to read one off a request.
 *
 * Here rather than beside the server because these are the whole of a security rule and
 * nothing else in them needs a running server: the server package embeds its assets
 * through import attributes, which the test transform does not implement, so anything
 * living there can only be tested by spawning a process. A rule with cases like these —
 * IPv6 in two spellings, a wildcard bind, a trailing root dot — wants to be checked
 * directly.
 */

import { networkInterfaces } from 'node:os';

/**
 * The hostnames this instance answers to.
 *
 * A token says who on the network may connect. It says nothing about the attack that
 * makes "it only listens on loopback" untrue: a page the reader visits can point its own
 * hostname at `127.0.0.1` after loading — DNS rebinding — and the browser then treats
 * akapen as that page's origin, attaches the cookie itself and lets the page read the
 * answer. Being `HttpOnly` changes nothing; the browser is the one holding it.
 *
 * What the attacker cannot do is choose the `Host` header — it is forbidden to scripts —
 * so refusing every name akapen is not actually serving closes the whole class.
 *
 * A wildcard bind answers on every interface, so every local address is a real name for
 * it. The machine's own hostname is included because reaching it that way is normal
 * (`http://mcdev:4300`), and an attacker who can put that name in a browser's address
 * bar already controls this network's DNS.
 */
/**
 * A literal address as a `Host` header can spell it.
 *
 * IPv6 goes in brackets there and nowhere else; IPv4 and names have one spelling and
 * come back untouched.
 */
function bothForms(address: string): string[] {
  if (address.startsWith('[')) {
    const inner = address.slice(1, address.indexOf(']') === -1 ? undefined : address.indexOf(']'));
    return [address, inner];
  }
  return address.includes(':') ? [address, `[${address}]`] : [address];
}

export function allowedHostnames(bind: string): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const wildcard = bind === '0.0.0.0' || bind === '::' || bind === '[::]';
  if (wildcard) {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        for (const form of bothForms(ni.address.toLowerCase())) names.add(form);
      }
    }
  } else {
    // Both spellings of an IPv6 address. A browser and curl put a literal one in the
    // `Host` header bracketed, and `--host` takes it bare, so adding only what was passed
    // in means an explicit IPv6 bind answers 403 to every request it was started for.
    // `::1` happened to work only because the set above already carries both forms.
    for (const form of bothForms(bind.toLowerCase())) names.add(form);
  }
  /**
   * The machine's own name is deliberately not here.
   *
   * It was, and reaching akapen as `http://mcdev:4300` is the ordinary thing to want. It
   * is also the one name in the set that somebody else on the network can claim: answer
   * mDNS for `mcdev`, serve a page from that name on this port, then rebind the name to
   * this machine. The browser then has a page whose origin — scheme, host and port — is
   * the same as akapen's, so it attaches the cookie, reads every answer, and passes the
   * `Sec-Fetch-Site: same-origin` check on writes as well.
   *
   * An earlier version of this comment claimed that check covered the case. It does not:
   * it separates origins, and rebinding works by making them the same one.
   *
   * Every other name in the set is a literal address or `localhost`. Neither is resolved
   * through anything an attacker can answer, so there is no name left to rebind.
   */
  return names;
}

/**
 * The name out of a `Host` header, without the port.
 *
 * The port is deliberately not checked. Cookies are not isolated by port anyway
 * (RFC 6265 §8.5), so a per-port rule would suggest a separation that does not exist.
 */
export function hostnameOf(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close === -1 ? value : value.slice(0, close + 1);
  }
  const colon = value.lastIndexOf(':');
  const name = colon === -1 ? value : value.slice(0, colon);
  // `localhost.` is the same name as `localhost` — the trailing dot is the root of the
  // DNS tree spelled out. Some clients send it, and refusing them would be a 403 with
  // nothing wrong on the other end.
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

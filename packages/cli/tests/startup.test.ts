/**
 * The startup line, from a real process.
 *
 * The unit tests cover which addresses are chosen; this covers the thing that made it
 * worth doing — that the line printed to the terminal is a URL a browser can open.
 * Nothing short of starting a server and fetching what it printed proves that, and the
 * failure it guards against (`http://0.0.0.0:4300`) is invisible to every other check:
 * the process starts, serves correctly, and prints an address that opens nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const SOURCE = ['# Heading', '', 'A paragraph.', ''].join('\n');

type Started = { lines: string[]; stop: () => void };

let running: (() => void)[] = [];
let sandboxes: string[] = [];

afterEach(() => {
  for (const stop of running) stop();
  running = [];
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes = [];
});

/**
 * Start akapen and collect the startup block. `-p 0` so a port someone left listening
 * on cannot fail this, which is also the case the printed port has to survive.
 */
async function start(extra: string[] = []): Promise<Started> {
  const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
  sandboxes.push(sandbox);
  const file = join(sandbox, 'note.md');
  writeFileSync(file, SOURCE);

  const proc: ChildProcess = spawn('bun', ['run', CLI, file, '-p', '0', ...extra], {
    env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => void proc.kill();
  running.push(stop);

  let out = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  // `store` is the last line of the block for a loopback bind, so waiting for it means
  // every url and also line has already been printed.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`akapen did not start:\n${out}`)), 15_000);
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (!/^\s+store\s+\S/m.test(out)) return;
      clearTimeout(timer);
      resolve();
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`akapen exited with ${code}\n${out}`));
    });
  });
  return { lines: out.split('\n'), stop };
}

const urlsIn = (lines: string[]): string[] =>
  lines.flatMap((line) => /^\s+(?:url|also)\s+(\S+)$/.exec(line)?.slice(1) ?? []);

describe('the startup block', () => {
  it('prints one url for a loopback bind and nothing to choose between', async () => {
    const { lines } = await start();
    const urls = urlsIn(lines);
    expect(urls).toHaveLength(1);
    // The token rides along, because opening the line is the whole of logging in.
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    expect(lines.some((line) => /^\s+also\s/.test(line))).toBe(false);
  }, 30_000);

  it('answers on every url it printed for a wildcard bind', async () => {
    // `--no-auth` so the printed line is the bare address: what is under test is which
    // address was chosen, and appending a path to a url carrying a query would test the
    // test rather than the server. That the token is on the line is asserted above.
    const { lines } = await start(['--host', '0.0.0.0', '--no-auth']);
    const urls = urlsIn(lines);
    expect(urls.length).toBeGreaterThan(0);

    // The whole point: what was printed is not the address it was bound to.
    for (const url of urls) expect(url).not.toContain('0.0.0.0');

    // And it is not merely well formed — the server is there.
    for (const url of urls) {
      const res = await fetch(`${url}/api/doc`);
      expect(res.ok).toBe(true);
    }
  }, 30_000);

  it('prints every non-loopback address of the machine, not one picked out of them', async () => {
    const { lines } = await start(['--host', '0.0.0.0', '--no-auth']);
    const printed = urlsIn(lines).map((url) => new URL(url).hostname);
    const expected = Object.values(networkInterfaces())
      .flatMap((infos) => infos ?? [])
      .filter((info) => !info.internal && info.family === 'IPv4')
      .map((info) => info.address);
    // Compared as a set: which one comes first is the default route's business and is
    // settled in the unit tests, where the routing table can be stated rather than read.
    // An isolated container has none, and loopback is the documented fallback there.
    const wanted = expected.length > 0 ? [...new Set(expected)] : ['127.0.0.1'];
    expect(printed.toSorted()).toEqual(wanted.toSorted());
  }, 30_000);

  it('leaves the rest of the block where it was', async () => {
    // The url line moved and grew; round and store did not, and something reads them.
    const { lines } = await start();
    expect(lines.some((line) => /^\s+round\s+\d{3}$/.test(line))).toBe(true);
    expect(lines.some((line) => /^\s+store\s+\S/.test(line))).toBe(true);
  }, 30_000);
});

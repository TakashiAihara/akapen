import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

/**
 * The step in release.yml that decides the tag, run under GitHub's default shell with the
 * git and bun it calls replaced (#253). Each way it can fail used to write `tag=` and exit
 * 0, which skips the build and leaves a green run that released nothing.
 *
 * The step is cut out of the YAML by indentation rather than a parser, which nothing else
 * here needs. A cut that stops matching leaves an empty script, and every case below then
 * fails on its output rather than passing.
 */

const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)),
  'utf8',
);

const indent = (l: string): number => l.length - l.trimStart().length;

function decideStep(): string {
  const lines = workflow.split('\n');
  const id = lines.findIndex((l) => l.trim() === 'id: decide');
  const at = lines.findIndex((l, i) => i > id && l.trim() === 'run: |');
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== '' && indent(l) <= indent(lines[at] ?? '')) break;
    body.push(l);
  }
  const cut = Math.min(...body.filter((l) => l.trim() !== '').map(indent));
  return body.map((l) => l.slice(cut)).join('\n');
}

const dir = mkdtempSync(join(tmpdir(), 'akapen-release-tag-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'step.sh'), decideStep());

function run(git: string, bun: string): { status: number | null; output: string } {
  for (const [name, body] of [
    ['git', git],
    ['bun', bun],
  ] as const) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
    env: { PATH: `${dir}:${process.env['PATH'] ?? ''}`, EVENT: 'workflow_run', GITHUB_OUTPUT: out },
  });
  return { status: r.status, output: readFileSync(out, 'utf8') };
}

const gitAt = (tags: string): string => `case "$1" in rev-parse) echo abc;; tag) printf '${tags}';; esac`;

describe('release: deciding the tag', () => {
  test('a commit with no tag gets the next one', () => {
    expect(run(gitAt(''), 'echo v0.1.0-rc.40')).toEqual({ status: 0, output: 'tag=v0.1.0-rc.40\n' });
  });

  test('a re-run reuses the first tag on the commit', () => {
    expect(run(gitAt('v0.1.0-rc.3\\nv0.1.0-rc.4\\n'), 'exit 1')).toEqual({
      status: 0,
      output: 'tag=v0.1.0-rc.3\n',
    });
  });

  test.each([
    ['next-tag fails', gitAt(''), 'exit 1'],
    ['next-tag prints nothing', gitAt(''), 'exit 0'],
    ['git cannot list the tags', 'case "$1" in rev-parse) echo abc;; tag) exit 1;; esac', 'echo v9'],
    ['git cannot resolve main', 'case "$1" in rev-parse) exit 1;; tag) :;; esac', 'echo v9'],
  ])('stops instead of releasing nothing when %s', (_, git, bun) => {
    const r = run(git, bun);
    expect(r.status).not.toBe(0);
    expect(r.output).toBe('');
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Dependabot fails quietly. A lockfile no entry covers, and a lockfile its bun cannot read,
 * both look from here exactly like a week with nothing to update. These are the two ways
 * that happens to this repository, written down so they fail out loud instead.
 *
 * The config is read with a regular expression rather than a YAML parser, which is a
 * dependency nothing else here needs. That is safe in the direction that matters: an
 * expression that stops matching finds no ecosystems at all, and finding none fails every
 * assertion below rather than passing them.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(repoRoot + path, 'utf8');
const present = (path: string): boolean => existsSync(repoRoot + path);

const ecosystems = [...read('.github/dependabot.yml').matchAll(/^\s*-\s*package-ecosystem:\s*(\S+)/gm)].map(
  ([, name]) => name,
);

/**
 * A file on the left means the ecosystem on the right has to be in dependabot.yml. Reaching
 * for a second package manager should fail here until the config has heard about it — that
 * is the whole point of the list, so it names more than we use.
 */
const NEEDS_ECOSYSTEM = [
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'npm'],
  ['pnpm-lock.yaml', 'npm'],
  ['Cargo.toml', 'cargo'],
  ['go.mod', 'gomod'],
  ['Gemfile', 'bundler'],
  ['requirements.txt', 'pip'],
] as const;

describe('dependabot', () => {
  test('found the ecosystems in the config', () => {
    expect(ecosystems.length).toBeGreaterThan(0);
  });

  test.each(NEEDS_ECOSYSTEM)('%s, if we have one, is watched by the %s ecosystem', (file, ecosystem) => {
    if (!present(file)) return;
    expect(ecosystems).toContain(ecosystem);
  });

  test('the workflows are watched by the github-actions ecosystem', () => {
    const workflows = readdirSync(repoRoot + '.github/workflows').filter((f) => f.endsWith('.yml'));

    expect(workflows.length).toBeGreaterThan(0);
    expect(ecosystems).toContain('github-actions');
  });

  /**
   * Dependabot runs a bun of its own, pinned in its own Dockerfile, and that bun parses
   * `lockfileVersion: 1` and refuses 2. Bun 1.4 writes 2 by default, so the day we upgrade is
   * the day every update job starts failing where we cannot see it.
   *
   * https://github.com/dependabot/dependabot-core/blob/main/bun/lib/dependabot/bun/bun_package_manager.rb
   */
  test('bun.lock stays at a lockfileVersion the Dependabot bun can read', () => {
    const version = Number(/"lockfileVersion"\s*:\s*(\d+)/.exec(read('bun.lock'))?.[1]);

    expect(version).toBeLessThanOrEqual(1);
  });
});

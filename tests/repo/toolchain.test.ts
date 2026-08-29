import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The release binaries carry a whole Bun inside them, so which Bun built them is part of
 * what ships. While the workflows asked setup-bun for `latest`, rebuilding the same tag a
 * week later produced a different binary, and nothing recorded which one the attestation
 * had signed. Every other input to that job is pinned to a commit; this one was not.
 *
 * So the version lives in `.tool-versions`, which mise reads locally and setup-bun reads
 * in CI, and these tests keep the two consumers from drifting apart again.
 *
 * The workflows are read with regular expressions rather than a YAML parser, which is a
 * dependency nothing else here needs. The set being checked is derived from what each
 * workflow *runs*, not from what it installs with: keying it on setup-bun would mean a
 * workflow that stopped using setup-bun left the set quietly, taking its own assertion
 * with it, and the suite would still be green.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(repoRoot + path, 'utf8');

// Actions reads both spellings, so a repository that only ever wrote .yaml would look
// empty here and pass for the wrong reason.
const workflows = readdirSync(repoRoot + '.github/workflows')
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => [f, read(`.github/workflows/${f}`)] as const);

/** Anything that shells out to bun or bunx needs a bun, however it chooses to get one. */
const runsBun = workflows.filter(([, body]) => /^\s*(?:-\s*)?run:[\s\S]*?\bbunx?\b/m.test(body));

describe('the bun version', () => {
  test('found the workflows that run bun', () => {
    expect(runsBun.length).toBeGreaterThan(0);
  });

  /**
   * setup-bun reads `.tool-versions` with /^bun\s*(?<version>.*?)$/m, so the line has to be
   * one mise would accept and that expression would find. `latest` would parse and would
   * defeat the point, hence the shape of the version rather than its mere presence.
   */
  test('.tool-versions names one concrete bun', () => {
    const line = /^bun\s+(?<version>\S+)\s*$/m.exec(read('.tool-versions'));

    expect(line).not.toBeNull();
    expect(line?.groups?.['version']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test.each(runsBun)('%s installs bun, and takes the version from the file', (_name, body) => {
    expect(body).toContain('oven-sh/setup-bun');
    expect(body).toMatch(/^\s*bun-version-file:\s*\.tool-versions\s*$/m);
    // `latest` is the one that moved underneath us, but any literal here is a second place
    // the version would have to be bumped, which is the thing being prevented.
    expect(body).not.toMatch(/^\s*bun-version:/m);
  });
});

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * What the pre-push hook runs, in what order, and what a failure stops.
 *
 * `packages/server/src/assets.ts` imports `@akapen/web/dist/app.js`, so on a tree where
 * nothing has built it yet every test that starts a server fails to resolve the module.
 * The build has to come first, and a failed build has to stop the hook — otherwise the
 * error arrives underneath the failures it caused, which is how it was read as a test
 * problem rather than a build one (#154).
 *
 * The shape that gets this wrong is not the missing build job; it is `piped: true` over a
 * flat list. `piped` belongs to the hook, so it also cuts between the two checks, and a
 * type error would take the test results with it. The checks therefore sit in one group,
 * which is a single step of the pipe.
 *
 * The structure comes from `lefthook dump`, which is lefthook parsing its own config, and
 * not from reading the file. Two reasons. Reading it line by line means comparing
 * indentation, and a job indented past its sibling then looks the same as a job inside a
 * group — the one distinction this file exists to make. And a YAML parser would only tell
 * us what YAML says, while what matters is what lefthook does with it: `dump` is the
 * merged config, extensions and defaults included, which is the thing that will run.
 */
type Job = { name?: string; run?: string; group?: { parallel?: boolean; piped?: boolean; jobs?: Job[] } };
type Hook = { piped?: boolean; parallel?: boolean; jobs?: Job[] };

const config = JSON.parse(
  execFileSync('bunx', ['lefthook', 'dump', '-f', 'json'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
) as Record<string, Hook>;

const prePush = config['pre-push'] as Hook;
const jobs = () => prePush.jobs ?? [];
const byName = (name: string) => jobs().find((j) => j.name === name);

describe('the pre-push hook', () => {
  test('stops when a step fails, so a build error is not read under its own fallout', () => {
    expect(prePush.piped).toBe(true);
  });

  test('builds the web bundle first, and builds it rather than merely being called that', () => {
    // The name is not the assertion: a first job called build:web that ran something else
    // would leave the tests resolving a module nothing wrote
    expect(jobs()[0]?.name).toBe('build:web');
    expect(jobs()[0]?.run).toBe('bun run build:web');
  });

  test('keeps the checks in one group, so the pipe does not cut between them', () => {
    const checks = byName('checks');
    expect(checks?.group).toBeDefined();
    expect(checks?.group?.jobs?.map((j) => j.name)).toEqual(['typecheck', 'test']);
    expect(checks?.group?.jobs?.map((j) => j.run)).toEqual(['bun run typecheck', 'bun run test']);

    // and nowhere else: a check hoisted out of the group is back on the pipe
    expect(jobs().map((j) => j.name)).toEqual(['build:web', 'checks']);
  });

  test('runs the checks against each other in parallel, not as a second pipe', () => {
    const checks = byName('checks');
    expect(checks?.group?.parallel).toBe(true);
    expect(checks?.group?.piped).toBeUndefined();
    // Nothing here guards `piped` written on the job itself, one level out from the group.
    // lefthook 2.1.10 drops the key — it is not part of a job — and `dump` never shows it,
    // so that shape changes nothing and there is nothing to pin. Measured, not assumed.
  });
});

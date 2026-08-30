import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * What the pre-push hook is allowed to run, and in what order.
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
 * Read as YAML rather than by regular expression: the nesting is the thing being checked,
 * and a regex over indentation would pass on a file that nests differently.
 */
const yaml = readFileSync(fileURLToPath(new URL('../../lefthook.yml', import.meta.url)), 'utf8');

/**
 * A minimal reader for the shape this file has: two levels of `- name:` entries, each
 * with `run:` or `group:`. Enough to say what runs and what it sits inside, and small
 * enough not to add a YAML parser nothing else here needs (`tests/repo/toolchain.test.ts`
 * makes the same trade the other way, and says so).
 */
function prePushJobs(): { name: string; indent: number; kind: 'run' | 'group' }[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.startsWith('pre-push:'));
  expect(start).toBeGreaterThanOrEqual(0);
  const out: { name: string; indent: number; kind: 'run' | 'group' }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\S/.test(line)) break; // the next top-level key ends the hook
    const named = /^(\s*)- name:\s*(\S+)/.exec(line);
    if (!named) continue;
    const rest = lines.slice(i + 1, i + 4).join('\n');
    out.push({
      name: named[2]!,
      indent: named[1]!.length,
      kind: /^\s*group:/m.test(rest) ? 'group' : 'run',
    });
  }
  return out;
}

describe('the pre-push hook', () => {
  test('stops when a step fails, so a build error is not read under its own fallout', () => {
    const prePush = yaml.slice(yaml.indexOf('pre-push:'));
    expect(prePush).toMatch(/^\s{2}piped:\s*true$/m);
  });

  test('builds the web bundle before anything that starts a server', () => {
    const jobs = prePushJobs();
    expect(jobs[0]?.name).toBe('build:web');
    expect(jobs[0]?.indent).toBe(4);
  });

  test('keeps the checks in one group, so the pipe does not cut between them', () => {
    const jobs = prePushJobs();
    const group = jobs.find((j) => j.kind === 'group');
    expect(group?.name).toBe('checks');

    // Nested deeper than the top-level jobs: that nesting is what makes them one step
    const nested = jobs.filter((j) => j.indent > (group?.indent ?? 0)).map((j) => j.name);
    expect(nested).toEqual(['typecheck', 'test']);
  });

  test('runs the checks against each other in parallel, not as a second pipe', () => {
    // A piped group would put typecheck and test back on the same boundary this avoids
    const group = yaml.slice(yaml.indexOf('group:'));
    expect(group).toMatch(/^\s*parallel:\s*true$/m);
    expect(group).not.toMatch(/^\s*piped:\s*true$/m);
  });
});

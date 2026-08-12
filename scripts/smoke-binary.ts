/**
 * Smoke test for the single binary.
 *
 * One thing matters: the web assets are embedded and still served outside the repo.
 * Embedding only works through the static imports in the server's assets.ts, so adding a file
 * to the build output and forgetting to register it there produces a 404 in
 * production. Finding that out at release time is too late.
 */
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WEB = join(import.meta.dir, '..', 'packages', 'web', 'dist');

const sandbox = mkdtempSync(join(tmpdir(), 'akapen-smoke-'));
const bin = join(sandbox, 'akapen');
const note = join(sandbox, 'note.md');
writeFileSync(note, '---\ntitle: smoke\nstatus: active\n---\n\n# Heading\n\nA paragraph.\n');

let failures = 0;
const ok = (label: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// Build the browser side first: without packages/web/dist nothing gets embedded.
const web = Bun.spawnSync(['bun', 'run', 'build:web']);
ok(
  'the browser side builds',
  web.exitCode === 0,
  web.exitCode === 0 ? '' : new TextDecoder().decode(web.stderr).slice(0, 300),
);

if (web.exitCode !== 0) {
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}

// Loaded after the build, not at the top of the file. assets.ts statically imports
// packages/web/dist/*, which is not in git, so a top-level import fails on a clean
// checkout — before this script gets to the build step that would have created it.
const { ASSETS } = await import('@akapen/server/assets');

// Embedding only works through those static imports. Anything produced in
// packages/web/dist but not listed there is missing from the binary and 404s in
// production, so an unregistered file fails here.
const webNames = readdirSync(WEB, { recursive: true })
  .map(String)
  .filter((n) => !n.endsWith('/') && n.includes('.'));
const unregistered = webNames.filter((n) => !(n in ASSETS));
ok(
  'every file in packages/web/dist is registered in packages/server/src/assets.ts',
  unregistered.length === 0,
  unregistered.join(', '),
);

const build = Bun.spawnSync(['bun', 'build', '--compile', 'packages/cli/src/cli.ts', '--outfile', bin]);
ok(
  'the binary builds',
  build.exitCode === 0,
  build.exitCode === 0 ? '' : new TextDecoder().decode(build.stderr).slice(0, 400),
);
if (build.exitCode !== 0) {
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}

const help = Bun.spawnSync([bin, '--help'], { cwd: sandbox });
ok(
  '--help works outside the repo',
  help.exitCode === 0 && new TextDecoder().decode(help.stdout).includes('akapen'),
);

const port = 4771;
const server = Bun.spawn([bin, note, '-p', String(port)], {
  cwd: sandbox,
  env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home') },
  stdout: 'pipe',
  stderr: 'pipe',
});

const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/api/doc`)).ok) {
      up = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await Bun.sleep(200);
}
ok('the server comes up', up);

if (up) {
  for (const name of Object.keys(ASSETS)) {
    const res = await fetch(`${base}/${name === 'index.html' ? '' : name}`);
    const body = await res.arrayBuffer();
    ok(
      `embedded asset is served: ${name}`,
      res.ok && body.byteLength > 0,
      `${res.status} ${body.byteLength}B`,
    );
  }
  const missing = await fetch(`${base}/nope.txt`);
  ok('an unknown path is 404', missing.status === 404);

  const posted = await fetch(`${base}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startLine: 2, endLine: 2, body: 'smoke' }),
  });
  ok('a comment can be saved', posted.ok);
}

server.kill();
await server.exited;
rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);

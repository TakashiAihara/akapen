/**
 * 単一バイナリの動作確認。
 *
 * 見たいのは 1 点だけ: web/ のアセットがバイナリに埋め込まれ、repo の外でも配信されること。
 * 埋め込みは `src/assets.ts` の静的な import でしか効かないので、web/ にファイルを足して
 * assets.ts への追記を忘れると本番で 404 になる。リリース時に気づくのでは遅い。
 */
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSETS } from '../src/assets.ts';

const WEB = join(import.meta.dir, '..', 'web');

const sandbox = mkdtempSync(join(tmpdir(), 'akapen-smoke-'));
const bin = join(sandbox, 'akapen');
const note = join(sandbox, 'note.md');
writeFileSync(note, '---\ntitle: smoke\nstatus: active\n---\n\n# 見出し\n\n段落。\n');

let failures = 0;
const ok = (label: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// 埋め込みは assets.ts の静的な import でしか効かない。web/ に置いただけの
// ファイルはバイナリに入らず本番で 404 になるので、登録漏れをここで落とす。
const webNames = readdirSync(WEB, { recursive: true })
  .map(String)
  .filter((n) => !n.endsWith('/') && n.includes('.'));
const unregistered = webNames.filter((n) => !(n in ASSETS));
ok(
  'web/ のファイルがすべて src/assets.ts に登録されている',
  unregistered.length === 0,
  unregistered.join(', '),
);

const build = Bun.spawnSync(['bun', 'build', '--compile', 'src/cli.ts', '--outfile', bin]);
ok(
  'バイナリがビルドできる',
  build.exitCode === 0,
  build.exitCode === 0 ? '' : new TextDecoder().decode(build.stderr).slice(0, 400),
);
if (build.exitCode !== 0) {
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}

const help = Bun.spawnSync([bin, '--help'], { cwd: sandbox });
ok(
  'repo の外で --help が動く',
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
    /* まだ立っていない */
  }
  await Bun.sleep(200);
}
ok('サーバが立つ', up);

if (up) {
  for (const name of Object.keys(ASSETS)) {
    const res = await fetch(`${base}/${name === 'index.html' ? '' : name}`);
    const body = await res.arrayBuffer();
    ok(
      `埋め込みアセットが配信される: ${name}`,
      res.ok && body.byteLength > 0,
      `${res.status} ${body.byteLength}B`,
    );
  }
  const missing = await fetch(`${base}/nope.txt`);
  ok('知らないパスは 404', missing.status === 404);

  const posted = await fetch(`${base}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startLine: 2, endLine: 2, body: 'smoke' }),
  });
  ok('コメントを保存できる', posted.ok);
}

server.kill();
await server.exited;
rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'すべて PASS' : `${failures} 件 FAIL`}`);
process.exit(failures === 0 ? 0 : 1);

import { spawnSync } from 'node:child_process';

/**
 * E2E はサーバをテストごとに立てるが、ブラウザ側の成果物 (web/dist) は共通。
 * 各テストで毎回ビルドすると無駄なので、走らせる前に 1 回だけ作る。
 * playwright は node で動くので Bun の API は使えない。
 */
export default function globalSetup(): void {
  const build = spawnSync('bun', ['run', 'build:web'], { encoding: 'utf8' });
  if (build.status !== 0) {
    throw new Error(`build:web が失敗しました\n${build.stderr}`);
  }
}

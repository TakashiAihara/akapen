/**
 * `with { type: 'file' }` の import は、実行時には「そのファイルを読めるパス」になる
 * (単一バイナリなら `/$bunfs/...`)。TypeScript は import attributes を見ないので、
 * 拡張子ごとの既定の解釈 (css は未知、js は any、html は HTMLBundle) になってしまう。
 * ここで string に固定する。
 */
declare module '*.css' {
  const path: string;
  export default path;
}

declare module '*.min.js' {
  const path: string;
  export default path;
}

// web/dist はブラウザ向けのビルド成果物。埋め込むのはパスだけで中身は見ない
declare module '*/web/dist/app.js' {
  const path: string;
  export default path;
}

declare module '*/web/dist/mermaid.js' {
  const path: string;
  export default path;
}

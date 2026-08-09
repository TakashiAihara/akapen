/**
 * mermaid だけを別 entry にする。
 *
 * app に取り込むと 3.3MB になり、図が 1 つも無い文書でも毎回読んで解析することになる。
 * かといって bun の --splitting はハッシュ名のチャンクを 100 個以上作るので、
 * 名指しで埋め込む src/assets.ts と噛み合わない。
 *
 * entry を 2 つにすれば、出力は既知の 2 ファイルのままで、図がある時だけ読める。
 */
export { default } from 'mermaid';

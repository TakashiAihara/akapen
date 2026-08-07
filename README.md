# akapen

レンダリングした markdown にインラインで指摘を入れ、その位置と原文を構造化してエージェントに渡すための道具。

コメントは md 実ファイルに一切書かない。`~/.akapen/reviews/` のサイドカーに隔離する。md 本体が成果物である vault のような用途で、レビュー用の注記が commit に混入する経路を設計から消すため。

現状は PoC。動くが、認証・複数ファイル・ラウンド管理・エージェント自動連携は入っていない。

## なぜ作ったか

crit (tomasz-tomczyk/crit) を常用しようとして、3 点が引っかかった。いずれも crit の設計から出ているので設定では消せない。

1. 行が間延びする。crit は「ソース 1 行 = DOM 1 row」を守るため、markdown の空行も 1 行ぶんの高さを持つ row になる
2. 行番号を意識させられる。crit は行番号クリックがコメントの入口なので、読む時も常に見えている
3. frontmatter を素通しして本文として描く。`key: value` が段落に融合するため、`status: draft` のような 1 行を単独で指せない

akapen はこの 3 点を設計で回避する。

- 空行に row を作らない
- 行番号は既定で出さない (アンカーは内部で持つ。`l` キーで表示切り替え)
- frontmatter を 1 ソース行 = 1 ブロックで描く。値の途中で折り返した行も単独で指せる

加えて、拡張 CSS の口を最初から開けてある。crit には無く、ブラウザ拡張 (Stylus 等) を入れる以外に手が無かった部分。

## 使う

```bash
bun install
bun run src/cli.ts <file.md> [options]
```

| option | 意味 |
|---|---|
| `--host <addr>` | リッスンアドレス (default `127.0.0.1`) |
| `-p, --port <n>` | ポート (default `4300`) |
| `--css <file>` | 追加で読み込む CSS。既定スタイルの後に読むので全部上書きできる |
| `--author <name>` | コメントの著者名 (default `$USER`) |

リモートマシンで動かしてローカルのブラウザから見る場合は `--host 0.0.0.0`。認証は無いので到達範囲に注意する。

エージェントへの受け渡しは CLI。

```bash
bun run src/cli.ts comments <file.md>          # 未解決コメントを JSON で出す
bun run src/cli.ts comments <file.md> --all    # 解決済みも含める
```

```json
[
  {
    "id": "c_b683c8",
    "path": "/path/to/note.md",
    "start_line": 5,
    "end_line": 5,
    "body": "status 行への指摘",
    "anchor": "status: active",
    "drifted": false,
    "author": "root"
  }
]
```

拡張 CSS の例は `examples/dense.css`。

```bash
bun run src/cli.ts note.md --css examples/dense.css
```

## 設計

### 行マッピング

markdown-it のトークンを走査して「ソース 1 行 = 1 ブロック」に割る (`src/blocks.ts`)。段落・リスト項目・表の行・コードの行・frontmatter の行が、それぞれ独立して指せる単位になる。

不変条件は 1 つ。空行以外のすべてのソース行が、ちょうど 1 つのブロックに属すること。これが崩れると「指したい行が画面に存在しない」という最悪の壊れ方をする。トークンにならない行 (引用内の `>` だけの行など) は最後に拾う。

### 再アンカー

ファイルが書き換わったら、行番号を捨てて原文でコメントを貼り直す (`src/store.ts`)。

1. 同じ位置に同じ原文があればそのまま
2. 無ければ原文をファイル全体から探す。1 件ならそこへ移す
3. 複数あれば前後の行で絞り、それでも決まらなければ元の位置に近い方
4. 見つからなければ `drifted` にする。位置は推測しない

行番号を信じると、エージェントが上に段落を足しただけで全コメントが無関係な位置を指し、誤った指摘がそのままエージェントに渡る。

### コメントの保存先

`~/.akapen/reviews/<basename>-<hash>/comments.json`。md 実ファイルには触れない。

## 検証

```bash
bun run scripts/verify.ts <file.md>   # frontmatter / 行マッピング / 再アンカーの判定
bun run scripts/sweep.ts <dir>        # ディレクトリ内の全 md で不変条件を確認
```

vault の全 152 ノートで、行の取りこぼし・重複ともゼロ (24164 ブロック)。

## 残っていること

- 認証。`--host 0.0.0.0` は無認証で LAN に出る
- 複数ファイルのレビュー。今は 1 ファイル 1 プロセス
- ラウンド管理。crit の「レビューを締めてエージェントに渡す」に相当するもの
- エージェント連携の自動化。今は `comments` を叩いてもらう前提で、crit の `agent_cmd` 相当は無い
- 返信・スレッド。今は 1 コメント 1 スレッド
- 単一バイナリ化 (`bun build --compile`)

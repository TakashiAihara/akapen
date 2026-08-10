/**
 * サーバとブラウザの両方が使う型。
 *
 * 同じコメントと同じ payload を両側で扱うのに、片側にしか型が無い状態だと
 * 形を変えた時にもう片方が黙ってズレる。ここを唯一の定義にして、
 * 食い違ったら型で落ちるようにする。
 */

/* ===== 本文 ===== */

export type BlockKind =
  | 'frontmatter'
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'table-row'
  | 'code'
  | 'mermaid'
  | 'hr';

export type Block = {
  /** 1-based, inclusive */
  startLine: number;
  /** 1-based, inclusive */
  endLine: number;
  kind: BlockKind;
  html: string;
  /** 範囲の原文。コメントのアンカーの鍵 */
  text: string;
  /** リストと引用のネスト */
  depth: number;
  quoted: boolean;
  flags: string[];
};

export type Doc = {
  path: string;
  blocks: Block[];
  lineCount: number;
};

/* ===== コメント ===== */

export type Comment = {
  id: string;
  /** 紐づくラウンドのスナップショット内での行番号。live のファイルに対しては意味を持たない。 */
  startLine: number;
  endLine: number;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  /**
   * スナップショットから切り出した原文。ラウンドをまたいで位置を伝えるのはこちらの役目。
   * エージェントは行番号ではなく原文で現在のファイルを照合するので、他の修正で行がズレても当たる。
   */
  anchor: string;
};

/** どのラウンドのコメントかを付けたもの。ラウンドをまたいで扱う経路は必ずこれを通す。 */
export type RoundComment = Comment & { round: number };

/* ===== ラウンド ===== */

export type RoundMeta = {
  n: number;
  createdAt: string;
  /** 次のラウンドを開いた時刻。現ラウンドは null。 */
  closedAt: string | null;
};

/** 画面に出すラウンドの状態。viewing は履歴を見ている時だけ入る。 */
export type RoundState = {
  n: number;
  total: number;
  createdAt: string | null;
  all: RoundMeta[];
  viewing?: number;
};

/** live のファイルが現ラウンドのスナップショットとどれだけ離れているか。 */
export type ChangedState = {
  changes: number;
  dirty: boolean;
};

/* ===== やりとりする形 ===== */

/** 本文込み。初回表示・ラウンド切り替え・履歴の表示で使う。 */
export type DocPayload = {
  type: 'doc';
  /** 過去ラウンドを表示している時だけ true。読み取り専用 */
  history?: boolean;
  doc: Doc;
  comments: Comment[];
  round: RoundState;
  /** 現ラウンドより前の未解決。持ち越さない代わりに「消えていない」ことを示す */
  carried: RoundComment[];
  changed: ChangedState;
};

/** コメントだけが変わった時の応答。本文は含めない。 */
export type CommentsPayload = {
  comment: Comment | RoundComment;
  comments: Comment[];
  carried: RoundComment[];
};

/**
 * SSE で流す唯一の形。
 * ここに本文を混ぜると、受け取った側が画面を作り直すことになり、
 * 読んでいる位置・入力中のフォーカス・IME の変換・本文の選択が人の操作と無関係に壊れる。
 */
export type ChangedEvent = { type: 'changed' } & ChangedState;

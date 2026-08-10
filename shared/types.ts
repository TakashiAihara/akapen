/**
 * Types used by both the server and the browser.
 *
 * Both sides handle the same comments and the same payloads. When only one side
 * is typed, changing the shape lets the other drift silently. This file is the
 * single definition, so a mismatch fails to compile.
 */

/* ===== Document ===== */

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
  /** Raw source of the range. The key an anchor is matched by. */
  text: string;
  /** List and blockquote nesting. */
  depth: number;
  quoted: boolean;
  flags: string[];
};

export type Doc = {
  path: string;
  blocks: Block[];
  lineCount: number;
};

/* ===== Comments ===== */

export type Comment = {
  id: string;
  /** Line number inside the round's snapshot. It means nothing against the live file. */
  startLine: number;
  endLine: number;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  /**
   * The raw source taken from the snapshot. This, not the line number, is what
   * carries the location across rounds: an agent matches the current file by
   * text, so it still lands when other edits have shifted the lines.
   */
  anchor: string;
};

/** A comment tagged with the round it belongs to. Every cross-round path uses this. */
export type RoundComment = Comment & { round: number };

/* ===== Rounds ===== */

export type RoundMeta = {
  n: number;
  createdAt: string;
  /** When the next round was opened. null for the current round. */
  closedAt: string | null;
};

/** Round state for the UI. `viewing` is set only while browsing history. */
export type RoundState = {
  n: number;
  total: number;
  createdAt: string | null;
  all: RoundMeta[];
  viewing?: number;
};

/** How far the live file has drifted from the current round's snapshot. */
export type ChangedState = {
  changes: number;
  dirty: boolean;
};

/* ===== Wire formats ===== */

/** Includes the document. Used for the first render, round changes and history. */
export type DocPayload = {
  type: 'doc';
  /** True only while showing a past round. Read-only. */
  history?: boolean;
  doc: Doc;
  comments: Comment[];
  round: RoundState;
  /** Unresolved comments from earlier rounds. Nothing carries over, so this is how they stay visible. */
  carried: RoundComment[];
  changed: ChangedState;
};

/** Response when only comments changed. The document is not included. */
export type CommentsPayload = {
  comment: Comment | RoundComment;
  comments: Comment[];
  carried: RoundComment[];
};

/**
 * The only shape sent over SSE.
 *
 * Putting the document in here would make the receiver rebuild the screen, which
 * destroys the reading position, the focused input, an in-flight IME composition
 * and the text selection — none of it caused by anything the person did.
 */
export type ChangedEvent = { type: 'changed' } & ChangedState;

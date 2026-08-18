/**
 * The contract between the server and its clients.
 *
 * Both sides handle the same comments and the same payloads. When only one side
 * is typed, changing the shape lets the other drift silently. This file is the
 * single definition, so a mismatch fails to compile.
 *
 * The shapes are valibot schemas rather than bare types, and the types are derived
 * from them. A type alone only holds at compile time, and the two places that need
 * it most are both run time: a request body arrives as unknown JSON, and a browser
 * tab left open across a restart talks to a server it was not built against. Both
 * are caught here, and neither would be caught by a type.
 *
 * The browser imports this file, so it is written to tree-shake: everything is a
 * separate export and nothing is collected into a barrel object.
 */

import * as v from 'valibot';

/** 1-based, inclusive. Line 0 does not exist, and a fraction cannot index a line. */
const LineNumber = v.pipe(v.number(), v.integer(), v.minValue(1));

/* ===== Document ===== */

export const BlockKindSchema = v.picklist([
  'frontmatter',
  'heading',
  'paragraph',
  'list-item',
  'table-row',
  'code',
  'mermaid',
  'hr',
]);
export type BlockKind = v.InferOutput<typeof BlockKindSchema>;

export const BlockSchema = v.object({
  startLine: LineNumber,
  endLine: LineNumber,
  kind: BlockKindSchema,
  html: v.string(),
  /** Raw source of the range. The key an anchor is matched by. */
  text: v.string(),
  /** List and blockquote nesting. */
  depth: v.pipe(v.number(), v.integer(), v.minValue(0)),
  quoted: v.boolean(),
  flags: v.array(v.string()),
});
export type Block = v.InferOutput<typeof BlockSchema>;

export const DocSchema = v.object({
  path: v.string(),
  blocks: v.array(BlockSchema),
  lineCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type Doc = v.InferOutput<typeof DocSchema>;

/* ===== Comments ===== */

/**
 * Who wrote something.
 *
 * Kept apart from `author`, which is a name and can be anything. Telling a person from
 * an agent by name would break the moment someone sets `--author` to the agent's name,
 * and #12 turns that distinction into whether a conversation can be read at all.
 *
 * The server stamps this. A client cannot be trusted to say which it is until there is
 * authentication (#10), so what it sends is ignored.
 */
export const AuthorKindSchema = v.picklist(['human', 'agent']);
export type AuthorKind = v.InferOutput<typeof AuthorKindSchema>;

/**
 * A reply on a comment. One level: a reply cannot be replied to.
 *
 * The exchange this carries is a person and an agent going back and forth on one
 * point, which does not branch. A tree would need indentation, a depth limit and
 * collapsing in the rail, and would make an agent walk a structure instead of reading
 * an array. If a branch is ever wanted, this can grow a `replyTo` without moving
 * anything already on disk.
 */
export const ReplySchema = v.object({
  id: v.string(),
  body: v.string(),
  author: v.string(),
  authorKind: AuthorKindSchema,
  createdAt: v.string(),
});
export type Reply = v.InferOutput<typeof ReplySchema>;

export const CommentSchema = v.object({
  id: v.string(),
  /** Line number inside the round's snapshot. It means nothing against the live file. */
  startLine: LineNumber,
  endLine: LineNumber,
  body: v.string(),
  author: v.string(),
  createdAt: v.string(),
  resolved: v.boolean(),
  /**
   * The raw source taken from the snapshot. This, not the line number, is what
   * carries the location across rounds: an agent matches the current file by
   * text, so it still lands when other edits have shifted the lines.
   */
  anchor: v.string(),
  /**
   * Replies, oldest first.
   *
   * Optional with an empty default because every file written before replies existed
   * has no such key. Making it required would have the browser-side checking added in
   * #68 reject those files, and the screen would come up blank.
   */
  replies: v.optional(v.array(ReplySchema), []),
});
export type Comment = v.InferOutput<typeof CommentSchema>;

/** A comment tagged with the round it belongs to. Every cross-round path uses this. */
export const RoundCommentSchema = v.object({
  ...CommentSchema.entries,
  round: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type RoundComment = v.InferOutput<typeof RoundCommentSchema>;

/* ===== Rounds ===== */

export const RoundMetaSchema = v.object({
  n: v.pipe(v.number(), v.integer(), v.minValue(1)),
  createdAt: v.string(),
  /** When the next round was opened. null for the current round. */
  closedAt: v.nullable(v.string()),
});
export type RoundMeta = v.InferOutput<typeof RoundMetaSchema>;

/** Round state for the UI. `viewing` is set only while browsing history. */
export const RoundStateSchema = v.object({
  n: v.pipe(v.number(), v.integer(), v.minValue(1)),
  total: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: v.nullable(v.string()),
  all: v.array(RoundMetaSchema),
  viewing: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export type RoundState = v.InferOutput<typeof RoundStateSchema>;

/** How far the live file has drifted from the current round's snapshot. */
export const ChangedStateSchema = v.object({
  changes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  dirty: v.boolean(),
});
export type ChangedState = v.InferOutput<typeof ChangedStateSchema>;

/* ===== Requests ===== */

/**
 * A comment the browser is asking to create.
 *
 * The range is checked against the snapshot by the server, not here — this schema
 * only knows that a line number is a positive integer. An empty body is rejected
 * because a comment with nothing in it says nothing and cannot be resolved.
 */
export const CreateCommentSchema = v.object({
  startLine: LineNumber,
  endLine: LineNumber,
  body: v.pipe(v.string(), v.minLength(1)),
  /**
   * The round the screen was showing when this was written.
   *
   * Line numbers only mean something inside one round's snapshot, and akapen is read
   * from more than one screen (`--host 0.0.0.0` is the normal way to run it). When
   * another screen cuts a round, this one keeps the old numbers and every comment from
   * it lands somewhere else — or is refused as pointing at nothing, which is what was
   * actually seen (#100). Saying which round it came from is what lets the server tell
   * "this line is blank" from "your document moved".
   *
   * Optional: a tab that was loaded before this existed still works, and a client that
   * does not say gets the old behaviour rather than a refusal.
   */
  round: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export type CreateComment = v.InferOutput<typeof CreateCommentSchema>;

/**
 * A reply the browser is asking to add.
 *
 * Only the text. Which comment it belongs to is in the path, and the author and its
 * kind are stamped by the server — a client cannot be trusted to name either while
 * there is no authentication (#10).
 */
export const CreateReplySchema = v.object({
  body: v.pipe(v.string(), v.minLength(1)),
});
export type CreateReply = v.InferOutput<typeof CreateReplySchema>;

/**
 * The query string of /api/doc. `round` absent means the current round.
 *
 * A query value is always a string, so it is converted here. `Number('')` is 0 and
 * `Number('x')` is NaN; both fail the checks that follow, which is why the round is
 * read through a schema rather than a bare `Number()`.
 */
export const DocQuerySchema = v.object({
  round: v.optional(v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1))),
});
export type DocQuery = v.InferOutput<typeof DocQuerySchema>;

/* ===== Wire formats ===== */

/** Includes the document. Used for the first render, round changes and history. */
export const DocPayloadSchema = v.object({
  type: v.literal('doc'),
  /** True only while showing a past round. Read-only. */
  history: v.optional(v.boolean()),
  doc: DocSchema,
  comments: v.array(CommentSchema),
  round: RoundStateSchema,
  /** Unresolved comments from earlier rounds. Nothing carries over, so this is how they stay visible. */
  carried: v.array(RoundCommentSchema),
  changed: ChangedStateSchema,
});
export type DocPayload = v.InferOutput<typeof DocPayloadSchema>;

/** Response when only comments changed. The document is not included. */
export const CommentsPayloadSchema = v.object({
  comment: v.union([RoundCommentSchema, CommentSchema]),
  comments: v.array(CommentSchema),
  carried: v.array(RoundCommentSchema),
});
export type CommentsPayload = v.InferOutput<typeof CommentsPayloadSchema>;

/**
 * The only shape sent over SSE.
 *
 * Putting the document in here would make the receiver rebuild the screen, which
 * destroys the reading position, the focused input, an in-flight IME composition
 * and the text selection — none of it caused by anything the person did.
 */
export const ChangedEventSchema = v.object({
  type: v.literal('changed'),
  ...ChangedStateSchema.entries,
});
export type ChangedEvent = v.InferOutput<typeof ChangedEventSchema>;

/**
 * A round was opened, by whoever clicked. Carries no document, for the same reason
 * `changed` does not: the screen is rebuilt when the person asks, not when a message
 * arrives.
 *
 * Without this, only the screen that clicked ever learns. Every other one keeps the
 * previous round's line numbers and cannot comment at all, with nothing on it saying
 * why (#100).
 */
export const RoundEventSchema = v.object({
  type: v.literal('round'),
  n: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type RoundEvent = v.InferOutput<typeof RoundEventSchema>;

/**
 * Everything that can arrive on the stream. A receiver matches on `type`, so a kind it
 * was not built for is dropped instead of being read as the one it does know.
 */
export const ServerEventSchema = v.variant('type', [ChangedEventSchema, RoundEventSchema]);
export type ServerEvent = v.InferOutput<typeof ServerEventSchema>;

/** What /api/rounds answers with. */
export const RoundsPayloadSchema = v.object({
  current: v.pipe(v.number(), v.integer(), v.minValue(1)),
  rounds: v.array(RoundMetaSchema),
});
export type RoundsPayload = v.InferOutput<typeof RoundsPayloadSchema>;

/* ===== Instances ===== */

/**
 * What an instance says about itself, and the request that proves it is alive.
 *
 * `file` is the basename, not the path it was started with. The list this feeds is
 * shown over the LAN with nothing authenticating a reader (#10), and the layout of
 * somebody's disk is not something to hand out for free. Keeping the path out of the
 * payload means no caller can leak it by accident. Revisit when #10 lands.
 */
export const StatusPayloadSchema = v.object({
  file: v.string(),
  round: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** Unresolved comments across every round: the same set `akapen comments` would emit. */
  unresolved: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type StatusPayload = v.InferOutput<typeof StatusPayloadSchema>;

/**
 * Another akapen on this host, as a row.
 *
 * Enough to recognise the document and see whether it is waiting on you, and no more.
 */
export const InstancePeerSchema = v.object({
  pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** The address it bound. Kept so a row can say why it cannot be linked to. */
  host: v.string(),
  port: v.pipe(v.number(), v.integer(), v.minValue(1)),
  ...StatusPayloadSchema.entries,
  /**
   * Whether a link to it can work at all.
   *
   * The reader's browser is usually not on this host — akapen is started with
   * `--host 0.0.0.0` and read over the LAN — so a peer that took the default
   * `127.0.0.1` bind is unreachable from there however the link is built. Such a row
   * is still worth showing: it is how you find out where the review you cannot reach
   * actually is. It is shown without a link rather than with one that will time out.
   */
  reachable: v.boolean(),
});
export type InstancePeer = v.InferOutput<typeof InstancePeerSchema>;

/** What /api/instances answers with. Never includes the instance that was asked. */
export const InstancesPayloadSchema = v.object({
  instances: v.array(InstancePeerSchema),
});
export type InstancesPayload = v.InferOutput<typeof InstancesPayloadSchema>;

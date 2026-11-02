/**
 * The JSON `akapen comments` and `akapen history` print, and the filters history takes.
 *
 * Separate from cli.ts for the reason args.ts is: cli.ts runs on import, so nothing in
 * it can be exercised without starting a process.
 */

import type { ReviewComments, RoundComment } from '@akapen/core/store';

import { UsageError } from './args.ts';

/**
 * One comment as an agent reads it. Shared, so the two commands cannot drift apart: a
 * reader that handles one handles the other.
 */
export function commentJson(c: RoundComment, path: string | null, currentRound: number) {
  return {
    id: c.id,
    path,
    round: c.round,
    // Whether it belongs to the current round. Older ones are feedback on the document
    // as it was, so treat their line numbers as already shifted in the live file.
    current_round: c.round === currentRound,
    start_line: c.startLine,
    end_line: c.endLine,
    body: c.body,
    anchor: c.anchor,
    author: c.author,
    resolved: c.resolved,
    // Who spoke last on the thread (#249), so a reader need not walk `replies`: until
    // someone resolves it, a comment the agent has answered is still listed here. A
    // comment carries no kind of its own, so one with no reply is treated as a person's.
    last_author_kind: c.replies?.at(-1)?.authorKind ?? 'human',
    // The agent's own replies are noise to it, but a person's reply to one is new
    // feedback — "could not fix, because X" answered with "then do Y instead". Y
    // only arrives if the thread comes with the comment.
    replies: (c.replies ?? []).map((r) => ({
      id: r.id,
      body: r.body,
      author: r.author,
      author_kind: r.authorKind,
      session_id: r.sessionId ?? null,
      created_at: r.createdAt,
    })),
  };
}

export type HistoryFilter = {
  all: boolean;
  /** Matched against the comment's body, ignoring case, as plain text rather than a pattern. */
  grep?: string | undefined;
  /** The comment's author, exactly. Replies are not searched. */
  author?: string | undefined;
  /** Epoch milliseconds. Comments created before it are left out. */
  since?: number | undefined;
};

/**
 * `--since`, as anything Date reads: `2026-08-01` (midnight UTC) or a full timestamp.
 *
 * A value Date cannot read fails here. Letting it through as NaN would compare false
 * against every comment and print `[]`, which reads as "nothing since then".
 */
export function parseSince(raw: string): number {
  const t = Date.parse(raw);
  if (Number.isNaN(t))
    throw new UsageError(`--since must be a date, such as 2026-08-01, got ${JSON.stringify(raw)}`);
  return t;
}

/**
 * Every review's comments that pass the filter, oldest first.
 *
 * Oldest first because the question this answers is "what have I been raising over
 * time", read top to bottom; within one document `akapen comments` keeps its own order.
 */
export function historyJson(reviews: ReviewComments[], filter: HistoryFilter) {
  const needle = filter.grep?.toLowerCase();
  return reviews
    .flatMap((r) =>
      r.comments
        .filter((c) => filter.all || !c.resolved)
        .filter((c) => needle === undefined || c.body.toLowerCase().includes(needle))
        .filter((c) => filter.author === undefined || c.author === filter.author)
        .filter((c) => filter.since === undefined || Date.parse(c.createdAt) >= filter.since)
        .map((c) =>
          Object.assign({ review_id: r.reviewId }, commentJson(c, r.path, r.currentRound), {
            created_at: c.createdAt,
          }),
        ),
    )
    .toSorted(
      (a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) ||
        a.review_id.localeCompare(b.review_id) ||
        a.id.localeCompare(b.id),
    );
}

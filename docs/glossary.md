# Glossary

The words akapen uses for its own parts, and which of them mean two things.

Every entry says where the thing exists — a type, a CSS selector, an endpoint, a path — so a
definition can be checked rather than believed. `docs/glossary.ja.md` is a translation of this
file; this one is the source.

## Terms that collide

These are the words that already point at two things. Each one has a rule for telling the two
apart. Use the qualified form; the bare word is the one that causes the confusion.

| Word | One thing | The other thing | Rule |
|---|---|---|---|
| anchor | `Comment.anchor` — the snapshot text a comment was written against, used to find the place again after the file moves on | the row a bubble lines up with. Nothing in the DOM marks a row as the anchor row: `layoutRail` matches a bubble's `data-line` against the rows' `data-start`/`data-end` and positions the bubble from the row it lands in | Say "anchor text" and "anchor row". Never bare "anchor". |
| line | a 1-based number into a snapshot (`startLine`, `endLine`) | what a reader sees as one line of text | "Line" is a number into the snapshot. What is on screen is a row. A wrapped paragraph is one row over many visual lines. |
| block / row | `Block` — a parsed unit of the document, with `startLine`, `endLine` and a `kind` | `.row` — the element that renders one block | Block is the model, row is the element. One block is one row. |
| comment | a piece of review feedback (`Comment`, `.bubble`) | an HTML comment inside the markdown (`<!-- … -->`), which akapen shows as text | "Comment" alone is review feedback. For the other, say "an HTML comment in the document". |
| mark / marker | the row mark — a thin accent line at the left of a row that carries a comment (`.row.has-comment`) | the count marker — the badge in the gutter showing how many comments a row has, shown only while the rail is collapsed (`.marker`) | Always qualified: "row mark", "count marker", "list marker" (`.li-marker`, a bullet or number). |
| gutter / rail | the gutter — the area left of the text holding the line number, the count marker and the + (`.gutter`) | the rail — the column right of the document holding bubbles (`.rail`) | Left is the gutter, right is the rail. Not "sidebar", not "strip", not "band". |
| round | a frozen snapshot of the file (`rounds/NNN/`) | the badge showing `R001` (`#round`) and the picker beside it (`#roundPick`) | "Round" is the snapshot. The screen parts are the "round badge" and the "round selector". |
| draft | a comment being written and not yet sent (`.bubble.draft`, `startDraft`) | a GitHub pull request that is not ready for review | Inside the product, a draft is an unsent comment. The other belongs to how the repository is worked on, not to akapen. |
| document / file / snapshot | the live file — what is on disk right now | the snapshot — the round's frozen copy (`rounds/NNN/content.md`) | What is on screen is the snapshot, never the live file. `Doc` is the parsed form of the snapshot (`/api/doc`); `#doc` is the element it is rendered into. |
| doc / document | `Doc` — the parsed snapshot handed to the browser (`/api/doc`) | the document — the rendered snapshot on screen (`#doc`), and, loosely, the markdown being reviewed | `Doc` is the payload, the document is what is read. Do not shorten "document" to "doc" in prose. |
| review | `Review` — the contents of `review.json`: round metadata and the current round number | the activity of reading and leaving feedback | Say "review.json" or "the review store" (`~/.akapen/reviews/`) for the data. |
| inline review | feedback attached to a place in the document, which is what akapen is for | comments written inline into the markdown file, which akapen never does | The comments are inline with respect to the reading, not to the file. The file is never touched. |

## The screen

| Term | What it is | Where it exists |
|---|---|---|
| stage | the grid holding the document and the rail side by side | `.stage` |
| document | the rendered snapshot | `#doc`, `.doc` |
| row | one block, rendered | `.row` |
| body | the rendered markdown of a row | `.body` |
| gutter | the area left of the text, from the page margin up to the text. Hovering it shows the +, clicking it opens a comment on that row, dragging down it picks a range of rows | `.gutter` |
| add button | the + that opens a comment on the row | `.add` |
| line number | the row's `startLine`, shown while line numbers are on | `.lineno`, `body.show-lines`, the `lines.toggle` key |
| count marker | the badge with a comment count, shown in the gutter while the rail is collapsed | `.marker`, `body.rail-overlay` |
| row mark | the thin accent line marking a row that carries a comment | `.row.has-comment` |
| rail | the column of bubbles right of the document | `.rail`, `#rail` |
| anchored rail | the bubbles belonging to the round on screen, each lined up with its anchor row | `#railAnchored` |
| carried rail | unresolved comments from earlier rounds, stacked at the end of the rail | `#railCarried` |
| bubble | one comment on screen, with its replies | `.bubble` |
| draft bubble | the comment being written | `.bubble.draft` |
| reply | a message under a comment. One level: a reply cannot be replied to | `Reply`, `.reply` |
| top bar | the bar across the top of the screen: name, file path, round badge, count, controls | `.topbar` |
| tab title | what the browser tab is called: the document's first top-level heading (`#` or setext), or its file name when it has none | `document.title`, `pageTitle` |
| banner | the line saying the live file has changed since the snapshot | `#banner`, `ChangedState` |
| history bar | the line saying an earlier round is being viewed, which is read-only for the document | `#historyBar` |
| round badge / round selector | the round on screen — the current one, or an earlier one while viewing history — and the picker, which tags the current round | `#round`, `#roundPick` |
| count | how many comments are open, of how many, plus how many are carried | `#count` |

Row states, which stack:

| Term | What it means | Where it exists |
|---|---|---|
| focused | the row j/k is on | `.row.focused` |
| in-range | inside the range being selected | `.row.in-range` |
| linked | tied to the bubble currently being read | `.row.linked` |
| has-comment | carries at least one comment in this round | `.row.has-comment` |

`.row.selected` is styled but nothing sets it. It is a leftover, not a state.

## The document model

| Term | What it is | Where it exists |
|---|---|---|
| doc | the parsed snapshot: a path, a list of blocks, a line count | `Doc`, `/api/doc` |
| block | a parsed unit of the document, spanning `startLine`..`endLine` | `Block` |
| block kind | what a block is: `frontmatter`, `heading`, `paragraph`, `list-item`, `table-row`, `code`, `mermaid`, `hr` | `BlockKind` |
| line number | 1-based, inclusive, into the snapshot. Line 0 does not exist | `LineNumber` |
| range | a pair of line numbers a comment covers. One row is a range whose ends are its block's | `startLine`/`endLine` on `Comment` |
| anchor text | the snapshot text a comment was written against. This, not the line number, is what carries the location across rounds | `Comment.anchor` |
| line mapping | turning the markdown source into blocks so that what is rendered can be pointed at by line | `packages/core/src/blocks.ts` |

## Rounds and storage

| Term | What it is | Where it exists |
|---|---|---|
| round | a frozen snapshot of the file contents. Comments attach to lines inside it | `rounds/NNN/content.md` |
| current round | the round being written to. The only one that takes a new comment; replying to a comment and resolving one work in any round | `Review.currentRound`, `RoundState.n` |
| viewing a round | reading an earlier round's snapshot and comments. Read-only for the document, not for comment status | `RoundState.viewing`, `#historyBar` |
| cutting a round | freezing the live file as the next round. Only a person does this; an agent's save never does | the "End this round" control, `#nextRound`, `openRound` |
| carried over | unresolved comments from earlier rounds. Nothing carries into a new round; they are shown apart so that gone from the screen does not read as dealt with | `carriedOver`, `#railCarried` |
| review store | where comments live, outside the markdown file | `~/.akapen/reviews/<basename>-<hash>/`, `AKAPEN_HOME` |
| dirty | the live file no longer matches the current round's snapshot | `ChangedState.dirty` |

```text
~/.akapen/reviews/<basename>-<hash>/   # ~/.akapen is the default; AKAPEN_HOME replaces that root
  review.json          # round metadata and the current round number
  rounds/
    001/content.md     # the frozen document
    001/comments.json  # comments anchored to lines in 001
```

## People and agents

| Term | What it is | Where it exists |
|---|---|---|
| author | a name, and nothing more. Anything can be put in it | `Comment.author`, `--author` |
| author kind | whether a person or an agent wrote a reply. It is on `Reply` only; a comment has no such field. The server stamps it and ignores what a client claims, and today it stamps every reply `human` — nothing authenticates a claim to be otherwise and the path by which an agent writes back is not built yet | `AuthorKind` (`human` \| `agent`), `Reply.authorKind` |
| agent | the program the feedback is being handed to. It reads comments as JSON and matches them by anchor text | `akapen comments <file.md>` |
| resolved | a comment that has been dealt with. Status applies to earlier rounds too, or feedback could never be closed | `Comment.resolved`, `--all` |

## Modes

| Term | What it is |
|---|---|
| review mode | the current shape: rounds, the rail, history. A document is read and fed back on in rounds (milestone v0.1) |
| passive mode | reading without rounds, following the live file (milestone v0.2) |

## Words to avoid

| Instead of | Say |
|---|---|
| strip, band (and 帯, since the confusion this came from happened in Japanese) | the gutter |
| sidebar | the rail |
| line, for something on screen | row |
| inline comment, for what is stored | a comment on a row. Nothing is written into the file |

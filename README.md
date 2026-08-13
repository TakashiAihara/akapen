# akapen

A tool for leaving inline feedback on rendered markdown, and handing that feedback — its position and the text it points at — to an agent in a structured form.

Comments are never written into the markdown file. They live in a sidecar under `~/.akapen/reviews/`. When the markdown itself is the deliverable, as it is in a vault, this removes by design the path by which review notes end up in a commit.

Still a proof of concept. It works, but authentication, multiple files and automatic agent integration are not in it.

## Why it exists

Three things got in the way of using crit (tomasz-tomczyk/crit) day to day. All of them follow from its design, so no setting turns them off.

1. Lines sprawl. crit keeps "one source line = one DOM row", so a blank line in markdown becomes a row a full line high.
2. Line numbers are always present. Clicking one is how you comment in crit, so they stay visible while reading.
3. Frontmatter passes through as body text. `key: value` merges into a paragraph, so a single line like `status: draft` cannot be addressed.

akapen avoids all three by construction.

- Blank lines get no row.
- Line numbers are hidden by default (anchors are held internally; press `l` to show them).
- Frontmatter renders as one source line = one block. Even a line wrapped mid-value stays addressable.

There is also a hook for extra CSS, open from the start. crit had none, so the only way in was a browser extension such as Stylus.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/akapen/main/install.sh | sh
```

A single binary lands in `$HOME/.local/bin/akapen`. No bun, no clone.

| Environment variable | Meaning |
|---|---|
| `AKAPEN_VERSION` | tag to install (default `latest`) |
| `AKAPEN_INSTALL_DIR` | where to put it (default `$HOME/.local/bin`) |

**Checksum verification is mandatory.** The install aborts when `SHA256SUMS` cannot be fetched, when it has no line for the asset, or when neither `sha256sum` nor `shasum` exists — anything unverified is not installed.

`AKAPEN_VERIFY_ATTESTATION=1` additionally verifies build provenance where `gh` is available. The checksum comes from the same release, so whoever can tamper with one can replace both; this is what checks authenticity.

```bash
gh attestation verify ~/.local/bin/akapen \
  --repo TakashiAihara/akapen \
  --signer-workflow TakashiAihara/akapen/.github/workflows/release.yml
```

With `--repo` alone an attestation from any workflow in the repository passes, so the signing workflow is pinned too.

Binaries exist for linux and darwin on x64 and arm64. GitHub Actions builds them on tag push and attaches them to the release (`.github/workflows/release.yml`).

### Running from the repository

```bash
bun install
bun run start <file.md> [options]
```

The examples below use `bun run packages/cli/src/cli.ts`; read that as `akapen` if you installed it.

## Usage

| Option | Meaning |
|---|---|
| `--host <addr>` | listen address (default `127.0.0.1`) |
| `-p, --port <n>` | port (default `4300`) |
| `--css <file>` | extra stylesheet, loaded after the defaults so it can override everything |
| `--keymap <file>` | JSON overriding the keymap, merged over the defaults |
| `--author <name>` | comment author (default `$USER`) |

Use `--host 0.0.0.0` to run it on a remote machine and read it from a local browser. There is no authentication, so mind who can reach the address.

The handoff to an agent is a CLI command.

```bash
bun run packages/cli/src/cli.ts comments <file.md>          # unresolved comments as JSON
bun run packages/cli/src/cli.ts comments <file.md> --all    # include resolved ones
```

```json
[
  {
    "id": "c_b683c8",
    "path": "/path/to/note.md",
    "round": 2,
    "current_round": true,
    "start_line": 5,
    "end_line": 5,
    "body": "feedback on the status line",
    "anchor": "status: active",
    "author": "root",
    "resolved": false,
    "replies": [
      {
        "id": "r_1a2b3c",
        "body": "could not fix, because X",
        "author": "agent-1",
        "author_kind": "agent",
        "created_at": "2026-08-12T14:03:11.000Z"
      }
    ]
  }
]
```

`start_line` and `end_line` are line numbers inside that round's snapshot and will not match the live file. An agent matches the current file on `anchor` — the text as it was.

**Unresolved comments from earlier rounds are included.** Since nothing carries over, round N's feedback does not appear on N+1's screen. Disappearing from the screen is what history is for; not reaching the agent would lose the feedback itself. Closing a round *means* handing work over.

Current-round comments come first, ordered by line. Entries with `current_round: false` are feedback on the document as it was, so treat their line numbers as already shifted.

`replies` is the thread on that comment, oldest first, one level deep — a reply cannot be replied to. An agent's own replies are noise to it, but a person's answer to one is not: "could not fix, because X" met with "then do Y instead" makes Y new feedback, and it only arrives if the thread comes with the comment. `author_kind` says which side wrote it. Today the server stamps every reply `human`, since nothing authenticates a claim to be otherwise; the path by which an agent writes back is not built yet.

There is an example stylesheet in `examples/dense.css`.

```bash
bun run packages/cli/src/cli.ts note.md --css examples/dense.css
```

`examples/sample.md` is there to try it on.

```bash
bun run packages/cli/src/cli.ts examples/sample.md
```

## Design

### Line mapping

Walk markdown-it's tokens and split the document into "one source line = one block" (`packages/core/src/blocks.ts`). Paragraphs, list items, table rows, code lines and frontmatter lines each become an independently addressable unit.

There is one invariant: every non-blank source line belongs to exactly one block. Break it and you get the worst failure there is — the line you want to point at is not on the screen. Lines that produce no token (a bare `>` inside a quote, for instance) are picked up at the end.

### HTML written directly in the markdown

It is escaped and shown as text (`markdown-it` runs with `html: false`).

What akapen renders is markdown under review, and it does not always come from you. With `html: true` the document goes straight into `innerHTML`, so opening a file runs arbitrary JS on akapen's origin — which serves an unauthenticated `/api/comments` and an `/api/doc` that returns the absolute path.

Leaving a hole for non-markdown to slip into a markdown reader buys less than closing it.

### Keys

While skimming you are scrolling, so a hover-based path is needed. While writing several in a row you do not want to leave the keyboard. Both exist, and **both enter the same function** — no half-working path such as "the mouse can select a range, the keyboard cannot".

| Key | Action | Action name |
|---|---|---|
| `j` / `k` | move the line focus | `row.next` / `row.prev` |
| `shift+j` / `shift+k` | grow the selection (same as a mouse drag) | `row.extendNext` / `row.extendPrev` |
| `c` | comment on the selection | `comment.start` |
| `Ctrl+Enter` | send | `comment.submit` |
| `Esc` | cancel (draft, then rail, then selection) | `comment.cancel` |
| `l` | toggle line numbers | `lines.toggle` |

The assignment is provisional and will be revisited as a whole. It is defined in one place: `packages/web/src/keys.ts`.

Arrow keys and `Enter` are deliberately unbound. Taking the arrows breaks page scrolling, which breaks reading. Add them with `--keymap`.

```bash
bun run packages/cli/src/cli.ts note.md --keymap examples/keymap.json
```

```json
{
  "row.next": ["j", "down"],
  "comment.start": ["c", "i"],
  "lines.toggle": null
}
```

Each action lists its keys. Actions you do not name keep their defaults; `null` disables one. A broken JSON starts with the default keymap and logs a warning on the server, so a mistake in the config never makes the tool unusable.

Modifiers can be written in any order: `shift+ctrl+k` and `ctrl+shift+k` are the same binding. A modifier that is not one of `ctrl`, `meta`, `alt` or `shift` cannot match any key press, so the browser console names it rather than leaving the key quietly dead.

### Packages

One binary, five packages. The split is about which direction knowledge is allowed to flow, not about shipping units.

| Package | What it is |
|---|---|
| `@akapen/shared` | the contract: Valibot schemas for every payload, and the types derived from them |
| `@akapen/core` | line mapping and the comment store. Knows nothing about HTTP |
| `@akapen/server` | Hono routes over `Bun.serve`, plus the embedded assets |
| `@akapen/web` | the browser side, bundled by `bun build` |
| `@akapen/cli` | argument parsing and the `comments` subcommand |

Everything points at `shared`, and nothing points back. `server` embeds `web`'s build output, which is the one edge that runs the other way; it stays acyclic because `web` never reaches for the server. A typed client generated from the routes (Hono's `hc`, tRPC) would close that loop — the browser would import the server to learn the shapes — and clients only get added over time. Putting the contract in `shared` keeps every client one hop from the same definition.

### The browser side is TypeScript too

`packages/web/` is bundled with `bun build` before being served, so the same `tsconfig` as the server (`@tsconfig/strictest` plus `ts-reset`) applies.

Both sides read the payloads through the same schemas rather than casting to a shared type. A cast holds only at compile time, and the two places that need it most are both run time: a request body arrives as unknown JSON, and akapen is left open while the file is edited, so a tab can outlive the server it was built against.

Schemas are Valibot, not Zod. The browser imports them, so what matters is that only the validators actually reached get bundled: checking the whole contract at run time cost 2.4KB gzipped on top of a 5.8KB `app.js`.

There are two outputs, since `bun build --compile` embeds them by name.

| Output | Contents |
|---|---|
| `packages/web/dist/app.js` | 23KB |
| `packages/web/dist/mermaid.js` | 3.4MB, **fetched only when the document has a diagram** |

Bundling mermaid into `app.js` makes that 3.3MB, parsed on every load even with no diagram. `--splitting` emits a hundred-odd hash-named chunks, which does not fit embedding by name. Two entries satisfy both.

### The right rail

Comments do not go between the lines; they appear as bubbles in a rail on the right.

This is about continuity of reading, not looks. An interruption inline breaks the thread of what you were reading. The point is to skim and keep throwing feedback as you go, and a document cut into pieces makes that impossible.

- Bubbles line up with their anchor row; overlaps push down. All the alignment is absorbed by the rail, and no rows are inserted into the document.
- The mark on the document side is a thin line at the left of the anchor row. Neither height nor position changes.
- The input box is in the rail too. A form wedged into the document would interrupt it just the same.
- Bubble and document highlight track each other, both ways.
- Below 1200px the rail collapses. Per-row markers remain, and clicking one opens it.

Dimensions can be overridden with `--ak-rail-width`, `--ak-rail-gap` and `--ak-bubble-gap`.

### History

Rounds carry no comments over. Instead, what was raised before is kept in two places.

- **Unresolved comments from earlier rounds** appear at the end of the rail. With nothing carrying over, "gone from the screen" would otherwise read as "dealt with".
- The round selector at the top, or the `R001` tag on an older comment, **switches to that round's snapshot**. The document and the comments appear exactly as they were.

No comments can be written while viewing a past round. Being able to add feedback to a past document would break the property that round number + `content.md` + line number reproduces where feedback pointed.

**Status, however, does apply to comments from earlier rounds.** "Read-only" is about the snapshot and the line anchors; freezing the status as well would leave no way to close an unresolved comment, and `akapen comments` would emit the same feedback forever.

### Rounds

A round is a frozen snapshot of the file contents. What you see is the current round's snapshot, not the live file, and comments attach to lines inside that snapshot.

A live change never swaps the document. It only says "the document changed N times", and moving on happens when a person presses "End this round". An agent's intermediate save never cuts a round.

The same rule applies to the whole screen: **SSE (`/events`) is a notification channel, not a rendering channel.** All it carries is that the document changed. The document DOM is rebuilt only when a round is cut or history is opened — both things a person did. Adding or resolving a comment updates the rail and the per-row marks alone.

A screen replaced by a payload arriving from the server destroys the reading position, the focused input, an in-flight IME composition and the text selection, with nothing to do with what the person did.

The trade-off: what the agent fixed does not appear until the next round begins. Use mdserve alongside when you want to watch it change. crit makes the same call.

### Where comments are stored

The markdown file is never touched.

```text
~/.akapen/reviews/<basename>-<hash>/
  review.json          # round metadata and the current round number
  rounds/
    001/content.md     # the frozen document
    001/comments.json  # comments anchored to lines in 001
    002/content.md
    002/comments.json
```

`AKAPEN_HOME` replaces `~/.akapen` (the tests use it to avoid touching the real store).

## Checks

```bash
bun run typecheck                  # types
bun run test                       # line mapping and round invariants (vitest)
bun run test:e2e                   # regressions in a real browser (playwright)
bun run sweep <dir>                # block splitting across every markdown file in a directory
bun run scripts/smoke-binary.ts    # build the single binary and check the embedded assets
```

There are two layers, and they sit in different places for a reason.

- `packages/<name>/tests/` — what one package promises. `core` covers line mapping and the storage layer: when these break, the line you want is missing from the screen, or a frozen document disappears. `server` covers the HTTP surface, where unknown JSON becomes a stored comment; it starts akapen as a process rather than importing it, because the assets are embedded through Bun's import attributes and because that is the path the binary takes.
- `tests/e2e/` — a real browser, driving the whole product, so it belongs to no single package and stays at the root. Focus, IME composition, the text selection and re-rendering are only visible in real DOM behaviour. None of those bugs were caught by the storage-layer tests.

E2E starts a server, a markdown file and a store per test (`tests/e2e/fixtures.ts`). Sharing one mixes comments between tests.

`install.sh` and the GitHub Actions workflows are checked in CI. To run them locally, use docker.

```bash
docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:stable install.sh
docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:latest -color
```

Across all 152 notes in a vault, no line was dropped or duplicated (24164 blocks).

## Not done yet

- Authentication. `--host 0.0.0.0` puts it on the LAN with none.
- Reviewing several files. One file per process today.
- Automating the agent handoff. `comments` has to be called; there is no equivalent of crit's `agent_cmd`.
- Replies and threads. One comment is one thread.

## Licence

MIT. See `LICENSE`.

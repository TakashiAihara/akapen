# akapen

A tool for leaving inline feedback on rendered markdown, and handing that feedback — its position and the text it points at — to an agent in a structured form.

Comments are never written into the markdown file. They live in a sidecar under `~/.akapen/reviews/`. When the markdown itself is the deliverable, as it is in a vault, this removes by design the path by which review notes end up in a commit.

Still a proof of concept. It works, but multiple files and automatic agent integration are not in it.

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
| `-A, --advertise <addr\|iface>` | address to print in the URL, or an interface to take one from (`AKAPEN_ADVERTISE` sets it once per host) |
| `--css <file>` | extra stylesheet, loaded after the defaults so it can override everything |
| `--keymap <file>` | JSON overriding the keymap, merged over the defaults |
| `--author <name>` | comment author (default `$USER`) |
| `--token <s>` | use this token instead of the stored one (`AKAPEN_TOKEN` does the same without appearing in `ps`) |
| `--no-auth` | serve with no token at all, for running behind something that authenticates |

Use `--host 0.0.0.0` to run it on a remote machine and read it from a local browser. A wildcard bind is not an address anything connects to, so what gets printed is the machine's own addresses — the section below says which, and how to pin one. An address, not a name: akapen serves literal addresses and `localhost` only, because a name is the one thing another machine on the network can claim and rebind.

### Authentication

Every request needs a token, at every bind address. The URL akapen prints carries it:

```text
akapen  /home/you/notes/design.md
  url     http://192.168.0.151:4300/?token=Cu1fE0h07o__JPQQYfF_5zDjTxU6A2X8NriPndNrSHc
```

Opening that once is the whole of logging in. akapen answers with a cookie and a redirect that takes the token back out of the address bar, so every later visit is the bare `http://host:4300` — and the URL above, kept as a bookmark, still works when the cookie is gone or you are on another browser. Opening the bookmark again redirects again: the token comes out of the address bar every time, not only on the first visit.

The token is one per host, kept in `~/.akapen/token` (mode `0600`), and it does not expire. `--token` and `AKAPEN_TOKEN` override it for one run, in that order, and neither is written to the store. One per host rather than one per instance is deliberate: cookies are not isolated by port ([RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5)), so opening any one of the akapen running on a machine authenticates the browser for all of them, including ones started later.

For curl and agents there is a header, and no cookie is set for it:

```bash
curl -H "Authorization: Bearer $(akapen token)" http://127.0.0.1:4300/api/comments
```

| Command | Meaning |
|---|---|
| `akapen token` | print this host's token |
| `akapen token --rotate` | replace it — every browser and every script holding the old one is locked out |

It is a shared secret, not a key: nothing is signed or encrypted, holding it is the whole of the authorisation, and it travels on every request. There is no TLS, so it crosses the wire in the clear — on a network where that matters, put akapen behind something that terminates TLS. Keep the token on while you do: TLS encrypts the traffic, it does not decide who may connect, and `--no-auth` behind a proxy that only terminates TLS hands the review to everyone who can reach the proxy. Rotation is the only revocation there is; a single secret cannot lock out one client and keep another. Rotating takes effect on servers that are already running — except one started with `--token` or `AKAPEN_TOKEN`, which keeps the token it was handed for as long as it runs.

`--no-auth` turns the credential off completely, so it is only for a front that authenticates on akapen's behalf — Tailscale Serve, or a proxy asking for a login. It also needs nothing else to be able to reach the port. Bind it to loopback and point the proxy there:

```bash
akapen note.md --host 127.0.0.1 -p 4300 --no-auth
```

A proxy does not protect a port that is still listening on the LAN beside it, and the `Host` check is not a credential — a client connecting directly can send whichever name it likes.

Writes have to come from akapen's own page. `SameSite` is about the site and a site does not include the port, so anything served from another port on this host — a dev server, another person's process — is same-site, and the browser attaches akapen's cookie to requests it makes here. Unsafe methods therefore require `Sec-Fetch-Site: same-origin`, or no such header at all, which is what curl and agents send.

Separately from the token, akapen refuses any request whose `Host` header is not a name it actually serves. That is not the same job. A page you visit can point its own hostname at `127.0.0.1` after loading — DNS rebinding — and the browser will then treat akapen as that page's origin and attach the cookie itself, so the token proves nothing. The `Host` header is the part of the request a script cannot choose, which is why it is the one checked. It is why loopback alone was never a defence, and it stays on under `--no-auth`.

Several akapen on one host can find each other, so `-p 0` — let the OS pick a port — is a reasonable way to start one.

```bash
bun run packages/cli/src/cli.ts list          # the akapen running on this host
bun run packages/cli/src/cli.ts list --json   # the same, for agents
```

```text
PID     URL                          ROUND  UNRESOLVED  FILE
81234   http://192.168.0.151:4300    R002   3           /path/to/design.md
81235   http://127.0.0.1:4391        R001   0           /path/to/plan.md
```

The column is a URL rather than the address each was bound to, for the same reason the startup block is one: `0.0.0.0:4300` is not somewhere to go. It carries no token — the terminal it is read in belongs to whoever started them, and a secret printed on every row would be in the scrollback of every other thing they did. `akapen token` prints it when a script needs one.

`0.0.0.0` names every interface and no machine, so it is not printed back. When the bound address is a wildcard, the startup block lists the machine's own non-loopback IPv4 addresses instead — the one carrying the default route first, the rest as `also`, because which one your browser can reach is knowledge akapen does not have.

```text
akapen  /home/me/notes/design.md
  url     http://192.168.0.151:4300/?token=6Qk3vN…
  also    http://172.17.0.1:4300/?token=6Qk3vN…
  round   001
  store   /home/me/.akapen/reviews/design-ab12cd34ef56
```

A concrete `--host` is printed unchanged. Ordering by the default route reads `/proc/net/route`, so on a platform without it the addresses come out in whatever order the OS reports them.

### Pinning the one to hand over

Listing every address is honest and still leaves you picking one out of three that cannot work. `--advertise` (`-A`) says which one, and `AKAPEN_ADVERTISE` says it once for a host that always wants the same answer — the flag wins, so reaching for it is what marks this run as the exception.

```bash
akapen note.md --host 0.0.0.0 --advertise 192.168.0.151   # this address
akapen note.md --host 0.0.0.0 -A eth0                     # whatever that interface has
export AKAPEN_ADVERTISE=eth0                              # and then neither
```

An interface yields its IPv4 address. What is pinned is checked rather than believed: akapen refuses to start on an address it does not answer to, because it would otherwise print that address and then meet it with its own 403.

A hostname is refused rather than resolved, and this is deliberate. The `Host` check leaves this machine's own name out of the set it serves — a name is the one entry somebody else on the network can claim, and rebinding it produces a same-origin page rather than a cross-origin one, which is the attack the check exists to stop. Advertising a name would mean widening that set, which is a separate decision.

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

What akapen renders is markdown under review, and it does not always come from you. With `html: true` the document goes straight into `innerHTML`, so opening a file runs arbitrary JS on akapen's origin — where the browser is already authenticated, and where `/api/doc` returns the absolute path.

Leaving a hole for non-markdown to slip into a markdown reader buys less than closing it.

### Keys

While skimming you are scrolling, so a hover-based path is needed. While writing several in a row you do not want to leave the keyboard. Both exist, and **both enter the same function** — no half-working path such as "the mouse can select a range, the keyboard cannot".

| Key | Action | Action name |
|---|---|---|
| `j` / `k` | move the line focus | `row.next` / `row.prev` |
| `shift+j` / `shift+k` | grow the selection (same as a mouse drag) | `row.extendNext` / `row.extendPrev` |
| `c` | comment on the selection | `comment.start` |
| `Ctrl+Enter` | send | `comment.submit` |
| `Esc` | cancel (switcher, then draft, then rail, then selection) | `comment.cancel` |
| `l` | toggle line numbers | `lines.toggle` |
| `o` | the other akapen on this host | `instances.toggle` |

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
| `@akapen/cli` | argument parsing and the `comments` and `list` subcommands |

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

### The other akapen on this host

One akapen is one file and one process, and the port it took exists in exactly one place: the startup line of whoever started it. Once that has scrolled away, the review is running and unreachable. A header button lists the others and links to them; `o` opens the same list, and it is not there at all while nothing else is running.

Every instance drops a file naming itself under `AKAPEN_HOME`, holding identity only: pid, address, file, start time. The round number and the unresolved count change on every comment, and a registry that has to be rewritten that often is a registry that will be wrong — so those are asked of the instance itself, over `GET /api/status`, which is also the request that proves it is alive. A crash leaves an entry behind and pids are reused, so an entry existing is not evidence of anything on its own. Entries naming a process that is gone are deleted as they are read, and the directory heals itself.

The list is built by the server, at `GET /api/instances`. The browser cannot build it: every instance is a different origin, so it would need CORS on an endpoint that has none, and one bound to `127.0.0.1` is not reachable from the reader's machine at all while being perfectly reachable from the server sitting next to it.

A link is built from the address the page was opened on, `location.hostname`, not from what the peer bound. The browser is usually not on this host — akapen is started with `--host 0.0.0.0` and read over the LAN — so `localhost` and `127.0.0.1` point at the reader's own machine. Which leaves the default bind as a case to handle rather than ignore: a peer on `127.0.0.1` cannot be opened from that browser however the link is built, so its row is listed and marked unreachable instead of carrying a link that will time out. Where a review you cannot reach is running is still worth knowing.

A row shows the basename, the round and the unresolved count. **Not the path**: directory layout is not something to hand out, and the token says a reader may see the review rather than everything about the machine holding it. `akapen list` does print it in full — that is read on the host, by whoever started them.

Instances find each other by asking, and the request carries the same token, so a peer started with a different one reads as not running.

Only instances sharing an `AKAPEN_HOME` see each other, and only on one host. Reaching across hosts is a different thing and is not built.

### Finding your own again

An agent that starts akapen leaves the url in the scrollback of the session that ran it, and nowhere else. Once that has scrolled away the review is running and unreachable, and on a host with five of them there is nothing saying which is which.

So every instance records who started it. Nothing has to be passed in — Claude Code exports `CLAUDE_CODE_SESSION_ID` to what it runs, and akapen reads it there.

```bash
akapen list --session "$CLAUDE_CODE_SESSION_ID"          # only what this session started
akapen list --json --session "$CLAUDE_CODE_SESSION_ID"   # the same, with the whole origin
```

`AKAPEN_ORIGIN_LABEL` is carried alongside it and never read: a pane id, a ticket, whatever identifies the instance in a setup akapen knows nothing about.

There is also a reverse index, for a statusline that wants to show the url and cannot afford to fork on every redraw.

```text
~/.akapen/sessions/<session-id>/<pid>      # one url, on one line
```

```bash
for f in "$HOME/.akapen/sessions/$session_id"/*; do
  [[ -r $f ]] || continue
  pid=${f##*/}
  kill -0 "$pid" 2>/dev/null || continue
  read -r url < "$f"
done
```

Pathname expansion, `kill` and `read` are all builtins, so that loop forks nothing. `kill -0` sends no signal and only asks whether the process is there; `/proc` would do as well on linux and never answer on darwin, which akapen also ships for. The pid check is a cheap way to skip an instance that has gone; what actually removes the file is `akapen list`, or the next instance to start, neither of which trusts a pid on its own — pids come round again, and an entry standing behind an unrelated process would keep a dead url on screen.

The url has no token on it. It is the one to come back to, and coming back is what the cookie already covers; a secret printed on every redraw would end up in the scrollback of everything else that terminal did. Recorded at startup it is a guess at which of this machine's addresses you will use, and a login corrects it: a cookie is scoped to scheme, host and port together, so a wrong guess is exactly one whose cookie is not sent — which forces the login that rewrites it.

After `akapen token --rotate` the existing cookies are void, so a bare url answers 401 until you open the startup line once more. That is what rotating is for.

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
~/.akapen/instances/
  <pid>.json           # one running akapen: pid, address, file, start time, origin
~/.akapen/sessions/
  <session-id>/<pid>   # the url that instance can be reached at, one line
~/.akapen/token        # the shared secret, mode 0600
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

- Reviewing several files. One file per process today; the others on the host are listed and linked to, not held by one process.
- Automating the agent handoff. `comments` has to be called; there is no equivalent of crit's `agent_cmd`.
- Replies and threads. One comment is one thread.

## Licence

MIT. See `LICENSE`.

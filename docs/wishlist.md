# wishlist

Where wants are collected. They get filed as issues once the grain is even. After that the issue is authoritative and this document stays as the record of how each decision was reached.

The first round of collection closed on 2026-08-07 and was filed. From then on the issues are authoritative; this is history.

| ID | Issue | Milestone |
|---|---|---|
| W-1 Move comments to a right rail | #1 | v0.1 |
| W-2 Mouse and keyboard both | #2 | v0.1 |
| W-3 Rounds | #3 | v0.1 |
| W-4 History of past rounds | #4 | v0.1 |
| W-5 `comments` includes earlier rounds | #5 | v0.1 |
| W-6 passive mode | #8 | v0.2 |
| W-7 Mode switching and a change banner | #9 | v0.2 |
| W-8 React to each comment | #12 | v0.3 |
| W-9 An entry point that hides which host | #13 | v0.3 |
| B-1 Single binary | #11 | v0.3 |
| B-2 Claude Code integration | folded into #12 | — |
| B-3 Multiple files | folded into #9 | — |
| B-4 Tests | #7 | v0.1 |
| B-5 Authentication | #10 | v0.2 |
| B-6 Reply threads | #6 | v0.1 |

## The review experience

### W-1 Move comments to a right rail (drop inline threads)

Today comments and the form are wedged between the lines of the document. Stop that and put them in a rail on the right as bubbles.

The aim is continuity of reading, not looks. An interruption inline breaks the thread of what you were reading. What I want is to skim and keep throwing feedback as I go, and a document cut into pieces makes that impossible.

Decided:

- Bubbles line up with the anchor row. Overlaps push down.
- The document inserts no rows. The anchor row is lightly highlighted, nothing more; neither height nor position changes.
- The input box goes in the rail too. A form wedged into the document interrupts it just the same.
- Clicking a bubble drives the highlight on the document side.
- When width runs out, collapse the rail. Only markers remain on the collapsed side.

Open:

- Rail width, and how long comments fold.
- How the markers should look.

### W-2 Mouse and keyboard both

While skimming I am scrolling, so a hover-based path is needed. While writing several in a row I do not want to leave the keyboard. Provide both.

Decided:

- The keymap lives in one place and can be overridden by config. The assignment will be revisited as a whole later.
- The mouse path (hover → button → type in the rail) and the keyboard path connect to the same route.

Provisional defaults:

| Key | Action |
|---|---|
| `j` / `k` | move the line focus |
| `c` | comment on the focused line |
| `Ctrl+Enter` | confirm |
| `Esc` | cancel |
| `l` | toggle line numbers (already implemented) |

Open:

- The actual assignment.

## Rounds and history

### W-3 Rounds (drop live following and re-anchoring)

Stop chasing positions forever and freeze the document per round. It gets out of the arms race of ever-better position tracking.

Decided:

- A round is a frozen snapshot of the file contents. Comments attach to lines inside that snapshot.
- What is shown is the current round's snapshot, not the live file.
- A person cuts a round. Only pressing "end this round" moves on; an agent's intermediate save never does.
- SSE stops swapping the document on a file change and only reports "the document changed".
- Re-anchoring goes away. Nothing carries across rounds.

This removes, structurally, the path where a file changes mid-writing and comments conflict — because what comments attach to is a frozen snapshot rather than the live file.

Storage layout (draft):

```text
~/.akapen/reviews/<basename>-<hash>/
  review.json          # round metadata and the current round number
  rounds/
    001/content.md     # the frozen document
    001/comments.json  # comments anchored to lines in 001
    002/content.md
    002/comments.json
```

The markdown file is not touched (the existing policy holds).

Trade-off: what the agent fixed does not appear until the next round begins. Use mdserve alongside when you want to watch it change. crit makes the same call.

### W-4 Follow comments from past rounds as history

Show past rounds' comments in the right rail alongside the current one. Clicking one switches the view to that round's snapshot, showing the document and the comments exactly as they were. History is read-only.

The goal is that "which version, which part, what was said" is fully reproducible from round number + `content.md` + line number.

Open:

- Whether to show a diff between rounds (what the agent changed in response to a piece of feedback).

## Agent integration

### W-5 `comments` includes unresolved comments from earlier rounds

Dropping carry-over means round N's unresolved comments do not appear in N+1's document. Disappearing from the screen is fine — history covers that — but not reaching the agent loses the feedback.

Decided:

- `akapen comments` emits unresolved comments including those from earlier rounds.
- Each carries which round and which source text it is about. Agents match on the text, so shifted line numbers do not matter.
- Closing a round *means* handing work to the agent.

## Modes

### W-6 passive mode (resident; aiming to replace mdserve)

A mode for reading files under `--root`. It follows the live file (HMR) and takes no comments.

Putting live following and comments together brings back the drift problem we just discarded. To keep "comments exist only against a frozen snapshot" true without exception, passive holds no comments.

| | passive (resident) | review (1:1) |
|---|---|---|
| Target | under `--root` | one named file |
| Document | live (HMR) | frozen per round |
| Comments | none | yes |
| Agent integration | none | yes |
| Use | read, or follow while writing | give feedback and hand it over |

Replacing mdserve also needs theme switching and the same ease of starting. It will mean rewriting the mdserve-based passages in the skills and CLAUDE.md.

### W-7 Mode switching and a change banner

One process, one port, with the mode in the URL. A port that changes every time costs more attention than it saves.

```text
akapen serve --root ~/vault --host 0.0.0.0 -p 4300

http://host:4300/                passive. file list and document (live)
http://host:4300/browse/<path>   passive. a single file
http://host:4300/review/<id>     review. frozen snapshot and the right rail
```

Switching goes both ways.

- Spot something in passive and "start a review": the contents at that moment are frozen and you land on `/review/<id>`.
- Claude Code runs `akapen open <file>`, which registers a review with the resident process and returns a URL.

The review screen shows change detection at the top, to keep the loop turning.

```text
⟳ the document changed 3 times   [next round]
```

Closing a round means handing unresolved comments to the agent (W-5), so the loop is:

read → throw feedback → close → Claude fixes → the banner appears → next round

### W-8 React to each comment in an existing Claude session (later)

Rather than closing a round and handing everything over, the agent fixes as each comment lands.

The premise is not to start a new agent. Fixing without context produces patchwork, so an existing Claude session watches instead.

The mechanism should be a blocking long poll. Claude Code wakes on a background process exiting, so a session cannot notice a permanently open SSE. "Print JSON and exit when a new comment appears" makes the exit itself the notification — the same shape as `gh-pr-wait-comment`.

```bash
akapen comments --wait --timeout 1800
```

Design points:

- A comment carries the source text from round N's snapshot. The agent matches the current file by text and fixes it. Because it is text rather than a line number, it still lands when other edits have moved things. Matching is what an LLM is good at, so akapen implements no similarity search.
- When the text is already gone, do not guess: reply "this part has already changed".
- Responses appear in the right rail as replies to the comment. B-6 (reply threads) is a prerequisite.
- No concurrency. Comments queue and are handled serially.
- Debounce rather than one launch per comment ("n queued, or a few seconds quiet" makes one batch).

A side effect of freezing is commenting on something the agent already fixed without knowing. Comparing the snapshot against the current file detects it, so mark such rows "this line has already changed" — frozen, while what is happening behind it is still visible.

Order: after W-1 and W-3. It cannot be pinned down before those shapes settle.

## Handling multiple hosts

### Decision: run on each host. Do not centralise the files

Development runs in parallel across several hosts, so the original idea was to put markserv or mdserve on pi and centralise every document. akapen does not do this.

A review is a loop of person → file → agent, and it only works when all three are on the same host.

1. File identity. If the central copy is what is served, comments attach to the copy while the agent that fixes things is on the original host. What was pointed at and what gets fixed are different objects.
2. Change detection. "The document changed" watches the original. Syncing in between delays detection, or catches half-written states.
3. Handing comments over. `akapen comments` is what the agent runs. With the store centralised, the agent on the original host cannot read it locally.

On top of that, the vault is a git repository with a clone on each host, so centralising for reading is something git already does. Reading it on each host is in fact more accurate, because that host's working tree — its branch, its uncommitted changes — is what you see.

The shape taken:

- akapen runs on each host. Port 4300 everywhere.
- Names come from Technitium (`akapen.d1.local` and so on), so only the hostname changes and no port needs remembering.
- pi holds only a page of links. akapen gains no hub feature; that would be scope it should not carry.

### W-9 An entry point that hides which host (later, not started)

The wish not to think about which host remains. One way to soften it without moving files is a hub that centralises metadata only.

- Each host's akapen registers its reviews in progress (file name, round, unresolved count) with a hub on pi.
- The hub lists them and links through to the host's own URL.
- Neither files nor comments move, so none of the three problems above appear.

Unnecessary if a static list of links is enough. Decide after living with it.

## Foundations (mine, separate from the wants above)

Order to be decided once the list is complete.

- B-1 Single binary (`bun build --compile`). Today it assumes `bun run src/cli.ts`, which is awkward from another machine.
- B-2 Claude Code integration → folded into W-8 (#12). The `agent_cmd` equivalent takes the shape of an existing session watching.
- B-3 Multiple files → folded into W-7 (#9). Solved by one process holding several reviews.
- B-4 Tests. `scripts/verify.ts` and `scripts/sweep.ts` check invariants; the rendering has only been eyeballed on a single file.
- B-5 Authentication. `--host 0.0.0.0` has none. Running passive as a resident leaves it on the LAN permanently, and once per host, so the priority is not "someday" but "before passive becomes resident".
- B-6 Reply threads. One comment is one thread today.

## Rejected

Kept so the same argument is not had twice.

- A markdown source pane on the left (three panes) — withdrawn: unnecessary unless editing is the premise. Line numbers stay off the document and toggle with `l`.
- Centralise every document on pi and review there — rejected because a review cannot work that way (see "Handling multiple hosts"). Centralising purely for reading is technically possible, but the working tree is invisible, so reading on each host is more accurate.
- Start a new agent for every comment — fixing without context produces patchwork. An existing session watches instead (W-8).
- Strengthen re-anchoring (similarity matching, position relative to headings) — made unnecessary by adopting rounds.

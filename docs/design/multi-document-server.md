# One process serving many documents

Issue #305. One long-lived `akapen serve` on one fixed port hands out every registered document under a stable path, instead of one process and one port per document.

## Background

- One process per document meant one process per review: 95 of them on one shared host, about 2.4 GB in total, each on a port that changed whenever it was restarted
- Stopping an idle agent session to free memory ran its SessionEnd cleanup, which stopped its akapen. Resuming the session meant asking for akapen again, on a new port, and the URLs handed out earlier stopped working

## Decisions

- `akapen serve` runs the server. It is an ordinary server: whatever runs services on the host starts it (a systemd user unit, a LaunchAgent, a container), and no command starts it as a side effect
- `akapen add <file>` registers a document and prints its URL; `akapen remove <file|id>` unregisters it. Registering starts nothing
- A document's URL is `/d/<store name>/`, where the store name is the directory its comments already live in: the file name and the first 12 hex digits of the SHA-1 of its absolute path. It follows from the path alone, so it survives restarts of the server and of the agent session
- The default port is 4300, changed with `-p` or `$AKAPEN_PORT`. A port that is taken is a failure, not a move: a moved port is a changed URL
- Registrations live in `~/.akapen/documents.json`. Only the server writes it; the CLI goes through `/api/documents`. One writer on one event loop is what keeps two sessions registering at once from losing one of the registrations, without a lock
- `/api/documents` answers loopback peers only, and only with the management secret in `X-Akapen-Manage`. The secret is `~/.akapen/manage-token`, 0600, created by the first `serve`, or `AKAPEN_MANAGE_TOKEN` where the home is not shared. A token holder on the LAN can read what is registered; letting them register would let them read any file the server's user can. Loopback alone is not enough: a proxy on the same host relays the LAN from loopback, and need not say so in any header

- `akapen channel` holds `/api/sessions/<id>/events` open and reads `/api/sessions/<id>/documents` instead of the store on disk; `akapen comments` reads a registered document through `/d/<id>/api/pending`. A comment or reply wakes the channel as it lands. The session routes take the management secret like `/api/documents`
- A registration is removed when its session ends (the SessionEnd hook calls `akapen remove --session <id>`), when the session's channel has been disconnected for 30 seconds (only for a session whose channel connected at least once), or by `akapen remove`. There is no dormant state
- When a session is resumed, its SessionStart hook runs `akapen restore <session id>`, which registers again the documents that session last registered, except those removed by hand, and keeps the time each was first added so a comment written while the session was away still reaches it. Which ones is recorded in each document's store (`registration.json`), so it survives the removal. `/clear` gives a new session id and restores nothing

- Comments live in `~/.akapen/comments/`. A home from before has them in `reviews/`; `akapen serve` renames it on start, but not while a one-document akapen from before is running (it would go on writing into `reviews/`). Until then everything reads and writes `reviews/`, so nothing written before the rename goes missing
- The README shows how to run the server: a systemd user unit, a LaunchAgent, and a compose file for Linux (host networking, documents mounted at the same path as on the host)
- A document page served under `/d/` links back to the list at `/` from the name in its header

## Removing the one-document mode

`akapen <file.md>`, one process for one document, is removed. What goes and what stays:

- `akapen <file.md>` exits 2 with a message that names the replacement: start `akapen serve`, then `akapen add <file.md>`
- The one-document server goes: `startServer` and what only it did (writing and removing an instance record, the per-session URL index under `~/.akapen/sessions/`, the `/api/instances` switcher of other processes). `openDocument`, which `akapen serve` mounts per document, stays
- The page's switcher of other processes goes; the name in the header already leads to the list at `/`
- The CLI talks to `akapen serve` only: `list` shows its registrations (`--session` filters them), `reply`, `resolve`, `rounds cut` and `comments` reach a registered document through it, and say so when the document is not registered
- The channel reads `akapen serve` only; the one-document registry is no longer a source
- Records an earlier version's one-document akapen left under `~/.akapen/instances/` are still read, never written: `akapen serve` keeps refusing to register a file such a process serves, and keeps holding back the `reviews/` rename while one runs. Nothing else reads them
- `--advertise` and `--host` stay, as options of `akapen serve`
- Tests that started a one-document server start `akapen serve` and `add` the file instead, and reach it under `/d/<id>/`. Tests of what only the one-document server did go with it

## Options not taken

- Guarding management by peer address and forwarding headers alone: a proxy that adds no header gets through
- Management on a unix socket: out of reach of a proxy too, but a container would have to share the socket, and the channel would have to speak to it
- The token for management as well: it is in every reader's browser, so every reader could register any file
- Port 80: needs privileges, and the existing cookies and bookmarks are on 4300
- A URL from the path itself (`/d/notes/plan.md`): readable, but it hands the directory layout to the LAN, which the page has never done
- A URL from a counter: changes when a document is registered again
- A directory with one file per registration: race-free without a server in the middle, but once the server is the only writer a single file is enough
- `add` starting the server when none answers: convenient, but it makes the CLI a process manager and fits a container badly
- A dormant registration kept after its session ends: keeps the URL working across a resume without a hook, at the cost of a state nobody asked to see. The SessionStart hook does the same with nothing kept
- Removing registrations on a done marker: depends on one person's workflow, which a public tool should not

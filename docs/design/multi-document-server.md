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
- `/api/documents` answers loopback peers only. A token holder on the LAN can read what is registered; letting them register would let them read any file the server's user can

## Planned in the same major version

- `akapen channel` connects to the server's event stream under its session id instead of reading the store from disk, and `akapen comments` reads through the API. The server is then the only reader and writer of `~/.akapen`, which is what lets it run in a container next to the sessions it serves
- A registration is removed when its session ends (the SessionEnd hook calls `akapen remove --session`), when the session's channel has been disconnected for 30 seconds, or by `akapen remove`. There is no dormant state
- When a session is resumed, its SessionStart hook runs `akapen restore <session id>`, which registers again the documents that session last registered. Which ones is recorded in each document's store, so it survives the removal. `/clear` gives a new session id and restores nothing
- `~/.akapen/reviews/` becomes `~/.akapen/comments/`, renamed in place on the first start of the new version
- `akapen <file.md>`, one process for one document, is removed
- The README shows how to run the server: a systemd user unit, a LaunchAgent, and a compose file for Linux (host networking, documents mounted at the same path as on the host)

## Options not taken

- Port 80: needs privileges, and the existing cookies and bookmarks are on 4300
- A URL from the path itself (`/d/notes/plan.md`): readable, but it hands the directory layout to the LAN, which the page has never done
- A URL from a counter: changes when a document is registered again
- A directory with one file per registration: race-free without a server in the middle, but once the server is the only writer a single file is enough
- `add` starting the server when none answers: convenient, but it makes the CLI a process manager and fits a container badly
- A dormant registration kept after its session ends: keeps the URL working across a resume without a hook, at the cost of a state nobody asked to see. The SessionStart hook does the same with nothing kept
- Removing registrations on a done marker: depends on one person's workflow, which a public tool should not

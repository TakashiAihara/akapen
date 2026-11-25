# Live comments

Issue #353. An open page shows a comment, reply or resolve written elsewhere (an agent running `akapen reply`, another tab) without a reload.

## Decision

- The stream gets a third event, `{ "type": "comments" }`, sent after every successful write of the comment store: a new comment, a reply, a resolve.
- It is a notification only, like `changed` and `round`. It carries no comment.
- On receiving it the page fetches `api/doc?round=<round on screen>` and takes only the comments (and, where shown, the carried ones) from the answer. Never the document, never the round it was built against.
- The rail is updated in place, by comment id. A bubble that did not change is not touched. A changed one has its replies replaced, and its head only when the resolved state changed (its text stays, since nothing edits a comment's text), and its reply form is never removed, re-created or moved. A new one is inserted at its line-order position; existing ones are never moved.
- After a reconnect the page asks again once the path is confirmed, since events were dropped while it was away.

## What each screen state takes from the answer

| Screen state | `comments` | `carried` |
| --- | --- | --- |
| On the current round | replaced by the answer's | the answer's entries from rounds before the one on screen, which is all of them |
| Behind (another screen cut a round past this one) | replaced by the answer's, which are this screen's round's | the answer's entries from rounds before the one on screen, so this screen's own round is left out |
| History view | replaced by the answer's, which are that round's | the answer's as it is: history shows only their count, which comes from the whole list |

- One refresh is in flight at a time. A write that lands meanwhile only makes the page ask once more when the one in flight has answered, so answers cannot arrive out of order. A request is given up after 10 seconds so one that never answers cannot stop every later refresh.
- An answer that arrives after the screen moved to another round is dropped.
- A failed refresh says nothing. The next event or reconnect recovers.
- The answer to the person's own comment, reply or resolve updates only that comment. The rest of the answer was computed before anything written after it, and replacing the rail with it would rebuild a bubble that write created, with anything typed in its reply box. Even that one comment can be behind what a refresh already showed, so the page then asks again.
- A refresh that was in flight when the person's own answer was applied is not applied. The rule is conservative: such a refresh may in fact have been computed after the write on the server, but the page cannot tell which side of the write it was computed on, and one from before it would take back what the answer showed. The refresh the answer asks for runs after it.
- The same holds in the history view: a reply or resolve there no longer reopens the round, so a draft open in it stays.
- A refresh follows every screen install (boot, opening a round, the next-round click), since an event that arrived while the payload was in flight was spent on the old screen and the payload may predate the write.
- In history the answer's carried list is taken as it is, since the count shown there is taken from the unfiltered list.
- A carried comment that is resolved, on this screen or elsewhere, stays, marked resolved, while its reply box holds text, and goes with the next refresh after the text is sent or cleared, not the moment it is cleared. It is read from its own round, where it is resolved and has what was written with the resolve. Only unresolved entries are counted.

## Why an update must not rebuild the rail

- Detaching a node, or appending an existing one again, loses focus, the caret and an in-flight IME composition. The rail used to be rebuilt on every update, which was fine while only the person's own action triggered it.
- Now an update can arrive while the person is typing a reply, so the rail is reconciled instead of rebuilt.

## Rejected options

- Carry the comments over the stream. The stream stays a notification channel (the rule that a pushed payload rebuilds a screen nobody touched), and a payload per write would have to be matched to the round each screen is on.
- Poll from the page. It costs a request per open page per interval to learn about a write the server already knows the moment it happens.
- Defer the update while a reply box has text or focus. It leaves the page stale for exactly as long as someone is reading and answering, which is when it matters, and an update to another thread would wait for no reason.
- A comments-only route. `api/doc?round=` already answers with the comments for any round. It also carries the whole document payload (measured: about 16 KB for a 6 KB note) which a refresh then ignores. A comments-only answer is left for a follow-up.

## Not included

- A bubble that got a reply while it is off screen has no marker saying so.
- A change to the store that bypasses HTTP (editing the files under the home directory) is not noticed.

## Left as is

- An error message shown on a bubble is cleared by the person's own next successful action, not by an update from elsewhere. An update cannot wipe an error the person has not acted on.
- Each event costs one refresh pass per open page, bounded to one in flight plus one follow-up: events that arrive during a pass schedule a single follow-up pass, however many there are. A pass is one `api/doc` request, whole payload included, plus one per kept carried comment's round, each with its own 10 second limit.
- A state change from elsewhere replaces a head whose own request is still out, so the button can be pressed again. A resolve that is pressed is toggled by the server each time.
- A bubble's button is re-enabled when its request is over, since the head is not replaced when the answer shows the state it already had.

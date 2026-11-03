# Attention parity with Janet

This page compares how buzz-app runs agent attention (watches, timers and
mentions) with how janet-acp runs it. A "gap" is a known difference that we
intend to close. An "intended difference" is a choice we made on purpose.

Terms:

- **Interest**: a named piece of work with saved instructions. Subscriptions (event watches, timers and function producers) belong to one.
- **Delivery address**: optional `channel` and `root` on any subscription, separate from event listening `channels`. Without an address it runs independently; with one it continues that conversation.
- **Lane**: a queue that runs one turn at a time.
- **Catch-up**: the events a watch or a mention missed, read from the relay
  when the agent comes back, and again while it is connected.

## Compared behavior

| Behavior | Janet | buzz-app | Status |
| --- | --- | --- | --- |
| Mentions have their own lane, so watch work cannot take their room | Yes | Yes. Each lane has a queue limit of 32 and a rate limit of 60. | Same |
| Turns of one Interest run one at a time, in order | Yes | Yes, in the shared agent runner, for every agent type | Same |
| Interests that run at the same time | 8 | 8, beside the mention lane | Same |
| Jobs that wait for one Interest | 8 | 8 (32 in total for watch work) | Same |
| Live events of a watch wait while that watch catches up | Yes | Yes. At most 512 events or 4 MiB wait. | Same |
| Kinds catch-up reads | Kind 9 only. Other kinds get only the recent replay that a reconnect sends. | Each watch's own kinds. A watch that names none reads the kinds live hears, as a relay read must name its kinds. | Intended difference |
| Catch-up while connected | — | A tick moves a stream's checkpoint to now only when live covers it: one channel whose route is live, and kinds live hears. Any other stream, a watch on every channel included, is read again about every 30 s, up to 10 s before now. Each such read covers the last 16 minutes again (the relay's 15-minute timestamp drift plus 1 minute for clock skew), so an event stored late with an older time is still found, also after a read cut short by a restart. The events read are kept as heard, so none is given twice. Past 256 of them, the checkpoint moves past the oldest that were read. | Intended difference |
| Catch-up page limit | 256 pages or 8 MiB for a named channel; none for `channels: "all"` | 256 pages or 8 MiB for both | Intended difference |
| Author and reply selection | A `filter` expression (`author ==`, `content ==`, `is_reply`, `!`, `&&`, `||`). A lone `root` tag or an unmarked `e` tag counts as a reply. | The relay spec's fields `authors`, `exclude_authors` and `is_reply`. Only a NIP-10 `reply` marker makes a reply, as in relay ingest and thread display. Startup converts a stored `filter` once; `content ==`, `false` and mixed `||` cannot be converted, so such a watch is skipped and shown for repair. | Intended difference |
| Watch tags are sent in the catch-up read | Yes | No. The relay applies most tag filters after its page limit, so a tagged read can return an empty page while older matches remain. The watch's own match still checks the tags, so results are the same. | Intended difference |
| Catch-up order | Newest page first, oldest first inside each page | Reads the whole window, then delivers strictly oldest first | Intended difference |
| Catch-up delivery | One event per turn | Batches of up to 64 messages or 64 Ki JSON characters (about 16k–32k tokens) per turn | Intended difference |
| Mentions missed by the live connection are caught up | On reconnect, each channel resubscribes from 5 s before its last seen event | Yes, from the agent's saved mention checkpoint, with a `#p` read the relay pages by index, with Attention on or off. Like a watch on every channel, it is read again about every 30 s while connected, and each read covers the last 16 minutes (960 s) again. It has its own pass, so a watch waiting for room cannot hold it up. Only mentions sent after the app started are answered. A one-to-one DM that does not name the agent is not read. | Intended difference |
| The agent is told that an event comes from catch-up | Yes | Yes, for every agent type with standalone turns (Claude Code, Codex and Goose) | Same |
| Conversation delivery address | No watch delivery address; reporting policy lives in Interest instructions | Optional channel/thread executes in that conversation. Explicit Interest reporting instructions override its default destination. | Intended difference |
| Timers | Yes | Yes, for every agent type with standalone turns (Claude Code, Codex and Goose) | Same |
| Conversation delivery address | Not supported | Optional `channel` and `root` continue an existing conversation | buzz-app extension |
| Plugin source watches | Not supported | `type: "source"` stores a namespaced provider and provider-owned config | buzz-app extension |
| Watch events from people other than the owner | The watch sees them | The watch sees them as data. The owner check (`fromOwner`) applies only to mentions. | Same |

## Configuration compatibility

These extensions retain the `agent-attention/v1` schema name. Older readers reject fields and watch types they do not support, retain the objects for repair, and do not execute them. Janet does not support conversation delivery addresses or plugin source watches. Conversion to Janet must reject unsupported objects rather than silently dropping a source or its destination. Converter enforcement of this requirement remains unverified.

## Known limit

Interests run beside each other once their jobs are queued. Two steps before
the queue still go one job at a time, so a busy Interest can delay the others:

- Live events that waited while their watch caught up are released oldest
  first. When the oldest one does not fit, the ones after it wait too, even
  for other Interests.
- Catch-up reads one watch at a time. A watch whose Interest has no room
  waits, and so do the watches after it and their live events.

Nothing is lost: the delayed work goes on when the busy Interest has room.

## Not yet compared

- Watch logs and diagnostics.
- Replay limits for event kinds other than 9 (see #955).

# Unread and read-state ownership

`RelaySession.unread` is the shared capability. Plugins render its immutable
selectors and submit reading intent; they do not maintain counters, sign markers,
open sockets, or write persistence. `src/features/relay/unread.ts` owns bounded
verified message evidence, `read-state.ts` owns durable intent and reconciliation,
and the existing reader/live routes carry both. Disabling Channels does not erase
accepted intent. `src/plugins/author.ts` exports the types through the existing
host-matched author preview, not a cross-version SDK or plugin sandbox.

## Consumer contract

```ts
const target = { kind: "channel", channelId } as const;
const snapshot = session.unread.snapshot(target);
const unsubscribe = session.unread.subscribe(target, render);
await session.unread.ensure(); // shared bounded observation, not per-row fetch

// A custom reading UI owns one cancellable observation lease.
const reading = session.unread.reading(channelId);
await reading.observe(visibleVerifiedMessageIds);
reading.dispose(); // on hide, retarget, focus loss, or unmount
unsubscribe();
```

Targets are `{kind:"channel",channelId}`, `{kind:"thread",channelId,rootId}`,
or `{kind:"message",channelId,messageId}`. The consumer must establish actual
reading intent before calling `observe`: this is a trusted in-process API, not
proof that a human read text. The engine resolves signed message identity,
timestamps, ancestry, deletion and current access; arbitrary timestamps are not
accepted. Cancelled leases cannot survive disposal, revocation/regrant, or a newer
manual-unread action. Restored channel heads pass signature/access verification
and supply evidence before their rows become observable.

Reusable `ChannelTimeline` and `ThreadPanel` own the standard observation policy:
focused active reading surface, visible document, settled positioning, fully
visible rows, and 300 ms dwell. Scroll/content/focus changes cancel/restart dwell. Owners explicitly wake the
scheduler when positioning finishes, even if an empty history page changes no
rows or geometry.
The list and its own composer share a reading surface; focus anywhere in an open
thread panel also qualifies, including its selected owning tab header. Explicitly
returning to a channel reads both its main conversation and its visible selected
side-pane thread tab for that channel: while focus stays anywhere in that
channel's workspace (normally the main composer), that side-pane thread
qualifies too. A thread in the main pane never borrows this grant. A link to
a message or thread (Activity, a message link) is not a plain visit and reads
only what holds focus. A hidden or collapsed pane, another channel's tab, a
members or media-review view, and a passive restoration (`preserve` focus) keep
the main conversation as the only reading surface. Inactive or hidden tab
content does not qualify. Pane motion completion restarts observation after
unchanged rows enter the viewport. Another pane, a dialog, background window,
preload, and mounted virtualizer overscan do not qualify.

Away from the bottom, observations mark individual fully visible messages. At the
physical bottom, 300 ms visibility of the newest message's bottom edge also earns
catch-up (including a message taller than the viewport):

- `activity:<channel>` uses the newest retained verified event timestamp at dwell
  completion, including replies newer than the visible top-level head. It reads
  ordinary top-level backlog only. It never acknowledges replies: replies that
  count (see [Relevant replies](#relevant-replies)) are all attention, and stay
  unread until read in their thread. Replies outside the viewer's conversations
  do not count at all, so there is no reply activity to quiet. Mentions,
  broadcasts and marked messages are not quieted by this mark: a timestamp
  would also read attention delivered later with an older one (a retried send,
  a fast clock). Participation discovered later makes a reply relevant again,
  with its own unread state intact.
- The same channel catch-up also writes `msg:` marks for the retained top-level
  mentions and broadcast replies through the bottom row, as in Slack and Discord,
  so a mention taller than the viewport is still read. Messages marked unread
  keep their intent. Mobile and older desktop clients honor these marks.
- `thread-activity:<root>` acknowledges replies through the newest reply only in
  that thread. A collapsed newest reply, or one outside the bottom viewport in a
  branch-ordered thread, cannot earn catch-up; visible rows still read individually.
- Both keys use verified event timestamps, never wall time. Neither enters generic
  channel/thread inheritance or remote override baselines. Channel catch-up ends
  a local manual unread on the channel itself; message and thread manual-unread
  intent stays. Catch-up uses the same cancellable reading lease.
- A DM is read whole. Any earned dwell in a DM, on visible rows or at the bottom,
  advances the DM's channel frontier through the newest retained verified message
  (replies included) and ends a local manual unread on the DM. It writes no
  `activity:` or per-message marks. Like catch-up, it never uses wall time.

This intentionally relaxes the old individual-row-only policy for the channel
timeline and the thread being read, without reading unopened threads' replies.

- `observedCount` is `null` when unknown or denied, never a fabricated zero.
  Otherwise it counts the bounded evidence currently known, excluding own messages,
  auxiliary events, authorized deletions, quiet agent messages and replies outside
  the viewer's conversations (see [Relevant replies](#relevant-replies)). It is **not an exact total or lower
  bound**: missing markers/deletions can overcount; missing history can undercount.
- `coverage` and `freshness` describe message evidence, separately from `sync()`.
  Evidence is capped at 4,096 events / 8 MiB; once it is full, the busiest
  channel's oldest ordinary evidence goes first, and a channel left with none is
  unknown rather than zero. A full repair reads each joined channel's recent
  window on its own, the newest events of up to 128 channels at a time, and the
  threads the viewer took part in; earlier results publish progressively and
  survive a later transport failure. The device keeps what the next repair would
  read and how far it last read the whole roster. While that record (or, in a
  session whose record was too large to save, what that session still holds) is
  complete and was confirmed within the last day, a launch, reconnect, periodic
  check or access change catches up instead, reading only what the joined
  channels gained since that point, from far enough before it that a late commit
  is still read and never from after the present, however far ahead an event is
  dated. A device's first launch, a lost or incomplete record or one not
  confirmed within the day, a catch-up with more new events than it takes, and
  an explicit `refresh()` run the full repair. See
  [Inbox: ownership and limits](inbox.md#ownership-and-limits) for what each
  reads and when the point moves. Missing thread roots can affect inherited
  markers.
  Repair evidence does not seed channel windows, alter cursors, or mark messages read.
- Initial marker/evidence observation and explicit evidence refresh are foreground
  reads so optional profiles do not block them. Reconnect/periodic sync and marker
  publication remain background. Each evidence batch gets its own queue-inclusive
  10-second deadline **after** marker observation, rather than spending it waiting
  for markers. Marker failure stays visible separately in `sync()` even when
  evidence succeeds. Concurrent `ensure()` calls share active work; a failed attempt
  needs explicit `refresh()` or reconnect, not an unlimited automatic retry loop.
- `attentionCount` is a separate observed subset: DMs, mentions, broadcasts and
  replies in the viewer's conversations. It does not trigger notifications or
  implement mute policy.
- `markThrough(target, messageId)` is explicit prefix intent through verified
  evidence. It can mark unloaded earlier messages read; do not use it for viewport
  observation. A channel prefix requires a top-level message, not a reply.
- `markChannelRead(channelId)` captures the greater of invocation-time integer
  seconds and the newest retained verified message timestamp (including replies),
  then atomically advances the explicit channel frontier and clears the channel's
  owned local manual-unread marks. It does not fetch history or select the row.
  Pre-click history arriving later stays read; events beyond the cutoff remain
  unread. Same-second arrivals are covered too. An ahead-of-time device clock is
  sticky because frontier merges take the maximum: correcting that clock does not
  rewind the cutoff. Automatic reading never uses this clock-based action.
  Empty evidence still saves the click cutoff on frontier-capable hosts; other
  hosts retain local-only clearing for the empty case. Success means local
  durability; publication may still be pending.
- `markAllChannelsRead()` snapshots selected channel cutoffs/evidence at sweep
  invocation and reserves each channel's mutation order before newer manual
  actions. It saves one channel at a time, so a slow first write cannot
  acknowledge post-click activity in a later channel. It selects accessible
  listed channels with retained unread evidence or a local mark, including thread
  marks that the channel count does not show, so an already-read community costs no writes. One failing channel does not stop
  the sweep; the first failure is rethrown afterwards. A channel whose grant is
  revoked before its turn is skipped, not failed; like a grant that arrives
  mid-sweep, it waits for the next explicit action. The community switcher's
  Mark all as read and the Shift+Escape shortcut (after a confirmation) use it
  for the selected community only, through one shared action and toast copy.
  Escape marks the open conversation through `markChannelRead`.
- `markUnreadLocal(target)` is durable **on this browser profile/device only**.
  Automatic reading does not clear it. An explicit mark-through clears that
  target's local mark. `syncedManualUnread` is `false`.
- `refresh()` retries evidence/marker observation; `retrySync()` refreshes markers
  and retries pending publication. `ReadMutationResult.durability === "saved"`
  means the local transaction committed, not that the relay accepted it.

The sidebar separates ordinary unread from directed attention. Ordinary backlog
or local manual intent strengthens the channel label; protected attention alone
retains its dot without bolding a caught-up, unmuted channel. Confirmed-muted channels
suppress ordinary automatic unread styling and offscreen cues without clearing
unread evidence; explicit manual unread can still strengthen the label.
Pending or failed mute changes do not suppress these cues. Muted DMs also suppress
automatic unread bolding; “N unread” offscreen counts and avatar previews remain. Muted
channel and DM sidebar rows show a crossed-out bell immediately after their names,
even with no unread activity. They hide all unread dots, including
thread activity dots. Thread activity remains available through the row's activity popover,
and its unread count remains accessible to assistive technology. Unmute restores
the dots from retained unread evidence. The promoted Bestie DM also hides muted
unread dots; its label follows the same mute rule.
Solo chat labels strengthen for any observed unread message, including mentions,
broadcasts and relevant replies, even when muted, so Solo rows omit the attention dot.
Ordinary unread renders no row marker. Unmuted DMs, mentions, broadcasts, and
relevant thread replies add one accent dot; non-DM row numerals are omitted and DM
avatars are reserved for promoted offscreen cues. Thread activity reuses that dot:
its hover/focus/click popover groups unread replies by canonical thread root and
opens the existing thread panel, so overlapping priority and thread activity never
produce duplicate dots. Merely revealing the popover does not acknowledge a reply.
A local manual-unread mark strengthens the label without fabricating priority; the
underlying observed count remains available.
Channel Settings → Diagnostics exposes explicit actions and Unread status/retry. Unknown and
observed-zero both omit unread styling; the API preserves the distinction. There is
no notification, feed, or exact-count service here.

When unread rows are outside the sidebar's scroll viewport, floating `N unread`
buttons reveal the nearest destination in that direction. The number counts distinct
offscreen conversations with observed unread state, not messages or an exact
community total. Any visible copy of a conversation excludes it from that edge.
Both directions preview up to three eligible one-to-one DM avatars, nearest-first,
with overlapping artwork and no additional overflow chip. Group/self DMs still count
but do not borrow one participant's avatar. Previews reuse the sidebar's existing
profile map and media routing; absent pictures use initials, humans use circles,
and agents use squircles. Avatar artwork is decorative; the button's accessible
name gives the conversation count and direction without implying a DM-first target.
The controls use shared prominent buttons with an inverse surface, with
interruptible tooltip-style transitions and reduced-motion support. Hidden cues
remain inert during exit. They share 12px corners with Jump to latest, including
their backing surfaces. Thread-only rows participate.
The controls measure existing rendered badges/dots—no extra unread
subscriptions or relay reads just to show them. Search-filtered rows do not
participate. Collapsed sections use the summary's position and expand when revealed.
A partly visible row is not outside the fold. Activation scrolls and focuses the
nearest row, retaining its ordinary focus preparation; it does not select the channel,
prefer a farther DM, or acknowledge any messages.

Thread buttons keep the relay's total reply count (plus replies this client has
sent since that summary) and add a dot when the shared thread selector has observed
unread replies or explicit thread-unread intent.
Accessible names distinguish observed evidence, stale evidence and local-only
intent; unknown/observed-zero omit the dot, not assert complete read history.
Each mounted button subscribes to its own thread, without fetching thread history.
Hovering a button does not acknowledge replies. Opening the panel qualifies as
reading while focus remains in it; viewport/bottom dwell supplies the intent.
Unread ancestry uses the same canonical marked-reference parser as thread opening
and row projection (case-insensitive hex, last valid marker wins). Resolution still
requires bounded, retained same-channel message evidence; references alone do not
grant access or trigger a read.

## Workflow mentions

For relay-signed kind-9 workflow output (`buzz:workflow=true`), the `p` tag
matching `buzz:workflow-owner` is attribution, not a mention. It counts as a
mention only when the owner also has a `buzz:workflow-mention` tag. Other `p`
recipients keep ordinary mention semantics, even without template-provenance
tags. Untrusted senders cannot suppress mentions by copying workflow metadata;
without a trusted relay identity, ordinary `p`-tag semantics remain in effect.

This shared classification feeds attention badges, Inbox, notifications and the
channel-mute mention exception. Ordinary unread, DM and participating-thread
rules still apply. No message or read marker is rewritten.

The relay currently emits `buzz:workflow-mention` only for recipients named in
the stored template as well as the rendered output. If substituted input alone
names the owner, its single `p` tag cannot distinguish that mention from owner
attribution and does not create mention attention. Put the owner's explicit
`@Name` in the template when they should be alerted. Distinguishing substituted
owner mentions requires additional relay metadata, not client-side name parsing.

## Relevant replies

Every top-level message counts. A reply counts only when it is in one of the
viewer's conversations, or it is a DM, mentions the viewer, or is broadcast to the
channel. A conversation is the set of direct replies to one parent message. The
viewer is part of it when the viewer wrote the parent or also replied to that
parent, or wrote or replied anywhere under the same canonical thread root, as in
the reference client. A thread the viewer has not posted in therefore stays
quiet, apart from mentions and broadcasts. Explicit per-message unread intent still
applies to any reply. The same rule feeds channel and thread counts, thread
activity, per-message attention and the `thread` notification category.

**Quiet agent messages.** A message whose signed `audience` tag is `agents` is
coordination between agents, which people see quietly: the agent harness sends
progress and agent-to-agent detail with it and the completion message to
everyone. It never counts toward channel or thread counts, never earns attention
(direct, mention or thread, so a `p` tag inside it is not a mention), never
appears as an Inbox item or thread activity, and never queues a conversation
lookup. This is the rule the [notification pipeline](notifications.md#running-app-behavior)
already applies. The row stays in evidence, so it is still `latestMessage` and
the live bottom that catch-up reads through, and explicit **Mark unread** still
applies to it. The tag is self-declared by the sender. Older clients, mobile and
the relay's read-state and push rules do not apply the exemption yet.

**Follow thread** / **Unfollow thread** in a message's menu records an explicit
choice for the message's canonical thread root (`threadRootId ?? id`), so every
reply under that root, at any depth, uses it. Follow makes the thread one of the
viewer's conversations without posting; Unfollow removes it even after the
viewer wrote the root or replied, and replying again does not undo it. Mentions
and broadcasts still count, as they do outside conversations. Without a choice
the label shows Unfollow exactly when that root-wide participation applies, so
the label and the alerts agree; a mention alone is not a follow. A restored
roster shows no menu until membership is confirmed. DMs have no menu item: every DM message is
direct attention. `session.unread.following(channelId, rootId)` reads the
effective state and `follow(channelId, rootId, following)` saves a choice,
throwing without change when it cannot. Choices are device-local, like the
reference client: `buzz.thread-follows.v1:<partition>` in local storage, keyed by
`channel:root`, newest 1,000 kept, shared with other windows through storage
events and forgotten with the rest of a left community's device state.

Membership is checked in the reply's own channel, and lookups are keyed by
channel and parent, so a reply in another channel that tags the same parent
gets its own answer. It starts from retained evidence. A saved Follow with
reply-only retained evidence also queues bounded structural recovery of its
missing root by ID. It does not ask for viewer participation: the saved choice
already decides membership. Until a same-channel root is verified, thread
receipts and Activity grouping cannot apply to that reply. When a reply is
otherwise unread but its conversation is undecided (the parent is not loaded,
or the viewer's own reply to it is not), a projection
that evaluates the reply queues one relay lookup for that parent. The same
lookup decides the whole thread: the viewer wrote the parent or the canonical
root, or replied anywhere under the root. One lookup per parent keeps demand
within one per retained reply, so the retained window (at most 4,096 events)
cannot need more than the 4,096 remembered lookups. That bounds what the
current window needs, not every queued lookup: lookups queued before an
overflow reset still drain. A positive result counts only through the root its
witness names (the same `channel:root` set the Follow label reads), so a reply
whose root tag disagrees with another reply to the same parent is decided by
its own root. The fetch
runs in a microtask, at background priority, in batches of up to 50 parents
from one channel:

- the missing parents, and the replies' roots, by ID;
- the viewer's replies in that channel that tag those parents or their roots
  (`#e`, `#h`, `include_aux`, limit 500). `#e` also matches root tags, so a
  full page is split and asked again; a full page for one parent pages back in
  time until a deciding reply appears (at most ten pages). Only replies whose
  reply tag names the parent, or whose root tag names its root, count, and
  deleted ones do not. The viewer's own fetched parent or root is the witness
  when there is one.

While a lookup is queued or running, the reply is quiet and its attention is
`unknown` with `pending: true`; a live notification for it waits instead of
being dropped. A read reply is never looked up: it stays `unknown` but is not
`pending`, because nothing would settle it. A failed batch keeps its parents
pending and retries with backoff (1 s doubling to 60 s), so the same parent is
never asked twice at once. A session reset or access change during a lookup
discards its answer; parents the reset kept are asked again.

Lookup results are kept apart from counted evidence, in a store bounded to
4,096 decided parents and 1,024 fetched events. Fetched parents and roots are
structure only: they give a reply its root for grouping and navigation, but
they never count, never start another lookup (so a lookup cannot climb an old
thread) and never fill the 4,096-event window. Whether the viewer wrote or
answered a message does not change with the sample, so results survive the
window's overflow reset and roster changes for still-accessible channels. A
session reset clears them. Thread attention follows the direct parent, so a
reply whose root could not be fetched still counts as the viewer's thread; it
just cannot be grouped. A later reply of the viewer turns a negative result
into membership, so it still counts after the window drops that reply. A
positive result records one of the viewer's messages that made it as its
witness (the viewer's own parent when there is one, since a later lookup reuses
the cached parent; otherwise the newest reply), and whether the viewer has
others. A later message does not replace the witness. When the viewer deletes
the witness, even after the lookup, the membership ends, or the parent is asked
again if there were others (the deleted message stays excluded and is dropped
from the cache, so it is fetched again). Witnesses are kept (up to 4,096, not
counted) so a deletion from another client still passes
the target-visibility check after the window drops them. One witness per
decided parent keeps every positive result inside that bound, however many
replies one batch returns; evicting a witness forgets its lookup, which is
asked again. Residuals: a direct reply older than 5,000 of the viewer's
root-tag matches is not seen, and a single deletion event that names several
of the viewer's messages is visible only if all of them are retained. Replies
still require retained evidence of their own.

## Explicit clearing matrix

| Intent | Durable frontier | Local manual-unread clears |
| --- | --- | --- |
| Automatic visible dwell | Individual verified message | None |
| Automatic bottom dwell | Ordinary channel activity or that thread’s replies through verified evidence | Channel only (channel bottom, not a thread) |
| Automatic DM dwell (visible rows or bottom) | DM channel through the newest retained verified message | DM channel only |
| `markThrough(target, messageId)` | Explicit verified target prefix | That target only |
| `markChannelRead(channelId)` | Channel through max(click time, newest retained verified message) | Channel, retained messages, verified same-channel reply roots, and threads whose top-level root is retained |
| Channel read with no evidence | Click time on frontier-capable hosts; none otherwise | Channel only |
| Mute/Unmute | None | None |

Channel read does not clear other channels, unproven ancestry, or remote manual
unread overrides. Bounded evidence cannot establish ownership of every historical
local mark. The channel frontier and owned local clears commit in one transaction;
storage failure changes neither, and disposal/cache clear or access revoke/regrant
invalidates queued intent. Automatic dwell retains its existing cancellation rule
for newer manual-unread intent.

## Durable sync and privacy

The journal is separate from disposable message caches in `buzz-read-state-v1`,
partitioned by relay/community scope and viewer. Leaving a community deletes that
partition along with the community's other device state; other partitions are
untouched. IndexedDB strict read/write
transactions merge concurrent local windows; Web Locks serialize the publisher.
Without host decoding the capability is `unsupported`; without safe serialized
sign/publish it is `read-only`. Read sync requires `frontier-sync`. Local manual
intent can still be saved independently of remote capability.

Signed kind-30078 NIP-RS blobs use self-encryption and a persisted random coordinate
slot/client ID. The Node development broker or the packaged Tauri identity host
owns the key and narrow codec. Native decode verifies own signed NIP-RS coordinates; native signing
accepts only bounded read-state intent, and publication rechecks the signed event
before sending it. Plugins receive no generic encryption or arbitrary-kind signing
capability. Both transports use scoped NIP-98 for reads and writes.

Accepted local intent is saved before signing; the exact signed event is saved
before sending. Lost responses/readback retain that event identity for retry. An exact timestamp
refusal on an old pending read-state event permits recovery under the same publisher
lock: read back and merge the own coordinate, reconcile if it covers the pending
state, otherwise persist a newly signed snapshot before sending it. The old envelope
remains saved until reconciliation or replacement commits; recovery does not
acknowledge rejected intent. Unknown outcomes and other refusals retain exact-byte
retries. Recent/future timestamps are not renewed, signing retains its bounded
monotonic clock, and a flush attempts at most one replacement (no re-sign loop).
`accepted` is a publish receipt, not observed coordinate state; `reconciled` also
requires readback. A failed transaction is not acknowledged as saved. Timestamps
are uint32 seconds; replaceable publication clocks advance monotonically with a
bounded lead rather than running indefinitely into the future.

Ordinary frontiers are **bounded recent hints, not everlasting read receipts**.
The sync journal has a 96 KiB serialized-blob budget and wire publication a 40 KiB
plaintext budget. Under pressure, up to three quarters of each budget keeps channel
marks (`<channel>`) first, then thread marks (`thread:`), then catch-up marks
(`activity:`, `thread-activity:`), then message marks: a channel or thread mark covers
many messages, so losing it makes much more old history unread, and recent catch-up
must never push out a quiet channel's mark. The last quarter, and any room the broad
marks leave, goes by persisted local interaction order across all marks, so the newest
read is never dropped because old broad marks fill the budget. Interaction order also
ranks marks within each group, which prioritizes newly read old history as well as
current traffic. After the budget chooses what to keep, each save drops marks that a
kept broader mark already covers, and gives the freed space to the next marks in line.
A cover that did not fit replaces nothing. A dropped mark gives its interaction order to
its cover, so the smaller wire budget protects the cover as it would have protected the
dropped read. Coverage uses retained evidence: a message mark under its channel mark, a thread mark under its
channel mark, a catch-up mark under its channel or thread mark, and the mark of an
ordinary top-level message under its channel's `activity:` mark. That last rule needs
the channel's known type, because an `activity:` mark never reads DM messages (reading
a DM writes its channel mark instead); a roster can list a channel before its metadata
gives the type. Mentions, broadcasts and
DM messages keep their marks. A thread or thread catch-up mark never replaces a message
mark: a reply finds its channel from its own event, but finds its thread only while its
root is loaded. Older desktop and mobile clients ignore `activity:`, so they show the
ordinary top-level messages it covers as unread. This is accepted; it never makes a
read in those clients unread here.
Marks without retained evidence are kept, and nothing is dropped while any override
exists. Reading an already covered message saves nothing. Only frontier-only hints can
be pruned; older messages may look unread again. No synthetic channel prefix is
introduced to fit.
The automatic activity keys share these bounded-hint limits. Older clients can
preserve/republish them but do not interpret their catch-up meaning; mixed-version
sidebar behavior is not identical. No storage migration is required.
A local-only `reserve` field in the same journal record keeps receipts evicted
from the sync journal, up to 5,000 keys / 512 KiB of serialized JSON. It preserves
actual frontiers, never manufactures channel cutoffs, and commits atomically with
the journal. Local unread decisions use both sets. Returning keys take the maximum
frontier before leaving the reserve. Its finite eviction order favors channel,
thread, then catch-up receipts before individual messages; newest event timestamps
win within each group. While overrides exist, inherited reserve floors stay protected
and direct override floors return to the journal. Without overrides, the reserve
also drops a receipt that a kept broader receipt already covers (the same rule the
journal uses), whether the cover is in the journal or the reserve.

A message, thread or thread catch-up receipt names one message but not its
channel, so a channel receipt can cover it only while the app knows that channel.
A local-only `homes` field in the same record keeps the channel of each message
that a kept journal or reserve receipt names. Each save takes it from loaded,
verified messages and drops entries that no kept receipt names. For receipts saved
without one (older saves, or receipts from other devices), the app asks the relay
for those messages once per session, after evidence repair. It asks only for
receipts that some channel receipt could cover, in batches of 100 IDs, and saves
the channels of the signed events that come back. This changes no read and
publishes nothing. A failed or empty answer keeps the receipt. Channel catch-up
(`activity:`) still covers a message receipt only while the message is loaded:
only the message says whether catch-up reads it. Old builds discard `homes` on
their next save, as with the reserve.

This extends retention only on the same browser profile/install. It cannot recover
already discarded receipts, prevent loss after exhausting the reserve, or improve a
fresh profile's smaller synced copy. An automatic observation already covered by
the reserve does not republish that receipt. Manual unread still wins. Old builds
can load the unchanged sync journal but discard the optional reserve on their next
save; community leave on any build deletes both together. No database migration
or wire-format change is involved.

Override groups, permanent clear floors, directly associated frontiers and possible
inherited channel/thread frontiers are protected; capacity failure is visible,
never floor truncation. Publication of any override-bearing state is deliberately
blocked in this release. Remote registers can be reduced/displayed, but synchronized
manual-unread and canonical override compaction are not enabled.

Marker discovery uses the relay's host-bound NIP-11 `read_state_snapshot` descriptor
when available, independently of request parameters. The exact versioned query
must return a complete own-author kind-30078 snapshot with matching community,
valid signatures and unique coordinates. Ordinary capped arrays and live EOSE do
not establish completeness. The snapshot proves one writer cut, not live freshness,
message-history completeness, a CAS revision, or a global cryptographic community
identity. Absent discovery permits only bounded ordinary marker observation.

Resource bounds: 4,096 snapshot events / 8 MiB encoded event array; envelope stream
is capped before parsing at 8 MiB + 4 KiB. Recognized read-state events can be up
to 96 KiB **on receive**, accommodating older clients' original NIP-44 maximum
plaintext (65,535 bytes → 87,472 base64 characters plus the signed envelope).
The four-event decode batches fit the unchanged 512 KiB HTTP decode budget.
New signing retains its stricter 40 KiB plaintext budget, and both signing and
direct publication retain the 64 KiB event limit. The larger receive budget
does not authorize republishing legacy records.
Blobs remain capped at 10,000 keys. Unknown/undecryptable recognized
coordinates fail marker loading rather than masquerading as empty state. Access
revocation denies projections before any subscriber can inspect another one;
durable account-owned intent survives without exposing revoked context projections.

## Verification

- `read-state-model.test.ts`: protocol reduction and algebra.
- `read-state-retention.test.ts`, `read-state.test.ts`: bounded growth, old-history
  interaction order, restart, exact-event retry, durable mutation and floor safety.
- `reader.test.ts` and history browser journeys: finite-read navigation admission,
  preserved deadlines/cancellation, actual reload and dismissed navigation. Simulated
  pagehide/pageshow tests establish handler behavior, not a full BFCache journey.
  Live-stream reconnect during a delayed departing navigation is a separate
  pre-existing host-lifecycle limitation; this is not a universal unload fence.
- `unread-startup.test.ts`: production reader/session scheduling, large-roster
  batching, progressive/partial failure, explicit/reconnect recovery and access/cache
  fences; `read-state.test.ts` also checks both marker-discovery priority paths.
- `unread.test.ts`: real session lifecycle, access, deletions, reading leases and
  reverified disk-restore evidence without network content.
- `use-reading.test.ts`, timeline/thread tests: dwell/geometry; `tests/browser/unread.spec.mjs`:
  timeline owner wiring.
- `browser-host/read-state-broker.test.mjs`: real local HTTP broker, NIP-11/NIP-98/NIP-44,
  reader envelope verification, filter rejection and streamed body limits.
- `MessageRow.test.tsx`, `tests/browser/thread-unread.spec.mjs`: thread selector
  presentation, unchanged summary counts, hover/keyboard-focus treatment, independent
  thread reading, own/peer live arrivals and reload through the production broker.
- `tests/browser/sidebar-unread.spec.mjs`: above/below destination counts and
  priority, activity-only rows, no layout shift, resize/search/collapse, keyboard
  continuation, manual intent, evidence refresh, session retargeting, and no
  reading/selection from reveal. Focus retains existing channel preparation;
  merely showing the indicators does not fetch channels.
- `tests/browser/unread.spec.mjs`: production build/React/session/IndexedDB/broker,
  observed sidebar → focused dwell → encrypted publication/readback, reload,
  cancellation and explicit local-unread clearing with network content held.
  Only upstream relay policy is modeled, with ephemeral identities. This does not
  establish native GUI behavior or deployed relay compatibility.

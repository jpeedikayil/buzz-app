# Inbox: in-progress port

Inbox is a bundled page (`buzz.inbox/inbox`) that opens recent conversations
for the selected community. The stacked evidence, conversation UI and Drafts
PRs are one user-approved Inbox launch batch; none should ship independently.

## Evidence slice (stacked with Inbox UI)

PR3 added no Inbox UI. This page uses `session.unread.inbox()` as its single
conversation projection and `session.inboxFeed` as bounded addressed history
demand. These changes are one launch batch, not a separately shippable
backend feature. Ordinary channel and thread readers, read-state storage and
outbox retain their existing ownership. No projects, approvals or reminders.

## Conversation UI (PR4; Drafts in PR5)

### Archive conversations

Archive in the row button or row context menu removes that conversation from the active Inbox. The Archive shortcut (⌃⌘A on Apple platforms, Ctrl+Shift+E elsewhere; rebindable in Settings → Shortcuts) archives the last opened conversation, or restores it in the archived view, including from the composer. The filter menu groups Type, From, and Status, followed by Drafts. Status switches between Inbox and Archived using the same single-choice highlight as Type; activity and sender selections stay in effect in either view. The existing Unread only toggle stays independent. Status, activity, sender and attention choices are saved on this device for the current account and community, with each missing or invalid choice using its own default. Older saved combined status falls back to Inbox. The toolbar wraps on narrow screens. Choosing Archived opens the archived view, where Restore returns a conversation to Inbox. Archive/Restore row buttons appear on hover or keyboard focus and remain visible without a hover pointer; row actions do not open or mark an unselected conversation read. Archiving the open conversation, from its row, context menu or the shortcut, closes its tab and opens the next visible conversation (or the preceding one at the end), marking it read as a normal selection would; with none remaining, focus returns to the list. Archiving any other row moves focus to the next visible row. Incoming replies and mentions preserve an open archived conversation and its composer draft. When a Type, From or Unread only choice leaves the list empty, Clear filters resets those three and keeps Status; an empty Archived view without them offers Show Inbox. Either returns focus to the filters. Archive records a timestamp watermark, the later of the archive time and the conversation's newest evidence, and the message IDs already observed. A fresh incoming participating-thread reply or DM message at or beyond that watermark returns the conversation to its ordinary activity views (Threads or DMs, and All activity); Mentions still requires a fresh explicit mention. DM arrivals reopen the conversation whether they are replies or top-level messages. Already observed replies and replayed older mentions do not reopen it. An archive saved for part of a session's merged top-level row hides that row only when archives cover all of its messages. Reply reopening persists without discarding the mention cutoff, so bounded evidence eviction cannot hide the reopened conversation or resurface its older mentions. A fresh explicit mention retires the saved cutoff; manual Restore clears it in every activity view. Sending a reply does not archive or restore a conversation; Inbox reuses the unchanged shared composer. Archive/filter/selection policy lives entirely in the Inbox plugin. The shared unread evidence owner supplies verified conversation-member facts (`id`, `createdAt`, `mentioned`) through the existing injected `session.unread.inbox()` capability, available to any plugin requesting `relay`. The Inbox plugin uses those facts to retire superseded archive intent; the shared contract contains no Archive state or cutoff policy.

Archive applies only to conversations admitted by the shared Inbox projection; it does not override channel visibility policy or change channel archive state. Archive is personal view intent saved on this device, partitioned by the relay session's community and viewer scope. It persists across reloads and reconnects, with the same-window subscription and cross-window storage notifications as other view intent. Failed saves leave the conversation visible and expose Retry. Archive choices do not synchronize across devices or change unread or notification policy. It does not delete messages or claim a task has finished. The archived view uses the same bounded verified conversation evidence as Inbox, so it is not a permanent full-history archive browser.

Inbox now renders chat-only DMs, mentions and participating threads through
`session.unread.inbox()`, with independent Activity type and Sender filters and
an independent Unread only toggle. Sender classification uses `session.agentChoices` and
cached/profile-backed identity evidence, never a new inventory or name heuristic.
The Mentions activity filter uses explicit mention messages for each conversation's preview, sender, ordering, resume point and unread count. A later ordinary reply does not make a read mention unread again. DMs remain direct activity rather than mentions merely because their recipient is tagged. All activity and Threads retain their conversation-wide projections. A row shows its newest message and sender, matching its time, while opening it still resumes at the oldest unread message. A Solo chat's top-level row shows the newest top-level message from anyone else, even one that is not Inbox evidence, and is ordered by it. It skips messages addressed only to agents and roots that have their own thread row; unread counts still come only from evidence.
Rows retain exact IDs and current names while `inboxFeed.incomplete` marks only specific group members awaiting their stored edit/deletion closure. Those rows say “Preview updating…” or “Preview unavailable. Retry inbox.”; other rows stay usable. This is a visible completeness warning, not a guarantee that the relay did not change after verification. A failed read exposes Retry above the list. Retry stays focusable while pending; successful recovery returns focus to the Show filter only if Retry still owned focus when its alert was removed.

The list is the Inbox page's first tab, in the host tab workspace behind `conversation.ui.Tabs`. Opening a row shows its conversation beside the list in the side tab pane, with the same reader and composer as Channels tabs: a thread at its exact message, revealed even outside the newest bounded page, or a whole DM or session conversation where its Channels tab would open. A plain open replaces the tab the previous one added, so one tab follows the selection; a tab moved to the main pane stays. The tab's right-click menu offers Open in channel, which opens its conversation in Channels; a thread opens there at the same message. A thread also names its conversation above its original message, as the rows do (`#channel` or `DM · names`); that name is a link that does the same. The pane resizes, closes and handles Escape as Channels' does. A late verified root can regroup a conversation without changing its open tab. Inbox tabs do not enter a channel visit, so showing one preserves forced-unread intent. Reading is saved by the shared unread owner, through the reader's dwell and the row's explicit read. Failed read actions retain their captured Retry unless access, the session or a newer intent retires it. A DM Retry reuses the original channel cutoff and manual-clear keys, not the retry-time clock or later arrivals. Re-clicking the selected row reselects its tab without repeating its read. Closing the tab ends the selection, so reopening the row reads it again. Archiving the selected conversation's channel, or its room becoming a Huddle, closes its tab and returns focus it held to the filters, and restoring the channel does not reopen it; other retained tabs follow Channels' unavailable placeholder, and focus their reader held moves to the tab. Re-clicking the selected row reveals its current message in its tab; a session mention that regrouped into a thread reselects its timeline tab. Context menus allow device-local Mark unread. Row accessible descriptions reuse the visible safe preview or incomplete placeholder; Show more follows the filtered result count. `NavigationItem` owns selected styling and `aria-current`. No Inbox-owned session, parallel fold, composer or outbox.

### Open Inbox with a filter

Four shortcuts open the Inbox page with its filters applied, including from the composer, like Slack's: ⌘⇧A (Ctrl+Shift+A elsewhere) opens All activity with Unread only, and ⌘⇧T, ⌘⇧M and ⌘⇧K open Threads, Mentions and DMs. Each also shows Inbox rather than Archived and leaves Drafts. Threads, Mentions and DMs keep the saved Unread only choice; Sender is never changed. They are rebindable in Settings → Shortcuts. The shortcut opens `buzz.inbox/inbox` with a versioned route (`{ attention?: "unread", activity? }`) that the page validates, and a plain open from the sidebar or topbar carries none and leaves saved filters alone. The page applies a route once per presentation of the visit, but not when Back/Forward returns to it, which keeps the filters as they were left, using the same saved choices as the filter menu, so pressing a shortcut again after changing the filters by hand applies it again, even though the host treats an identical address as the same history entry.

## Drafts (PR5)

Drafts is a quiet Inbox header action. It lists only meaningful saved composer
text in this viewer/community scope, up to 500 with explicit truncation; an
emptied selected editor stays open until send, close or confirmed delete. The
list preserves the Inbox row hierarchy and supports channel, DM and exact-root
thread coordinates. Only the selected draft loads history through the existing
channel window or ThreadPanel; thread composition waits for a verified matching
root, and a deleted/malformed root never rebinds its saved text. The shared
composer and session outbox retain recipient, admission, signing and delivery
rules. A selected channel/DM draft opens at the real returned tail without
reading or overwriting the canonical saved scroll position. The origin action
navigates separately and reports failure without dismissing the editor.

The selected editor's lifetime does not depend on list-summary eligibility. Rich
saved envelopes use an 8 MiB preview bound rather than the former 128 KiB text-sized
cutoff; larger records receive an explicit notice instead of a false empty list.
The shared composer reconciles an untouched editor with saved changes from another
window. Locally edited documents remain in place with **Load saved draft** and
**Keep my draft** choices; Send cannot silently use a conflicted document.
Foreground revision checks also prevent an observed replacement being overwritten
by stale send cleanup. These checks are not a cross-window storage transaction.

Outbox acceptance and saved-draft replacement are separate outcomes. Drafts closes
after replacement succeeds, not merely after acceptance. If no draft was ever saved
and a fresh read still confirms absence, persistent write failure does not lock the
composer after acceptance: no stale sent text needs cleanup. A nonempty unsaved
agent follow-up stays editable with a save warning. Existing or unreadable saved
revisions retain the accepted-message recovery state and offers **Retry draft cleanup**, never another
Send of that accepted body. Recovery survives composer remounts within the same
session; it is RAM evidence, not a new durable receipt or a guarantee across app
restart. Existing outbox delivery/retry ownership is unchanged.

Delete is consentful and device-local. Confirm moves keyboard focus to the
actual destructive button; Cancel restores its trigger. After **successful**
scoped saved-text cleanup, the existing attachment-draft owner clears only the
same session/destination files and aborts its pending uploads. A failed text
cleanup preserves files and text for retry; sibling channel/thread drafts and
other viewers are untouched. Successful Close, Delete and saved Send restore focus
to the invoking draft row, another remaining row, or Back to Inbox; callbacks from
an earlier visit cannot retire a later selection. Failed Delete keeps its retryable
confirmation focused. This is not a new persisted index or migration.


## Ownership and limits

`session.unread.inbox()` / `subscribeInbox()` own retained verified unread
evidence and read actions. `session.inboxFeed` owns finite, verified addressed
history demand and exact incomplete-target metadata, not a row cache. Finite
results and live arrivals, edits and deletions use the existing session admission
and shared unread fold, so own/deleted messages stay absent and unresolved roots
never become duplicate conversations. Current membership gates the feed's
completeness targets and unread's rows; joining alone does not materialize
pre-membership history without fresh shared admission. Inbox renders those shared
conversation rows directly; there is no second project/approval row merge or
feed-owned reconciliation buffer and deletion-count abort.

Channel-archived rooms are excluded from the shared Inbox projection in every
activity view. Signed archive/unarchive metadata invalidates that projection even
when membership and channel type stay unchanged. Archiving removes their rows and
closes a selected Inbox detail, without clearing retained evidence or read/local-unread
intent. Unarchiving makes retained conversations eligible again; it does not
reopen the detail. Ordinary Channels/search retain member history access and
archived posting restrictions. This is Inbox eligibility, not access revocation or
notification policy.

PR4 owns only presentation, filtering and selection. No parallel signing or persistence is
added. Optional profile enrichment belongs to PR4; access, cache clear and
session retirement fence these projections. Opening Inbox does not mark rows
read; selecting an unread row does. Canonical Messages keeps its own reading
behavior.

A DM is one conversation row, and so is a session's flat top-level timeline;
Inbox opens that session row in the channel reader. Elsewhere, including session
threads, each thread root or top-level message is its own row; a session message
whose replies are in Inbox stays with its thread.

DM read clears the channel through its newest retained evidence. Thread read
advances the thread prefix, including earlier unshown replies, plus individually
represented top-level mentions and local message marks, but not unrelated
messages. Participation follows the shared unread owner's direct-parent policy,
including its existing bounded lookups for replies whose membership is undecided.
Fetched roots and participation witnesses remain structural, never extra Inbox rows.
A root fetched only to group replies, by a lookup or a remembered thread's read, leaves
its row the existing exact-message manual-unread target until counted root evidence
arrives; its known root still supplies grouping and read-through.
Relevant replies remain thread activity even when the root cannot be fetched.
Multiple steps are not atomic: failures leave remaining evidence retryable. Manual unread is local to this device. Hosts without frontier-sync
disable read mutations. Saved frontiers are not proof of remote reconciliation.

This is **bounded recent evidence**, not a complete historical inbox. Unread
retains at most 4,096 events / 8 MiB. A full repair observes each joined
channel on its own since its read mark (or since the last week, when never read anywhere), up
to 100 recent events per channel—fewer on a large roster, so a first run's
windows together fit the budget—so one busy channel cannot push another
channel's thread out of the Inbox. The newest 500 events of up to 128 joined
channels at a time are read as well, whatever their marks, so what a window
starts after is still seen while it is that recent: in a channel only scrolled
to its end, whose catch-up mark reads no replies, an unread reply older than
the mark, and read history older than a channel's mark or a never-read
channel's week. Threads the viewer took part in—replied in, was mentioned or
answered in, or follows—are remembered per relay and viewer on this device, at
most 1,000 threads, so their new replies reach the Inbox after their channel's
window has moved on. The 50 most recently read or
written in are refetched whole on every full repair, before the channel windows,
and show as rows read or unread. The rest are asked only for replies since the
newest one the viewer wrote or read, behind the windows, and are rows only
while they hold a reply the viewer has not read: that newest reply is
remembered by ID and passed over when it returns, so a reply in the same
second is not missed and a quiet thread the viewer has read costs nothing and
shows nothing on later launches—like channel evidence older than its window,
its read replies are not rows after a relaunch—while a thread's unread replies
return on every repair until they are read, and a reply marked unread moves
that mark back to itself (a thread or root marked unread, back to the root).
A device's first repair also walks back through the viewer's own messages,
behind the windows, to learn the threads they replied in before their most
recent messages; later full repairs read only what they wrote since, and a
catch-up (below) learns it from what it reads.
With those threads, each repair keeps on this device the signed events the
next one would read of what is held, every unread or undecided row, and what
those rows depend on—roots, parents, the viewer's own messages in their
threads, edits and deletions—up to 2,048 events and 4 MiB, beyond which it
keeps none. Of each sender's edits of a message the device holds and keeps
only the newest that is not deleted, beside any newer one that is; when the
newest is deleted, the message shows the edit before it once a read returns
it, and its original text until then. A root or parent
fetched only to group replies, by a lookup or a thread read, counts only once
a channel's window or the newest events across the roster return it, and is
restored as such. A launch verifies the events
again beside its reads, not ahead of them, and shows them once all have
passed, which may be before or after the relay's first answer; one that fails
verification discards them all, keeping the threads. The record also keeps
how far this device last read the whole roster. When it is complete and that
read was confirmed within the last day, a launch, reconnect, periodic check or
change to the viewer's channels catches up instead of repairing in full: it
reads only what the joined channels gained since then—messages, edits,
reactions and deletions, from far enough before that point that a send the
relay committed late is still read—and applies it to what is held, so a
message deleted while the device was closed is dropped. The Inbox is ready
once the restored events have passed and that read's first answer has
landed, and a channel that read reached the end of counts as checked only
once the restored events are in. Besides what it reads once (below), a
catch-up reads no windows, newest events across the roster or new replies of
remembered threads: the replies it returns reach their remembered threads, a
thread newly among the 50 most recently read or written in is read whole
once, and the roots its remembered threads lack are fetched last, as a full
repair's are (below). The viewer's own
messages it returns move the walk on only when it read every channel the
viewer may have written in; while one is listed but its membership is not
yet confirmed, or the point does not cover it, the viewer's messages since
the walk stopped are read beside the catch-up instead, as a full repair
reads them, and a walk that stops short has the next check repair in full.
While the channel list is still being read, as on a reconnect or periodic
check, each of which reads it again beside the catch-up, the walk stays where
it was, so a channel that list then adds is walked from there; the walk
therefore mostly moves on at launch and in a full repair.
The point moves once that read reaches its end in every channel, to the
newest event it returned. A repair runs in full instead
on a device's first launch, after its storage was lost or the record was over
its bounds, when the record is incomplete (as after a walk that stopped short)
or was not caught up within the day, when restored events fail verification,
and on Refresh. In a full repair restored events only add to what it reads:
one that a read should have returned and did not, deleted while the device
was closed, is dropped, and one whose channel membership is not confirmed yet
waits for it. A catch-up that finds a channel with more new events than it
takes, or whose restored events fail verification after it started, runs the
full repair in the same pass. After a failed verification the Inbox loads
once that repair's first reads land, and a channel only the catch-up read is
not counted until the repair reads it. Either way the full repair
moves the point then: once it has read the newest events across the roster and every thread
and the viewer's own recent messages it asked for and, after an earlier
point, the edits and deletions since it in every channel holding events, so a
message deleted meanwhile is not kept past it; after a catch-up that stopped
short, only those it did not reach. When those edits and deletions are more
than it reads, it reads instead those of each event held in the channels it
did not read to the end that none of its reads returned, and applies them, so
nothing is dropped that was not deleted. When those of several events are more
than it reads too, it reads on in halves, down to single events, and for one
event its newest edits, with any deletion made after them, are enough. The
point moves once that read lands. When it fails, or would need too many
halves, the point stays where it was and the Inbox says some recent activity
could not be checked until a later check finishes it: the next goes on from
where that read stopped, and reads again of what it finished only what may
have arrived since. A catch-up whose
read fails leaves the point
where it was and the Inbox saying some recent activity could not be checked;
the next check reads it again. Live events never move the point. The record
keeps which channels that point covers: those read up to it, and those whose
window and the roster's newest events were read since. A channel it does not
cover—joined, regained after lost access, not yet confirmed when the point
moved, or whose window or a thread read in it failed—has its window, the
roster's newest events and its remembered threads' new replies read once
beside the catch-up, and
leaving a channel has the roster's newest events read once more, at once, so
they reach as far back as they would have without it. A catch-up only adds
channels to what the point covers; only a full repair that moved the point
sets it afresh. The record also keeps which remembered threads were read
whole: beside the catch-up, any of the 50 most recently read or written in
that was not—one the viewer just replied in, was mentioned in or followed, or
whose read failed—is read whole once, and one that leaves those 50, is
unfollowed or loses its channel's coverage is read whole again when it
returns. It keeps too which remembered threads this device read through to the
point, which a full repair from the record does not read again when the point
was confirmed within the last day: it asks them only for replies since the
point, from as far before it as a catch-up reads, in one read of up to 200 of
them at a time. From an older point each is read on its own, as one read of
many would span the whole gap. A read that comes back full is read again in
halves of its threads rather than paged, up to eight times; a half still full
after that is dropped as a failed read is: its threads no longer count as read
through, so the next full repair asks each on its own, and the point stays
where it was with the Inbox saying some recent activity could not be checked.
Of the 50 most recently read
or written in, only those read whole ride that read; the others, such as one
newly among them, are read whole. A thread not read through since the point
is still asked on its own for replies since the newest one the viewer wrote
or read, as is every thread on a device's first launch, after its storage was
lost, from a record over its bounds or one that never caught up. Such a thread
was learned beside a catch-up, which read none of its replies from before the
point, or had replies that were not kept or restored replies dropped (below),
or is in a channel the point no longer covers. When restored events fail
verification after that read, the threads it covered are read again on their
own in the same pass. A dropped
read leaves the point where it was and the Inbox saying some recent activity
could not be checked, and the next check reads those threads again. Refresh
always runs the full repair: pressed while a
catch-up runs, it runs once that ends, and pressed before a check has chosen
to catch up, that check runs it instead. The full repair also reads the
deletions made since that point in the channels holding restored events the
repair's reads did not return. If those deletions are more than it reads, or
the record never caught up, those restored events are dropped, as a device
without a record would never show them, rather than kept while they may have
been deleted, and their threads no longer count as read whole or through. The
record is then incomplete, so the next check runs the full repair, which reads
each whole or on its own rather than only since the point; if the read of
deletions fails, they are kept, and the next repair reads it again. A full
repair ends by fetching the root nothing holds of each remembered thread it
holds a reply in, whichever read brought the reply, to group it, never
counted, so the record can be saved complete: a root the relay returns
nothing for, deleted, does not keep it incomplete, and when that fetch fails
the record stays incomplete and the next check fetches the roots again.
Three narrow cases can still leave a
gap after the point: an event dated well ahead of the relay's clock can move
the point past a late send in a channel read earlier in the same repair; a
channel whose access the relay revoked before its channel list did stays
covered through a catch-up that read nothing of it; and a channel whose
window had to be read smaller to fit a response counts as read. Leaving a
community clears its record,
and a window still open on it cannot save it back; a session started after
that, as when rejoining, saves as usual. Clearing the cache clears the record
too, remembered threads included, so the next repair walks back through the
viewer's messages again as a device's first does.
In a full repair the windows, the viewer's own recent messages and the thread
reads ride together, up to 128 filters per request with two requests in
flight, so a roster costs one or two round trips; the newest events across the
roster are one more request per 128 channels, behind the windows. The Inbox is
ready once the viewer's own recent messages and the remembered threads most
recently read or written in have landed, or were dropped, and reports
`observing` while further windows still read. A catch-up is one request per
128 channels, and reads on only while a channel gained more than it returns. A read that fails is tried once more; dropped
after that, its channels or threads stay as they were—a dropped thread read
leaves its channels' counts observed—and the Inbox notes that some recent
activity could not be checked until the next refresh, with no automatic retry;
later reads that fail in the same pass are dropped at once, and a dropped walk
page leaves the walk to the next repair without a notice. A response too large
for the reader or the native host is split and read in parts rather than
retried. A repair in which no read lands fails instead, keeping the previous
evidence and its stale freshness.

For a roster of up to 128 channels with nothing new, unread reads:

| Pass | Requests |
|---|---|
| Warm tick: a periodic check or reconnect, caught up | One, with one filter: what the roster gained since the point. |
| Warm launch: caught up | The same one request. A remembered thread's root is fetched only when the thread holds a reply and nothing holds the root, and a thread newly among the 50 is read whole once. |
| Full repair from a record caught up within the day: Refresh, or a record incomplete or whose catch-up found more than it takes | Three (four at 128 channels): the viewer's recent messages with every channel's window, one read of the remembered threads read through to the point (one more per further 200 of them, and up to eight more for each that comes back full), then the newest events across the roster. Any of the 50 most recently read or written in that was not read whole is read whole beside them. Then the edits and deletions since the point, and each thread not read through, on its own. Last, the roots nothing holds of the remembered threads holding a reply. |
| Full repair without one: a first launch, lost storage, or a record over its bounds, never caught up or caught up more than a day ago | Two (three at 128 channels, whose windows with the viewer's recent messages take two): the viewer's recent messages with every channel's window, then the newest events across the roster. Then any further pages of the walk and, with a record, each remembered thread: the 50 most recently read or written in whole, the rest each on its own; from a record caught up before, the edits and deletions since its point too. Last, the roots nothing holds of the remembered threads holding a reply. |

Read state and the addressed history Inbox reads for mentions are separate
owners and not counted here.

While a
repair runs, a reply whose root is not yet retained is not shown as a row
of its own; it appears under its root once the thread read or lookup brings
it. A lookup that finds the viewer's reply in a thread, or fetches the root
of a thread they were mentioned or answered in, hands that thread to the
running repair, which reads it ahead of the remaining windows; after the
repair it is read in the background and remembered at once, so it stays in
the Inbox without a refresh. When the budget is full, the oldest evidence
outside those threads goes first; the observation completes rather than
resetting. Roots fetched only to group replies are bounded too, and those of
remembered threads go last, so their replies stay grouped. A lazy addressed
query returns up to 50 kind-9/40002 messages. For those exact IDs and
unresolved failed targets, general `#e` queries page signed kind-40003 edits
and kind-5/9005 deletions, then deletions of the edits; `include_aux` on an ordinary `#p` query is not a supported relay
contract. Both auxiliary stages must finish before the feed is ready. Retained
unread evidence can be provisionally admitted between queries, but exact target
IDs are marked incomplete **before** unread subscribers are notified. The
consumer must not show their body as current while incomplete; failures retain
that metadata and offer retry. This is a completeness signal, not atomic content
admission or a second message fold. A target outside the latest 50 addressed
rows is not discovered; if a failed target falls outside a later page its
bounded auxiliary check still runs before its incomplete flag is cleared.
Incomplete obligations survive disconnect and unrelated access revocation while
the corresponding readable unread evidence survives; full cache/session retirement
clears both. Tombstone checks include retained author edits even if a later relay
query omits their soft-deleted rows. If reference visibility withholds an auxiliary
event, the finite attempt stays failed/incomplete rather than treating the filtered
page as exhausted history. Explicit Retry can settle it once existing shared
readers have admitted the missing reference; Inbox adds no reference-resolution loop.
Auxiliary reads cap retained results at 2,000 events / 4 MiB per stage; the shared reader
keeps its existing per-request deadline and cancellation. Missing roots,
participation or older activity can omit rows; an empty Inbox does not prove
complete history. No polling, independent row source or channel window is
opened for the feed. Access/cache/disconnect/disposal fence pending reads; local
read intent remains with unread. Packaged/native acceptance and human visual
feedback remain separate.

Reminders and their NIP-ER lifecycle are **not included** in this change.
The unfinished reminder prototype is preserved separately for later work,
not shipped in the Inbox source or broker routes. Follow/mute Inbox policy,
full backlog discovery and nonchat activity are outside this slice. Project and
approval queries, grouping, routing and detail presentation are deliberately
excluded rather than presented as partial parity. Native/ACP packaged acceptance and human visual feedback
remain open. Do not treat this as the full OG Inbox port.

## Split assertion ledger

The #422 source's 2,073-line mounted file has 38 literal `it` blocks plus
four parameterized groups (2 + 2 + 3 + 2 = 9 executions), totaling
**47 executed cases**. Fourteen literal Drafts cases moved intact to PR5's
`DraftsView.test.tsx`; PR4 owns the remaining 24 literal cases and all four
parameterized core groups. The original 47 = 24 core literals +
14 Drafts literals + 9 grouped core executions. PR4's 41 expanded test runs
at its published head comprise those 33 original core cases plus eight new
regressions. PR5 adds two Drafts deletion tests. PR3 retains the existing
unread suite and feed integration cases with historical edit/first-admission
safety regressions. `view-state.test.ts` adds five scoped enumeration and
meaningful-cap tests; `attachment-draft.test.tsx` adds pending/ready cleanup
regressions.
The mixed filter case keeps its two selector assertions in PR4; its Drafts
header-button assertion belongs to PR5's mounted Drafts suite. Source
project/todo/sidebar navigation tests already on main are not copied here.

Browser mapping: original case 1's chat/filter/context/read/reflow assertions
remain in PR4; its Drafts switch/return fragment lives in PR5's Drafts view test.
Original case 2 is PR5's real rich-editor/scroll/geometry/send journey. Original
strict-window case keeps exact unread anchor/new arrival/canonical origin/deletion
in PR4 and moves saved-root newest-context to PR5. Original old-DM, session
recipient and narrow failed-save cases stay in PR4. That is the original seven
browser cases split across PR4/PR5, plus PR4's new in-head focus and Escape
focus cases and development-React StrictMode case. The joined stack runs eight
cases in PR4 and two in PR5, each in Chromium and WebKit (20 executions total).
The fixture uses per-test isolated synthetic identities/servers, preserving the
base `channelWriteKinds`, `dmMembers`, companion and stale-stream guards.

The counts above are historical PR-head counts. A later test prune removed two
mounted cases whose assertions stronger cases already make: `InboxPage.test.tsx`
"Retry repeats a rejected mark-unread mutation, not just evidence refresh"
(kept by the failed mark-unread Retry cases) and `DraftsView.test.tsx` "a
selected draft edits through the shared scoped composer without navigating or
sending" (kept by the same-window editor, 128 KiB rich-editor and emptied-editor
cases). `InboxPage.test.tsx` now collects 61 cases and `DraftsView.test.tsx` 29.

## Verification status

`inbox-feed.test.ts` exercises the real session reader/visibility/unread owners
with signed ephemeral events, including the first-admission subscriber ordering,
held edit and tombstone reads, failure/retry, reentrant access removal and cache
reset, root regrouping, and an edited addressed target older than 500 ordinary
messages. `unread.test.ts` retains the current main read/catch-up behavior and
adds Inbox projection/read-state cases. Neither file establishes browser paint,
real relay persistence or packaged/native acceptance. PR4's mounted real-session
`InboxPage.test.tsx` covers filters, read/retry and pending row/detail evidence.
`tests/browser/inbox.spec.mjs` uses the actual broker/browser in Chromium and
WebKit for exact focus, viewport/scroll, responsive failure recovery, canonical
origin and session-recipient publication. This is synthetic fixture evidence,
not human live or packaged acceptance. `DraftsView.test.tsx`,
`view-state.test.ts`, `attachment-draft.test.tsx` and
`tests/browser/inbox-drafts.spec.mjs` cover Drafts storage, exact-root admission,
scoped editing/deletion (including failed text and pending uploads), selected-only
history, native editing, scroll and responsive geometry in both engines.

### Review repairs, 2026-10-01

The uncommitted repair tree based on `9d3d43cf` passed 561 focused tests across
14 files, TypeScript, changed-file Biome, design checks and all 22 Inbox browser
executions in Chromium/WebKit. The browser total is now 11 cases per engine:
the prior ten plus one real two-page draft-storage journey. No cases were removed.
Existing native-focus cases now also cover selected-row re-click, empty-filter
focus fallback, and media Escape staying inside its portal before detail dismissal.
State/failure permutations remain in mounted React or the relay owners' tests.

The relay regressions failed before repair for both lifecycle paths, omitted
retained edits and withheld auxiliary pages. Separate advancing count/byte-limit
cases fail when their corresponding guard is removed. Mounted Drafts regressions
failed before repair for channel/thread post-send cleanup, external replacement
and a valid rich document crossing 128 KiB. The DM cutoff and cold Settings
fallback tests also fail when their repairs are reverted. An independent review
of the first dismissal fix caught a portal propagation defect; both browser engines
reproduced it before the DOM-containment guard and passed afterward.

Independent changed-path re-review found no remaining blockers in the repairs.
These are local fixture/service results, not checks on pushed PR heads or a future
merged tree. Human, live-relay and attended native/packaged acceptance remain open;
no full scan or shipping-readiness attestation is implied.


## Visual-only pass (#770)

Built on main's existing Inbox and Drafts: one filter menu, outline/filled unread
toggle, trailing unread dots, adjacent list/detail with one header, and the shared
centered draft-delete dialog. The list/detail divider reuses `usePanelSplit` and
`ResizeHandle`: drag, arrows (Shift for larger steps), Home/End and double-click
reset. The list defaults to 420px where space allows and can resize from 320px
up to a 50/50 split with the conversation, which keeps at least 316px.
Its chosen width is in memory across detail close/reopen and Inbox/Drafts switching,
not persisted across restarts. At ≤700px available width, detail replaces the list
and the divider is hidden.

All matching **already-loaded** Inbox rows render without Show more. Optional
profile enrichment remains bounded to the first 50 candidates; cached names still
apply, and uncached later names may keep key fallbacks. No new history demand,
profile loop, row cache, relay/session/unread/store or native changes.

Main retains loading, representative People/Agents filters, grouped Mentions,
selected-read visibility, read/retry, workflow attribution, thread follows, exact
readers and draft persistence. Deletion retains consent and text-before-attachment
cleanup. The former history/candidate/exact-mention work is excluded.

**Separate engineering handoff:** diagnose missing older/agent conversations by
tracing fetched events, participation evidence and filtering. Agree mixed/unknown
sender behavior, mention policy and filter persistence separately. Coordinate
John's archive/refresh/development work; progressive relay loading is not fixed here.

**Evidence:** integration with main `ce2f66ea` preserves John's #757 archive
retirement and #758 refresh status without shifting rows, plus main's #800 test
pruning. It passes 116 Inbox tests, 2 shared-hook tests, TypeScript/build and 74
Chromium/WebKit executions across Inbox, sidebar and existing panel journeys.
Independent merge-resolution review found no blockers. The prior `5b4d45d0` head
passed hosted CI and DCO; current-head hosted checks remain a separate gate.
Common splitter checks stay in Inbox; Drafts keeps cross-view width, header
alignment, narrow sizing, editing and modal/focus coverage. No browser cases were
removed. Human confirmation and required review remain open; local synthetic
checks do not attest native/live acceptance.

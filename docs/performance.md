# Local browser performance runs

Run one checkout with a few parameters:

```sh
source bin/activate-hermit
bin/pnpm test:browser:install # once per pinned browser version
bin/pnpm perf --scenario channel-open --repeat 5 --cpu 4 --out results.json
```

`--scenario all` is the default. A case name runs only that case; a group
(`channel-open`, `scroll-paging` or `thread`) runs every case whose name it prefixes, so
`scroll-paging-fast` excludes its variants. `--cpu` sets Chromium's CPU slowdown factor
(1 means unthrottled); it does not throttle network or the fixture server.
`--repeat` defaults to 5. Every sample gets fresh browser storage, signed
histories and server state; a production frontend build is shared by the worker.
One worker runs serially with no retries. Required CI runs every case once in
**Browser measurements** without timing thresholds. Locally, use `pnpm perf`;
`pnpm test` / `just scan` do not run these cases.

The existing browser fixture owns the production React/services/IndexedDB/Virtua
app and modeled local HTTP broker. The runner owns settings and measurement
windows; scenarios own setup, actions and proof that the intended work occurred.
There is no comparison engine, second checkout or prescribed optimization target.

## Measurements

The operation runs from immediately before the action until the timeline has
visible rows and unchanged visible geometry for at least 200ms across at least
three samples. Each sample reports Chromium `Performance.getMetrics` deltas and
browser timings, in milliseconds:

| Metric | Meaning |
| --- | --- |
| `scriptMs` | `ScriptDuration`: JavaScript execution |
| `layoutMs` | `LayoutDuration`: layout work |
| `styleMs` | `RecalcStyleDuration`: style recalculation |
| `taskMs` | `TaskDuration`: main-thread task time |
| `durationMs` | Browser wall time through the settling barrier |
| `loafBlockingMs` | Sum of browser-reported long-animation-frame blocking, from frames overlapping the operation, including settling |
| `firstRowsMs` | Captured browser click event to visible target rows across two rendering updates |

The first-rows endpoint gives the browser a paint opportunity; it is not a
compositor screenshot or proof that every pixel finished painting. The settle
barrier observes row IDs/positions/heights and scroll geometry, not arbitrary
future async work. A ten-second deadline (30 seconds for thread actions and
60 seconds for paging through history)
fails the sample instead of reporting an unfinished operation as a win.
Counter windows also include measurement
overhead and protocol dispatch around the action. Measured actions use browser
input: JavaScript invoked directly through the automation protocol can be absent
from `ScriptDuration`, even when included in `TaskDuration`. Categories overlap: do not
sum them or interpret them as CPU percentages. No forced GC is performed.

`loafBlockingMs` uses Chromium's [Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames).
Its `blockingDuration` accumulates blocking beyond the 50ms task budget, with
rendering included in the longest task. It is not simply frame duration minus
50ms, a frame count, or an FPS measure. The observer begins at measurement start;
unsupported browsers fail explicitly rather than reporting zero. Raw
`recording.longAnimationFrames` retains intersecting entries as `startMs`
(relative to recording start), `durationMs` and `blockingDurationMs`.

Every frame overlapping the operation contributes its entire blocking duration,
including a frame that starts before measurement or finishes after the endpoint.
This avoids reporting zero when a busy opening frame starts just before the
recording marker. It is frame attribution, not exact clipping: boundary frames
can include hover/setup work before the marker or work after the endpoint.
Frames entirely outside the operation do not contribute.
The API's aggregate cannot be split accurately. After counters stop, collection
allows two further rendering opportunities and a queued task for late LoAF
delivery. This bounded drain retains the final frame in our Chromium regression
probe, but is not a presentation acknowledgement: unusually delayed presentation
feedback can still omit a trailing entry. The drain is outside the existing
duration and counter windows. Recorder overhead remains included; no subtraction
is applied.

`channel-open` measures two independent cases with fresh state:

- `channel-open-cold` clicks a never-opened, never-hovered channel and requires a
  head read during opening.
- `channel-open-hover` gives the same unopened channel a 150ms hover head start,
  then clicks whether preparation is finished or still running. CPU throttling
  applies during hover too. There is no response-completion or idle wait.
- `channel-open-cold-markdown` repeats the cold case with the
  [Markdown corpus](#corpus-variants).

Every case measures click-to-first-rows and browser work during opening plus
settling. Work completed before the click earns the hover case a head start;
remaining preparation can contribute to the measured work. Browser-counter
windows exclude pre-measurement hover work; LoAF totals include whole overlapping
boundary frames as described above. `work.hoverMs` records the requested lead and raw
`recording.hoverLeadMs` records the actual browser hover-to-click interval, which
can exceed 150ms due to browser scheduling and protocol dispatch. Head-read counts
before and during opening are diagnostic evidence; hover does not require zero
new reads. Each target has 120 mixed-height text messages; the existing app chooses
how many it initially loads. The corpus content and timestamps are fixed; signing
identities are ephemeral.

The hover case replaces `channel-open-prepared`, which waited for a completed head
response and an idle opportunity. Those older results are a different workload;
collect a new baseline rather than comparing them as equivalent.

## Scrolling

```sh
bin/pnpm perf --scenario scroll-short --repeat 5 --cpu 4
bin/pnpm perf --scenario scroll-long --repeat 5 --cpu 4
bin/pnpm perf --scenario scroll-paging --repeat 5 --cpu 4
```

All scroll scenarios use the same observer, counters, fresh contexts and result format:

| Scenario | Workload |
| --- | --- |
| `scroll-short` | 800px upward at 1600px/s within the loaded head of a 120-message channel |
| `scroll-long` | 12,000px upward at 4000px/s across a 360-message channel, fully loaded before measuring |
| `scroll-paging-fast` | Repeated 2500px upward gestures at 25,000px/s through 640 mixed-height messages, with 100ms added older-response delay, until the oldest message is visible |
| `scroll-paging-delayed` | The same complete traversal with 500ms added older-response delay |
| `scroll-paging-fast-keyboard` | `scroll-paging-fast` in keyboard modality |
| `scroll-paging-fast-markdown` | `scroll-paging-fast` through the [Markdown corpus](#corpus-variants) |
| `scroll-paging-fast-first-seen` | `scroll-paging-fast` with [first-seen](#corpus-variants) older pages |

The long case loads older pages without traversing them first, so the gesture
encounters rows the virtualizer has not yet mounted/measured. Setup waits for
page processing to finish, rejects the history-limit notice, then settles geometry.
Neither short nor long windows permit older-page reads. They isolate rendering
from pagination.

Wheel input lands in the timeline gutter, away from message hover. Setup reaches
Messages through palette arrow keys, which set `html[data-keyboard-navigation]`;
in that state the app prepares each newly mounted row's full action bar. Every scroll
case except `scroll-paging-fast-keyboard` therefore ends setup with a real
pointer press at the gutter point. The press clears keyboard modality and
focuses the message list, as clicking into a conversation does, so the reading
observer runs during the gesture. `scroll-paging-fast-keyboard` only moves the
pointer there, keeping keyboard modality and focus outside the list as after
palette navigation. Each sample asserts its modality and focus before measuring
and records `work.modality`. Scroll results recorded before the pointer press
ran in keyboard modality, like `scroll-paging-fast-keyboard`; rerun baselines
before comparing them.

The short and long Chromium gestures must produce wheel events, scroll-offset movement
of at least 80% of the request, multiple visible messages and changed visible IDs.
Raw frames and work receipts record the requested distance/speed, history size,
released pages, wheel count and observed rows. `scrollTopRangePx` is the observed
offset range, including virtualizer corrections; it is not physical input distance.

`--scenario scroll-paging` runs every paging case; so does the default `all`.
Use a full case name to isolate one. Each case has its own samples and
summary; the runner never pools their metrics. The same `--cpu` setting applies
to all. There is no delay parameter or implicit CPU matrix.

Paging cases start with only the head loaded. The modeled HTTP broker adds the named
delay to each older-page response; there are no page-completion or idle waits
between gestures. Arrivals compete with scrolling and pending virtualizer
corrections, the workload behind [the held-range prepend fix](https://github.com/block/buzz-app/pull/1066).
The existing installed-Virtua tests protect that correction's correctness; these
scenarios measure its browser cost. They use normal-height text, unlike the
taller short/long corpus. Fast retains pressure from closely spaced arrivals;
delayed exercises more waiting while the user keeps scrolling. These are
repeatable modeled conditions, not production latency percentiles or a guarantee
that every run hits a particular scheduling race. The delay starts after the
fixture computes its response; browser queueing, transport and verification add
to it. `work.olderReleaseDelaysMs` records actual server-side release delays.

Paging measures a complete traversal, not however many pages fit a fixed time:
input continues until the oldest message is visibly in the viewport, with a
200-gesture safety bound and a 60-second recording deadline. Those bounds allow
for the intentional per-page waits in the delayed variant. Successful samples
require real wheels, multiple older reads, all expected older fixture IDs in
released responses, and the oldest message still visible after settling. Work receipts record gesture/page counts, unique older rows
received and the endpoint ID. A stalled traversal fails; it cannot win by doing
less work. There is no mount-count target or automatic performance verdict.

These variants replace the experimental zero-delay `scroll-paging` workload;
collect new baselines rather than treating those old results as equivalent.

`rafMaxGapMs`, `rafP95GapMs` and `rafGapsOver50` describe animation-frame callback
cadence during the gesture. Raw `gestureStartMs` and `gestureEndMs` timestamps
are relative to the recording start: the first observed wheel event and the
browser marker after Chromium reports the synthetic gesture complete. For paging,
that marker follows the last gesture and its visible-oldest check; gaps between
successive gestures remain inside the cadence window. The end includes the
marker's protocol dispatch. Gaps are clipped to those boundaries,
including partial gaps before the first and after the last callback inside the
window. All callbacks count, including stalls when the scroll offset is unchanged.
The settling tail after the end marker is excluded from cadence only:
`scriptMs`, `layoutMs`, `styleMs`, `taskMs`, `durationMs` and `loafBlockingMs` cover scrolling
plus settling, with the same measurement overhead.

Recordings without these gesture timestamps used whole-operation cadence,
including the settling tail. Their cadence values are not comparable with the
new definition; rerun baselines before comparing. That cadence change added no
summary metrics.
Callback gaps expose main-thread stalls, not compositor FPS or a measured
dropped-frame count. No generic blank-time, overlap or visual-shift verdict is
inferred from them.

## Corpus variants

The default corpus is inert prose: an identifying line plus repeated sentences,
authored by the viewer. Two opt-in fixture options change one property each, so a
variant differs from its base case only there.

`markdownMessages` (the `-markdown` cases) ends seven rows in eight with common
chat content after the same height-varying text: colon prose, a second
paragraph, a bare URL and a Markdown link, an `@mention` bound to a fixture
profile, a nested bullet list with inline code and emphasis, a fenced code block,
or a quote with emphasis and strikethrough. The eighth row stays inert prose.
Lists are bullets only, because browser helpers find the timeline through its
single ordered list.

The app verifies each relay event's signature once per connection and reuses that
proof. Its startup unread read takes each joined channel's newest 100 events
since its read mark and the newest 500 across joined channels, so default
history reaches the app before measurement, including the newest of the 620
older paging rows. `firstSeenHistory` (`scroll-paging-fast-first-seen`) has
the fixture honour the never-read window start, which the 2023-dated history
predates, and its second channel's newer messages fill the newest 500, so none
of that history reaches the unread read. Older pages then first reach the app,
and are verified, during the measured traversal. The fixture records the event
IDs of each modeled HTTP query response when it computes the response, which
for a held older page is before release.
Paging samples record `work.olderRowsServedBefore`, and the first-seen case
requires zero. This proves which events arrive first-seen, not when background
verification of the startup read finishes; setup does not wait for it. The option
adds 500 newer messages by the viewer in a second channel, which fill the
viewer's own recent-messages read and the newest 500, plus their signatures at
setup and one sidebar row. There is no first-seen channel-open case: verifying
its one 20-event head page is within that case's sample-to-sample variation,
and the second channel also changes unread state before the click.

## Rich thread lifecycle

`--scenario thread` measures `thread-open-rich`, `thread-close-rich` and
`thread-reopen-rich` independently with the existing metrics. Each sample starts
fresh; close and reopen establish their prerequisite open state outside the
measurement. Normal pointer-triggered panel animations remain enabled.

The signed corpus has 120 replies from twelve participants, including eight
agents, and eight additional channel threads.
The auxiliary roots fit in the initial channel page before the measured thread
and use reply summaries
without inserting their replies into the top-level history. Initial setup requires
all eight auxiliary roots and their rendered reply counts. Each phase records
the actual mounted channel row IDs and checks
that all eight roots remain mounted at the start of its measured action.
Channel roots use distinct millisecond ordering from ordinary rows, so fresh
signing identities cannot change their order or bubble grouping.
Twenty nested replies remain collapsed as in an ordinary opening; the visible tree mounts 100 direct replies
plus its root. The mix includes prose, mentions, links, Markdown tables, task
lists, code, quotes, fifteen image previews and ten video previews. Media uses
the repository's local image/video assets, not network downloads. Visible images
must decode, videos must have loaded data and dimensions, and both transitions
and thread geometry must settle. Offscreen lazy images retain normal loading.

Each measured action also observes the channel through the existing 200ms
geometry barrier. Close first waits for actual thread DOM removal and the
channel's original width, then for Virtua's pointer hold to end, settled channel
geometry and restoration of its reading anchor. Draft setup settles before
measurement. Close also records channel geometry before/at/after the window and
fails if another settling check reveals reflow after the endpoint. Every phase
checks the channel draft, and reopen checks the saved thread draft. These are
work-completion checks, not new timing counters. The workload covers populated
thread mounting and panel reflow, not video playback, gallery interaction,
expanding nested replies or live agent streaming.

## Results and iteration

JSON contains raw per-frame geometry, work evidence, all samples and per-metric
median/min/max/sample count. Only wholly passing samples enter summaries. Inspect
the top-level status and each run's errors before using a number; a failed command
is never a successful optimization. Runtime/source identity, dirty status, CPU
setting, viewport, host load and setup timing accompany the samples. A dirty
listing is not a content hash: tie claims to a clean commit.

Every invocation creates a fresh ignored `test-results/perf/run-*` evidence
directory. Existing fixture evidence and failure screenshots are retained there;
the summary defaults to that directory or writes the exact `--out` path. Reusing
an explicit output path replaces that summary. Traces/video are off to reduce
measurement overhead; use the existing functional browser runner for diagnostics.

Choose any relevant metric (including scripting) as the objective, keep the
scenario and settings fixed, and inspect all other metrics plus actual work.
Keep baseline JSON, make one change, rerun, and confirm promising changes with
repeated samples and the existing correctness tests. Use an idle machine and
alternate baseline/candidate runs when making a performance claim. Comparing
different CPU settings, browsers, fixtures or concurrent host loads is not a
controlled comparison. The runner does not decide which tradeoffs are acceptable.

This is Chromium-local evidence with modeled backend responses (immediate except
for the named paging delays),
HTTP interception (which disables HTTP cache) and preloaded fonts. Channel and
scrolling workloads use text; the rich thread workload adds local media and
multiple authors.
It does not measure production network latency, native hosting, WebKit,
long-session memory growth or application startup. Add those as explicit workloads
when needed rather than changing the meaning of existing samples.

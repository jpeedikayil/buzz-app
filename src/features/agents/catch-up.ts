// Saved catch-up progress for event watches, as Janet keeps it: one stream
// for each watch and channel, which reads the watch's own kinds, and one for
// the agent's mentions. Each window of missed events is read whole, newest
// page first, within a bound, and then delivered oldest first. Only the
// progress is saved, never an event.
import { CHAT_KINDS } from "./attention";
import type { Agent } from "./service";
import type { EventData, ReadFilter } from "../relay/events";
import type { AgentStore } from "./store";
import { AGENT_KEY, type AgentKey, pubkeyOf } from "./membership";
import { CHANNEL_KINDS, LIVE_RESUME_LAG } from "../relay/live";

export const CATCH_UP_KEY = "buzz.agents.catch-up.v1";
/** Events in one read, as Janet's catch-up pages are. */
export const CATCH_UP_PAGE = 16;
/** The most pages one window reads, and its most bytes, as Janet bounds a
 * named channel's window. Past either, the oldest missed events are skipped. */
export const CATCH_UP_PAGES = 256;
export const CATCH_UP_BYTES = 8 * 1024 * 1024;

/** Every event of the stream created at or before `through` was delivered
 * or skipped. While a window (`through`, `upper`] is being delivered, `after`
 * is the last event delivered of it, in delivery order: oldest first, ties by
 * id. A restart goes on after it, up to `upper`. One read with an overlap
 * keeps `through` behind it and lists what it delivered as heard, so its next
 * read still finds an event stored late below it. `heard` are later ones
 * already heard live or delivered, which catch-up skips too. `read`, when
 * later than `through`, is how far the stream was last read: one read again
 * with an overlap keeps `through` behind it. `hidden` marks one moved while
 * no plugin showed Attention: once one does, even after a restart, it starts
 * from then. */
export type Checkpoint = Readonly<{
  through: number;
  upper?: number;
  read?: number;
  after?: Readonly<{ created_at: number; id: string }>;
  heard?: readonly Readonly<{ created_at: number; id: string }>[];
  hidden?: true;
}>;
/** Events each stream keeps as heard past its checkpoint. A tick moves the
 * checkpoint past them every few seconds while the app listens; past this,
 * `heardOf` moves it past the oldest. */
export const HEARD_LIMIT = 256;
/** The most heard events a stream keeps while it cannot move past them, as
 * when its reads fail while live goes on; past it, the oldest go anyway. */
export const HEARD_MOST = 16 * HEARD_LIMIT;
/** Seconds a stream that live does not cover reads again below the top of
 * its last read: as far as live resumes behind a drop. The relay accepts an
 * event whose time is up to its drift behind when it stores it, and the
 * clocks can disagree by a little more, so a later read must still reach it. */
export const POLL_OVERLAP = LIVE_RESUME_LAG;
export type Checkpoints = Readonly<Record<string, Checkpoint>>;
/** One watch's history in one channel, or in every channel it may read; or,
 * with `mentions`, the messages that name that agent anywhere. */
export type Stream = Readonly<{
  key: string;
  slug: string;
  channel?: string;
  mentions?: string;
  /** The watch's kinds; a watch of every kind reads those live hears, as a
   * relay read must name its kinds. */
  kinds: readonly number[];
  since: number;
  enabled: boolean;
}>;
type Position = Pick<EventData, "id" | "created_at">;

const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const ID = /^[0-9a-f]{64}$/;
/** Delivery order: oldest first, ties by id. */
export const oldestFirst = (a: Position, b: Position) =>
  a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The slug of an agent's mention stream. Attention slugs have no `@`. */
export const MENTIONS = "@mentions";
/** Whether `event` is of the stream's kinds and of its channel, and names
 * its agent when it is a mention stream. */
export const inStream = (
  stream: Pick<Stream, "kinds" | "channel" | "mentions">,
  event: Pick<EventData, "kind" | "tags">,
) =>
  stream.kinds.includes(event.kind) &&
  (stream.channel === undefined ||
    event.tags.some(
      ([key, value]) => key === "h" && value === stream.channel,
    )) &&
  (stream.mentions === undefined ||
    event.tags.some(
      ([key, value]) => key === "p" && value === stream.mentions,
    ));
/** The key of a membership's watch's stream in one channel, or in every
 * channel. */
export const streamKey = (agent: AgentKey, slug: string, channel?: string) =>
  JSON.stringify([agent, slug, channel ?? null]);
/** Whether `event` of a stream is past its checkpoint: not delivered or
 * skipped yet. */
export const undelivered = (checkpoint: Checkpoint, event: Position) =>
  event.created_at > checkpoint.through &&
  (!checkpoint.after || oldestFirst(event, checkpoint.after) > 0) &&
  !checkpoint.heard?.some(({ id }) => id === event.id);

/** `checkpoint` with `heard` as what it heard past it: each once, oldest
 * first. Past `HEARD_LIMIT` of them the oldest go, and `through` moves up to
 * the newest of those, so none is given again after a restart; but never
 * past what was read, nor into the second of a window's last delivered
 * event, so no event left to read is passed over. Those it cannot move past
 * stay, up to `HEARD_MOST`: a later read or tick moves past them. */
export function heardOf(
  checkpoint: Checkpoint,
  heard: readonly Position[],
): Checkpoint {
  const { heard: _, read, ...rest } = checkpoint;
  let through = checkpoint.through;
  const past = (list: readonly Position[]) =>
    list.filter((event) => event.created_at > through);
  const done = past([
    ...new Map(
      heard.map(({ created_at, id }) => [id, { created_at, id }]),
    ).values(),
  ]).sort(oldestFirst);
  const over = done.length - HEARD_LIMIT;
  if (over > 0) {
    const bound =
      checkpoint.upper === undefined
        ? Math.max(through, read ?? through)
        : checkpoint.after
          ? checkpoint.after.created_at - 1
          : through;
    through = Math.max(
      through,
      Math.min(bound, (done[over - 1] as Position).created_at),
    );
  }
  const kept = past(done).slice(-HEARD_MOST);
  return {
    ...rest,
    through,
    ...(read !== undefined && read > through ? { read } : {}),
    ...(kept.length ? { heard: kept } : {}),
  };
}

/** Each agent membership's catch-up progress has its own key, so programs
 * that run different agents and share this storage never write over each
 * other's progress. */
export const CATCH_UP_PREFIX = "buzz.agents.catch-up.v1:";
export const catchUpKey = (agent: AgentKey) => `${CATCH_UP_PREFIX}${agent}`;

/** The membership a stream key belongs to, or undefined for a malformed key. */
function ownerOf(key: string): AgentKey | undefined {
  try {
    const [agent] = JSON.parse(key) as unknown[];
    return typeof agent === "string" && AGENT_KEY.test(agent)
      ? agent
      : undefined;
  } catch {
    return undefined;
  }
}

/** A valid checkpoint, with its fields in one order; undefined otherwise. */
function checkpointOf(value: unknown): Checkpoint | undefined {
  const { through, upper, read, after, heard, hidden } = (value ??
    {}) as Checkpoint;
  if (
    !time(through) ||
    (upper !== undefined && !(time(upper) && upper > through))
  )
    return undefined;
  const valid =
    after === undefined ||
    (upper !== undefined &&
      time(after.created_at) &&
      after.created_at > through &&
      after.created_at <= upper &&
      ID.test(after.id));
  if (!valid) return undefined;
  const live = (Array.isArray(heard) ? heard : []).filter(
    (event) =>
      time(event?.created_at) &&
      typeof event.id === "string" &&
      ID.test(event.id),
  );
  return heardOf(
    {
      through,
      ...(upper !== undefined ? { upper } : {}),
      ...(time(read) && read > through ? { read } : {}),
      ...(after
        ? { after: { created_at: after.created_at, id: after.id } }
        : {}),
      ...(hidden === true ? { hidden } : {}),
    },
    live,
  );
}

/** The valid checkpoints of one stored value, of `agent`'s streams only when
 * it is given. */
function parseStreams(text: string | null, agent?: string) {
  let stored: unknown;
  try {
    stored = JSON.parse(text ?? "null");
  } catch {
    return {};
  }
  const streams =
    (stored as { version?: unknown; streams?: unknown } | null)?.version === 1
      ? (stored as { streams: unknown }).streams
      : undefined;
  if (!streams || typeof streams !== "object") return {};
  const checkpoints: Record<string, Checkpoint> = {};
  for (const [key, value] of Object.entries(streams)) {
    if (agent !== undefined && ownerOf(key) !== agent) continue;
    const checkpoint = checkpointOf(value);
    if (checkpoint) checkpoints[key] = checkpoint;
  }
  return checkpoints;
}

/** One stored value, the same text for the same progress. */
const serialize = (checkpoints: Checkpoints) =>
  JSON.stringify({
    version: 1,
    streams: Object.fromEntries(
      Object.entries(checkpoints).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
  });

/** Every agent's progress: its own key's, or else the old shared value's. */
export function readCheckpoints(storage: AgentStore): Checkpoints {
  const legacy = parseStreams(storage.get(CATCH_UP_KEY));
  const own: Record<string, Checkpoints> = {};
  for (const key of storage.keys()) {
    if (!key.startsWith(CATCH_UP_PREFIX)) continue;
    const agent = key.slice(CATCH_UP_PREFIX.length);
    own[agent] = parseStreams(storage.get(key), agent);
  }
  return Object.assign(
    Object.fromEntries(
      Object.entries(legacy).filter(([key]) => {
        const agent = ownerOf(key);
        return agent !== undefined && !own[agent];
      }),
    ),
    ...Object.values(own),
  );
}

/** Valid checkpoints by agent. */
function byAgent(checkpoints: Checkpoints) {
  const agents = new Map<string, Record<string, Checkpoint>>();
  for (const [key, value] of Object.entries(checkpoints)) {
    const agent = ownerOf(key);
    const checkpoint = checkpointOf(value);
    if (agent === undefined || !checkpoint) continue;
    const streams = agents.get(agent) ?? {};
    streams[key] = checkpoint;
    agents.set(agent, streams);
  }
  return agents;
}

/** Saves the progress of each agent whose progress changed since `saved`,
 * this program's last save or read, in its own key, and removes the key of
 * an agent with none left. An agent this program did not move is never
 * written, so it keeps what the program that runs it saved, even when this
 * program's copy of it is older. Settles once every write is saved. */
export async function writeCheckpoints(
  storage: AgentStore,
  checkpoints: Checkpoints,
  saved: Checkpoints,
) {
  const next = byAgent(checkpoints);
  const last = byAgent(saved);
  const writes: Promise<void>[] = [];
  for (const agent of new Set([...next.keys(), ...last.keys()])) {
    const streams = next.get(agent);
    const before = last.get(agent);
    const text = streams && serialize(streams);
    if (text === (before && serialize(before))) continue;
    writes.push(storage.set(catchUpKey(agent), text ?? null));
  }
  await Promise.all(writes);
}

/** Moves progress from the old value that held every agent's into one key
 * per agent, then removes it, as `splitLegacyRecords` does records. A key
 * is only added where none is saved: a program that starts from the old
 * value after another moved it, and ran its agents on, keeps their newer
 * progress. */
export async function splitLegacyCheckpoints(storage: AgentStore) {
  if (storage.get(CATCH_UP_KEY) === null) return;
  const agents = byAgent(readCheckpoints(storage));
  try {
    await Promise.all(
      [...agents].map(([agent, streams]) =>
        storage.add(catchUpKey(agent), serialize(streams)),
      ),
    );
    await storage.set(CATCH_UP_KEY, null);
  } catch (error) {
    // This must not stop startup. The shared value stays, so the progress is
    // read from it and the move is tried again at the next start.
    console.error("Agent catch-up progress was not split", error);
  }
}

/** The membership's streams: its mentions, which it answers with attention
 * on or off, and one for each channel of each event watch, enabled or not. */
export function streamsOf(agent: Pick<Agent, "key" | "attention">) {
  const streams: Stream[] = [
    {
      key: streamKey(agent.key, MENTIONS),
      slug: MENTIONS,
      mentions: pubkeyOf(agent.key),
      kinds: CHAT_KINDS,
      since: 0,
      enabled: true,
    },
  ];
  for (const { slug, value } of Object.values(agent.attention)) {
    if (value.type !== "event") continue;
    for (const channel of value.channels === "all"
      ? [undefined]
      : value.channels)
      streams.push({
        key: streamKey(agent.key, slug, channel),
        slug,
        ...(channel ? { channel } : {}),
        kinds: value.kinds.length ? value.kinds : CHANNEL_KINDS,
        since: value.since,
        enabled: value.enabled,
      });
  }
  return streams;
}

/** A stream's missed events to deliver, oldest first, and the checkpoint
 * that says what of its window is already done. */
export type Window<Event extends Position> = Readonly<{
  events: readonly Event[];
  /** The window's upper bound. */
  upper: number;
  /** Delivered or skipped so far; saved before any event is delivered. */
  checkpoint: Checkpoint;
  /** Older missed events were skipped: the window passed its bounds. */
  skipped: boolean;
  /** Every event read of the window, delivered now or before; not one stored
   * late below where an interrupted window went on, which is still to give. */
  read: readonly Position[];
}>;

/** Reads the stream's missed events through `upper`, or undefined when there
 * are none to read. A window read only in part before goes on after the last
 * event it delivered, up to its own upper bound, which may be older than
 * `upper`. Pages are read newest first; past `CATCH_UP_PAGES` pages or
 * `CATCH_UP_BYTES` bytes the read stops, and the oldest second it reached is
 * skipped with everything older, so no event of a second is left half
 * delivered. Only `#h` and `#p` are sent, which the relay pages by index: it
 * applies most other tag filters after its page limit, so a page could come
 * back empty with older matches left. */
export async function readWindow<Event extends Position>(
  stream: Stream,
  saved: Checkpoint | undefined,
  upper: number,
  read: (filter: ReadFilter) => Promise<readonly Event[]>,
): Promise<Window<Event> | undefined> {
  const checkpoint = saved ?? { through: stream.since - 1 };
  const floor = Math.max(stream.since, checkpoint.through + 1);
  const window = checkpoint.upper ?? upper;
  if (floor > window) return undefined;
  // Read through `upper` already, keeping an overlap open behind it.
  if (checkpoint.upper === undefined && (checkpoint.read ?? -1) >= upper)
    return undefined;
  const after = checkpoint.after;
  const pending = (events: Event[]) =>
    events.sort(oldestFirst).filter((event) => undelivered(checkpoint, event));
  // What is read and known given: an older second than `after`'s, not
  // heard, was stored late, so a later read finds it.
  const given = (events: Event[]) =>
    events.filter(
      (event) =>
        !after ||
        event.created_at >= after.created_at ||
        !!checkpoint.heard?.some(({ id }) => id === event.id),
    );
  const events: Event[] = [];
  let bytes = 0;
  let cursor: Position | undefined;
  for (let pages = 0; ; pages++) {
    const bounded = pages === CATCH_UP_PAGES || bytes > CATCH_UP_BYTES;
    const filter: ReadFilter = {
      kinds: [...stream.kinds],
      ...(stream.channel ? { "#h": [stream.channel] } : {}),
      ...(stream.mentions ? { "#p": [stream.mentions] } : {}),
      since: floor,
      until: cursor?.created_at ?? window,
      ...(cursor ? { before_id: cursor.id } : {}),
      // At its bounds, only whether anything older is left.
      limit: bounded ? 1 : CATCH_UP_PAGE,
    };
    const page = await read(filter);
    if (!page.length) break;
    const last = page.at(-1) as Position;
    // The relay returns the newest first, ties by id ascending; a page that
    // does not move below the cursor is refused, so a bad relay cannot loop.
    const below =
      last.created_at < (filter.until as number) ||
      (last.created_at === filter.until &&
        (filter.before_id === undefined || last.id > filter.before_id));
    if (!below || last.created_at < floor)
      throw new Error("The relay returned a page out of order");
    if (bounded) {
      // The oldest second reached may go on below: it is skipped whole.
      const reached = (cursor as Position).created_at;
      return {
        events: pending(events.filter((event) => event.created_at > reached)),
        read: given(events.filter((event) => event.created_at > reached)),
        upper: window,
        checkpoint: {
          through: Math.max(reached, checkpoint.through),
          upper: window,
          ...(after && after.created_at > reached ? { after } : {}),
        },
        skipped: true,
      };
    }
    for (const event of page) {
      events.push(event);
      bytes += JSON.stringify(event).length;
    }
    cursor = last;
  }
  return {
    events: pending(events),
    read: given(events),
    upper: window,
    checkpoint: {
      through: checkpoint.through,
      upper: window,
      ...(after ? { after } : {}),
    },
    skipped: false,
  };
}

/** The checkpoint once `last`, the newest event delivered of the window, and
 * every one before it are; or, with no `last`, once all of it is. */
export function delivered(window: number, last?: Position): Checkpoint {
  if (!last) return { through: window };
  return {
    through: last.created_at - 1,
    upper: window,
    after: { created_at: last.created_at, id: last.id },
  };
}

/** The checkpoint once `given`, the window's events delivered so far, oldest
 * first, are. One with an `overlap` keeps `through` where the window began
 * and lists them as heard, with what it `heard` before, so a read after an
 * interruption still finds an event stored late below them. */
export function admitted(
  window: Window<Position>,
  given: readonly Position[],
  heard: readonly Position[] = [],
  overlap = 0,
): Checkpoint {
  const last = given.at(-1);
  const cursor = delivered(window.upper, last);
  if (overlap <= 0 || !last) return cursor;
  // A window resumed after an `after` saved without an overlap delivered
  // all of that second once it goes on to a later one, and lists none of
  // it. One saved with an overlap lists them, and keeps `through` where it
  // began, so each later read still finds an event stored late below it.
  const { through, after } = window.checkpoint;
  const listed = !after || heard.some(({ id }) => id === after.id);
  return heardOf(
    {
      ...cursor,
      through: listed
        ? through
        : Math.min(after.created_at, last.created_at - 1),
    },
    [...heard, ...given],
  );
}

/** The checkpoint once all of `window` is delivered, keeping its last
 * `overlap` seconds open so the next read finds an event the relay stores
 * late with an older time. Every event read of them, and every one already
 * `heard`, stays heard, so none is given twice. Past `HEARD_LIMIT` of them,
 * the overlap shrinks to keep the newest. */
export function finished(
  window: Window<Position>,
  heard: readonly Position[] = [],
  overlap = 0,
): Checkpoint {
  if (overlap <= 0) return { through: window.upper };
  const through = Math.max(window.checkpoint.through, window.upper - overlap);
  return heardOf({ through, read: window.upper }, [...heard, ...window.read]);
}

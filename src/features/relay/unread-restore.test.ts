import { getEventHash, verifiedSymbol } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { ReadFilter, RelayEvent } from "./events";
import type { InboxItem } from "./inbox";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import { keypair, signed, type Key } from "./testing";
import { memoryThreadFollows } from "./thread-follows";
import { createUnread } from "./unread";
import {
  memoryUnreadStorage,
  UNREAD_RECORD_BYTES,
  UnreadRecordPurged,
  type UnreadStorage,
} from "./unread-storage";

// Unit tests get a no-op recorder; this one records restore verification.
const cpu = vi.hoisted(() => vi.fn());
vi.mock("../developer/client-metrics", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../developer/client-metrics")>();
  return { ...actual, clientMetrics: { ...actual.clientMetrics, cpu } };
});
// Restore yields between its batches; a test may hold it there.
const restoreHold = vi.hoisted(() => ({
  held: undefined as Promise<void> | undefined,
}));
vi.mock("./yield", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./yield")>();
  return {
    yieldToHost: async () => {
      await restoreHold.held;
      return actual.yieldToHost();
    },
  };
});
/** Holds restore at its next yield until `release`. */
function holdRestore() {
  let release = () => {};
  restoreHold.held = new Promise((resolve) => {
    release = () => {
      restoreHold.held = undefined;
      resolve();
    };
  });
  return release;
}

// What a relaunch restores of the saved evidence, and what a save keeps
// (design §3.2). Events are signed: restore verifies them again.
const viewerKey = keypair();
const peerKey = keypair();
const viewer = viewerKey.pubkey;
const T = 1_000_000;
const NOW = (T + 100_000) * 1000;
const post = (
  key: Key,
  channelId: string,
  created_at: number,
  tags: string[][] = [],
  content = `${channelId} ${created_at}`,
) =>
  signed(key, {
    kind: 9,
    content,
    created_at,
    tags: [["h", channelId], ...tags],
  });
const reply = (
  key: Key,
  channelId: string,
  root: RelayEvent,
  created_at: number,
  tags: string[][] = [],
) => post(key, channelId, created_at, [["e", root.id, "", "reply"], ...tags]);
const deletion = (key: Key, channelId: string, target: RelayEvent) =>
  signed(key, {
    kind: 5,
    content: "",
    created_at: target.created_at + 1,
    tags: [
      ["h", channelId],
      ["e", target.id],
    ],
  });
// Read traffic newer than everything else: the roster sample is these alone.
const busy = Array.from({ length: 500 }, (_, i) =>
  post(peerKey, "busy", T + 50_000 + i),
);
const BUSY_READ = { busy: T + 60_000 };
// The delta reads these kinds of each 128 channels, from the mark less
// 1,865 s; the read of deletions reads the last three.
const DELTA_KINDS = [9, 40002, 40008, 40003, 5, 9005];
const deltaRead = (filters: readonly ReadFilter[]) =>
  filters.some((filter) => filter.kinds?.join() === DELTA_KINDS.join());
// The device clock, in seconds.
const SECONDS = NOW / 1000;
let hashes = 0;
/** An event the relay returns and no restore verifies: hashed, not signed. */
const hashed = (
  channelId: string,
  created_at: number,
  kind = 9,
  tags: string[][] = [],
): RelayEvent => {
  const template = {
    kind,
    pubkey: peerKey.pubkey,
    created_at,
    content: `${channelId} ${created_at} ${hashes++}`,
    tags: [["h", channelId], ...tags],
  };
  return {
    ...template,
    id: getEventHash(template),
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
};

const ROSTER = ["team", "quiet", "dm", "busy"];
const summaries = (ids: readonly string[]) =>
  ids.map(
    (id): ChannelSummary => ({
      id,
      name: id,
      members: [viewer],
      ...(id === "dm" ? { channelType: "dm" as const } : {}),
    }),
  );

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  restoreHold.held = undefined;
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});

/** One launch against a relay holding `store`: its query returns each
 * filter's newest matches, leaves deleted events out, matches an event with
 * no `h` tag to `#h` by its target's channel, and, as the relay does,
 * attaches edits and deletions only to top-level and depth-limited
 * reads, which the repair does not send. `down` fails every evidence read
 * (the repair's, the delta's and the read of deletions), `fail` the ones it
 * matches; `now` is the device clock, and `rosterSettled` says whether the
 * channel list is the relay's whole answer. */
async function launch({
  store,
  storage,
  frontiers = {},
  follows = memoryThreadFollows(),
  roster = summaries(ROSTER),
  down = false,
  fail = () => false,
  now = () => NOW,
  rosterSettled = () => true,
}: {
  store: readonly RelayEvent[];
  storage: UnreadStorage;
  frontiers?: Readonly<Record<string, number>>;
  follows?: ReturnType<typeof memoryThreadFollows>;
  roster?: readonly ChannelSummary[];
  down?: boolean;
  fail?: (filters: readonly ReadFilter[]) => boolean;
  now?: () => number;
  rosterSettled?: () => boolean;
}) {
  const tagged = (item: RelayEvent, name: string, values: readonly string[]) =>
    item.tags.some(
      ([tag, value]) => tag === name && values.includes(value ?? ""),
    );
  const filedUnder = (item: RelayEvent): string[] => {
    const own = item.tags.flatMap(([tag, value]) =>
      tag === "h" && value ? [value] : [],
    );
    if (own.length) return own;
    const target = store.find((other) => tagged(item, "e", [other.id]));
    return target ? filedUnder(target) : [];
  };
  let held: Promise<void> | undefined;
  let waiting: (filters: readonly ReadFilter[]) => void = () => {};
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      if (
        filters.some(
          (filter) => filter.kinds?.includes(9) || filter.kinds?.includes(5),
        )
      ) {
        if (held) waiting(filters);
        await held;
        if (down || fail(filters)) throw new Error("Relay read timed out");
      }
      const removed = new Set(
        store.flatMap((other) =>
          other.kind === 5
            ? other.tags.flatMap(([tag, id]) =>
                tag === "e" ? [`${other.pubkey}:${id}`] : [],
              )
            : [],
        ),
      );
      const deleted = (item: RelayEvent) =>
        removed.has(`${item.pubkey}:${item.id}`);
      return filters.flatMap((filter) => {
        const matched = store
          .filter(
            (item) =>
              !deleted(item) &&
              (!filter.kinds || filter.kinds.includes(item.kind)) &&
              (!filter.ids || filter.ids.includes(item.id)) &&
              (!filter.authors || filter.authors.includes(item.pubkey)) &&
              (filter.since === undefined || item.created_at >= filter.since) &&
              (filter.until === undefined ||
                item.created_at < filter.until ||
                (item.created_at === filter.until &&
                  item.id > (filter.before_id ?? ""))) &&
              (!filter["#h"] ||
                filedUnder(item).some((id) => filter["#h"]?.includes(id))) &&
              (!filter["#e"] || tagged(item, "e", filter["#e"])),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
        const ids = matched.map((item) => item.id);
        return filter.include_aux &&
          (filter.top_level || filter.depth_limit !== undefined)
          ? [
              ...matched,
              ...store.filter(
                (item) =>
                  (item.kind === 5 || item.kind === 40003) &&
                  tagged(item, "e", ids),
              ),
            ]
          : matched;
      });
    }),
  };
  let journal: ReadJournal | undefined = {
    ...newReadJournal(),
    state: { frontiers, overrides: {} },
  };
  const reads = createReadState({
    viewer,
    reader,
    host: undefined,
    storage: {
      async update(change) {
        journal = readJournal(change(journal), viewer);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  let list = roster;
  const listeners = new Set<() => void>();
  const channels: ChannelQueries = {
    list: () => ({ status: "ready" as const, channels: list }),
    subscribeList(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  // Barriers. Restore reports each verified batch and admits the evidence
  // right after the last, so the reported count reaching the record's is the
  // moment it is in. A save waits for restore and the reconciles behind it,
  // so the session's first save, landed, is past both when online.
  let verified = 0;
  const verifying: [number, () => void][] = [];
  cpu.mockImplementation((stage: string, _ms: number, count: number) => {
    if (stage !== "verify.restore") return;
    verified += count;
    for (const waiter of [...verifying])
      if (verified >= waiter[0]) {
        verifying.splice(verifying.indexOf(waiter), 1);
        waiter[1]();
      }
  });
  let issued: (landed: Promise<void>) => void = () => {};
  const firstSave = new Promise<void>((resolve) => {
    issued = resolve;
  });
  // A test of a refused save may never await it.
  firstSave.catch(() => {});
  const owner = createUnread({
    reads,
    channels,
    reader,
    viewer,
    follows,
    // Spies a test puts on `storage` later still see each call.
    storage: {
      read: () => storage.read(),
      save(record) {
        const landed = storage.save(record);
        issued(landed);
        return landed;
      },
      close: () => storage.close(),
    },
    now,
    rosterSettled,
  });
  owners.push(owner);
  /** Evidence reads wait until `release`; `waiting` resolves with the first
   * that does. */
  function hold() {
    let release = () => {};
    held = new Promise((resolve) => {
      release = resolve;
    });
    const first = new Promise<readonly ReadFilter[]>((resolve) => {
      waiting = resolve;
    });
    return { release, waiting: first };
  }
  return {
    owner,
    reader,
    reads,
    /** How many restored events have been verified: restore admits them
     * once all have. */
    verified: () => verified,
    /** Resolves once restore has admitted a record of `count` events. */
    restored(count: number) {
      return new Promise<void>((resolve) => {
        if (verified >= count) resolve();
        else verifying.push([count, resolve]);
      });
    },
    /** The session's first save, landed. */
    saved: firstSave,
    /** Resolves once the Inbox publishes a row that `matches`. */
    inboxed(matches: (item: InboxItem) => boolean) {
      return new Promise<void>((resolve) => {
        const check = () => {
          if (!owner.capability.inbox().items.some(matches)) return;
          stop();
          resolve();
        };
        const stop = owner.capability.subscribeInbox(check);
        check();
      });
    },
    rows: () =>
      owner.capability
        .inbox()
        .items.map(({ id, messageIds, unreadCount, preview }) => ({
          id,
          messageIds,
          unreadCount,
          preview,
        })),
    count: (channelId: string) =>
      owner.capability.snapshot({ kind: "channel", channelId }).observedCount,
    hold,
    /** A reconnect's pass, from its first evidence read to its end. */
    async reconnected() {
      const { release, waiting } = hold();
      try {
        owner.reconnect();
        await waiting;
        const pass = owner.capability.ensure();
        release();
        await pass;
      } finally {
        release();
      }
    },
    roster(next: readonly ChannelSummary[]) {
      list = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
const saved = async (storage: UnreadStorage) =>
  ((await storage.read())?.events ?? []).map(
    (event) => (event as RelayEvent).id,
  );

it("a relaunch that reads only storage shows every row and count the warm repair shows", async () => {
  const storage = memoryUnreadStorage();
  const follows = memoryThreadFollows();
  // A lost thread, as in #buzz-team: the viewer replied long ago, and only
  // the thread reads reach it; its unread answer was edited.
  const lost = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", lost, T + 1);
  const answer = reply(peerKey, "team", lost, T + 2);
  const edit = signed(peerKey, {
    kind: 40003,
    content: "edited",
    created_at: T + 3,
    tags: [
      ["h", "team"],
      ["e", answer.id],
    ],
  });
  // A read mention in a thread the viewer is not part of, which the
  // mention feed delivered.
  const asked = post(peerKey, "team", T + 10);
  const mention = reply(peerKey, "team", asked, T + 11, [["p", viewer]]);
  // A thread the viewer follows.
  const followed = post(peerKey, "team", T + 20);
  const followedReply = reply(peerKey, "team", followed, T + 21);
  follows.write(new Map([[`team:${followed.id}`, true]]));
  // A quiet channel's unread top-level message, and a DM.
  const quiet = post(peerKey, "quiet", T + 30);
  const direct = post(peerKey, "dm", T + 40);
  // A thread the viewer started long ago, whose answer arrived live: later,
  // only the thread reads reach the viewer's root, which makes it theirs.
  const begun = post(viewerKey, "team", T + 50);
  const answered = reply(peerKey, "team", begun, T + 51);
  // R1: an unread reply below the channel's catch-up mark, in a thread the
  // viewer started, which only the roster sample reads.
  const started = post(viewerKey, "team", T + 90_000);
  const r1 = reply(peerKey, "team", started, T + 90_001);
  const store = [
    lost,
    mine,
    answer,
    edit,
    asked,
    mention,
    followed,
    followedReply,
    quiet,
    direct,
    begun,
    answered,
    ...busy,
    started,
    r1,
  ];
  const frontiers = {
    ...BUSY_READ,
    quiet: T + 25,
    "activity:team": T + 95_000,
    [`msg:${mention.id}`]: T + 11,
  };
  // A fresh launch, then a warm one, against the relay. The repair's reads
  // carry no edits: this one arrived live, once its target was read.
  const fresh = await launch({ store, storage, frontiers, follows });
  fresh.owner.accept([asked, mention, answered]);
  await fresh.owner.capability.ensure();
  fresh.owner.accept([edit]);
  await fresh.owner.capability.refresh();
  fresh.owner.dispose();
  const warm = await launch({ store, storage, frontiers, follows });
  await warm.owner.capability.ensure();
  await warm.saved;
  const expected = [
    { rootId: lost.id, unreadCount: 1, preview: "edited" },
    { rootId: asked.id, unreadCount: 0 },
    { rootId: followed.id, unreadCount: 1 },
    { rootId: begun.id, unreadCount: 1 },
    { rootId: started.id, unreadCount: 1 },
    { channelId: "dm", unreadCount: 1 },
  ];
  expect(warm.owner.capability.inbox().items).toEqual(
    expect.arrayContaining(expected.map((row) => expect.objectContaining(row))),
  );
  expect(warm.count("quiet")).toBe(1);
  expect(warm.count("team")).toBe(4);
  const rows = warm.rows();
  const shown = rows.flatMap((row) => row.messageIds);
  expect(await saved(storage)).toEqual(expect.arrayContaining(shown));
  expect((await storage.read())?.complete).toBe(true);
  warm.owner.dispose();
  // The relay cannot be read: the rows and counts come from storage alone,
  // verified as the channel heads' restore is.
  const count = (await saved(storage)).length;
  cpu.mockClear();
  const offline = await launch({
    store,
    storage,
    frontiers,
    follows,
    down: true,
  });
  await offline.owner.capability.ensure();
  await offline.restored(count);
  expect(offline.rows()).toEqual(expect.arrayContaining(rows));
  expect(offline.count("quiet")).toBe(1);
  expect(offline.count("team")).toBe(4);
  expect(
    cpu.mock.calls
      .filter(([stage]) => stage === "verify.restore")
      .reduce((total, [, , count]) => total + count, 0),
  ).toBe(count);
  expect(direct.id).toBeDefined();
  expect(quiet.id).toBeDefined();
});

it("a cold thread's read root, which only a fresh launch's walk lists, is not restored", async () => {
  const storage = memoryUnreadStorage();
  // More threads than are read whole: the oldest is read since its mark.
  const threads = Array.from({ length: 51 }, (_, i) => {
    const root = post(peerKey, "team", T + 10 * i);
    return {
      root,
      mine: reply(viewerKey, "team", root, T + 10 * i + 1),
      answer: reply(peerKey, "team", root, T + 10 * i + 2),
    };
  });
  const store = [
    ...threads.flatMap(({ root, mine, answer }) => [root, mine, answer]),
    ...busy,
  ];
  const frontiers = { ...BUSY_READ, team: T + 1000 };
  const [cold] = threads;
  assert(cold);
  const row = expect.objectContaining({ rootId: cold.root.id });
  const fresh = await launch({ store, storage, frontiers });
  await fresh.owner.capability.ensure();
  await fresh.saved;
  expect(fresh.owner.capability.inbox().items).toContainEqual(row);
  fresh.owner.dispose();
  expect(await saved(storage)).not.toContain(cold.root.id);
  // Neither a warm repair nor what it restores lists it again.
  const count = (await saved(storage)).length;
  const warm = await launch({ store, storage, frontiers });
  await warm.owner.capability.ensure();
  await warm.saved;
  expect(warm.owner.capability.inbox().items).not.toContainEqual(row);
  expect(warm.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: threads.at(-1)?.root.id }),
  );
  warm.owner.dispose();
  const offline = await launch({ store, storage, frontiers, down: true });
  await offline.owner.capability.ensure();
  await offline.restored(count);
  expect(offline.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: threads.at(-1)?.root.id }),
  );
  expect(offline.owner.capability.inbox().items).not.toContainEqual(row);
});

it("a tampered event discards the restored evidence, keeping the threads the repair reads again", async () => {
  const saving = memoryUnreadStorage();
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const store = [root, mine, answer, post(peerKey, "quiet", T + 3)];
  const first = await launch({ store, storage: saving });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  expect(await saved(saving)).toContain(answer.id);
  expect(await saving.read()).toMatchObject({
    complete: true,
    mark: { checked: SECONDS },
  });
  // Storage changed one event's content after it was signed.
  const storage: UnreadStorage = {
    ...saving,
    async read() {
      const record = await saving.read();
      return (
        record && {
          ...record,
          events: record.events.map((event) =>
            (event as RelayEvent).id === answer.id
              ? { ...(event as RelayEvent), content: "tampered" }
              : event,
          ),
        }
      );
    },
  };
  const offline = await launch({ store, storage, down: true });
  await offline.owner.capability.ensure();
  // Nothing is restored, not even the events that verify. A record of at
  // most eight events is verified in one batch, within the launch's storage
  // read, so the repair that just ended is past it.
  expect(offline.rows()).toEqual([]);
  expect(offline.count("quiet")).toBeNull();
  offline.owner.dispose();
  const online = await launch({ store, storage });
  await online.owner.capability.ensure();
  // Its mark no longer vouches for what the session holds: the launch reads
  // the bootstrap, not the delta.
  expect(deltas(online)).toEqual([]);
  expect(online.reader.read.mock.calls.flat(2)).toContainEqual(
    expect.objectContaining({ "#h": ["team"], "#e": [root.id] }),
  );
  expect(online.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
});

/** A complete record a full repair of `store` saved, of more than eight
 * events, and storage that changed the one restore verifies after its first
 * yield: a relaunch routes to the delta, then discards the record. */
async function tamperedLate(
  store: readonly RelayEvent[],
  frontiers: Readonly<Record<string, number>> = {},
) {
  const saving = memoryUnreadStorage();
  const first = await launch({ store, storage: saving, frontiers });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  const record = await saving.read();
  expect(record?.complete).toBe(true);
  const tampered = (record?.events.at(-1) as RelayEvent | undefined)?.id;
  expect(record?.events.length).toBeGreaterThan(8);
  const storage: UnreadStorage = {
    ...saving,
    async read() {
      const read = await saving.read();
      return (
        read && {
          ...read,
          events: read.events.map((event) =>
            (event as RelayEvent).id === tampered
              ? { ...(event as RelayEvent), content: "tampered" }
              : event,
          ),
        }
      );
    },
  };
  return storage;
}
/** A team thread with the viewer's reply and an unread answer, a read
 * channel's unread message older than the delta reaches, and 9 unread DMs. */
function discardable() {
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const unread = post(peerKey, "quiet", T - 5000);
  const direct = Array.from({ length: 9 }, (_, i) =>
    post(peerKey, "dm", T + 10 + i),
  );
  return {
    root,
    direct,
    store: [root, mine, answer, unread, ...direct],
    frontiers: { quiet: T - 10_000 },
  };
}

it("restored evidence discarded after the pass routed to the delta has the bootstrap read in the same pass", async () => {
  const { root, direct, store } = discardable();
  const storage = await tamperedLate(store);
  const release = holdRestore();
  const h = await launch({ store, storage });
  let launched: Promise<void> | undefined;
  try {
    launched = h.owner.capability.ensure();
    await vi.waitFor(() => expect(deltas(h)).not.toEqual([]));
  } finally {
    release();
  }
  await launched;
  const sent = h.reader.read.mock.calls.map(([filters]) => filters);
  expect(deltaRead(sent[0] ?? [])).toBe(true);
  expect(sent.flat()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ authors: [viewer] }),
      expect.objectContaining({ "#h": ["dm"], since: expect.any(Number) }),
      expect.objectContaining({ "#h": ROSTER, include_aux: true, limit: 500 }),
    ]),
  );
  expect(h.owner.capability.inbox().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
      expect.objectContaining({ channelId: "dm", unreadCount: direct.length }),
    ]),
  );
});

it("a channel the delta observed is not observed once restore discards the record and the bootstrap's reads of it drop, and the Inbox says so", async () => {
  const { direct, store, frontiers } = discardable();
  const storage = await tamperedLate(store, frontiers);
  const release = holdRestore();
  // The bootstrap's windows and its roster sample drop: no read but the
  // delta's observes `quiet` or `dm`.
  const h = await launch({
    store,
    storage,
    frontiers,
    fail: (filters) =>
      filters.some(
        (filter) => !deltaFilter(filter) && !!filter["#h"]?.includes("quiet"),
      ),
  });
  let launched: Promise<void> | undefined;
  try {
    launched = h.owner.capability.ensure();
    // The delta's page is in: `dm`'s messages, and nothing of `quiet`, read
    // to the end of a chunk that reaches past its read mark.
    await vi.waitFor(() =>
      expect(h.owner.event(direct[0]?.id ?? "")).toBeDefined(),
    );
  } finally {
    release();
  }
  await launched;
  for (const channelId of ["quiet", "dm"])
    expect(
      h.owner.capability.snapshot({ kind: "channel", channelId }),
    ).toMatchObject({ coverage: "unknown" });
  expect(h.owner.capability.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
    partial: true,
  });
});

it("restored evidence discarded after the delta's first page keeps the Inbox loading until the bootstrap's first reads land", async () => {
  const { root, direct, store } = discardable();
  const storage = await tamperedLate(store);
  const release = holdRestore();
  const h = await launch({ store, storage });
  // Whether the Inbox loaded while the bootstrap still read, or only once the
  // pass ended.
  let loadedWhile: string | undefined;
  h.owner.capability.subscribeInbox(() => {
    const { status, freshness } = h.owner.capability.inbox();
    if (status === "ready") loadedWhile ??= freshness;
  });
  let launched: Promise<void> | undefined;
  let network: ReturnType<typeof h.hold> | undefined;
  try {
    launched = h.owner.capability.ensure();
    await vi.waitFor(() =>
      expect(h.owner.event(direct[0]?.id ?? "")).toBeDefined(),
    );
    // The bootstrap's reads are held from here on.
    network = h.hold();
    release();
    expect(await network.waiting).toContainEqual(
      expect.objectContaining({ authors: [viewer] }),
    );
    expect(h.owner.capability.inbox().status).toBe("loading");
  } finally {
    release();
    network?.release();
  }
  await launched;
  expect(loadedWhile).toBe("observing");
  expect(h.owner.capability.inbox()).toMatchObject({
    status: "ready",
    items: expect.arrayContaining([
      expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
    ]),
  });
});

it("a selection over the record's bounds, or one retention dropped, saves an incomplete record", async () => {
  // Unread messages larger together than the record's byte bound.
  const large = (key: Key, channelId: string, at: number) =>
    post(key, channelId, at, [], "x".repeat(UNREAD_RECORD_BYTES / 4));
  const over = memoryUnreadStorage();
  const many = Array.from({ length: 5 }, (_, i) =>
    large(peerKey, "quiet", T + i),
  );
  const first = await launch({ store: many, storage: over });
  await first.owner.capability.ensure();
  expect(first.count("quiet")).toBe(5);
  await first.saved;
  expect(await over.read()).toMatchObject({ events: [], complete: false });
  // The viewer's message, which the authored page returns, is refused room:
  // traffic that arrived during the repair filled the byte budget with newer
  // evidence of its channel. The page selects it, so the record is not
  // complete without it.
  const dropped = memoryUnreadStorage();
  const authored = large(viewerKey, "archive", T - 700_000);
  const later = Array.from({ length: 9 }, (_, i) =>
    large(peerKey, "archive", T - 690_000 + i),
  );
  const second = await launch({
    store: [authored, ...busy],
    storage: dropped,
    frontiers: {
      ...BUSY_READ,
      ...Object.fromEntries(
        later.map((event) => [`msg:${event.id}`, event.created_at]),
      ),
    },
    roster: ["archive", "busy"].map((id) => ({
      id,
      name: id,
      members: [viewer],
    })),
  });
  const { release, waiting } = second.hold();
  const repair = second.owner.capability.ensure();
  try {
    expect(await waiting).toContainEqual(
      expect.objectContaining({ authors: [viewer] }),
    );
    second.owner.accept(later);
  } finally {
    release();
  }
  await repair;
  expect(second.owner.event(authored.id)).toBeUndefined();
  await second.saved;
  expect((await dropped.read())?.events).toHaveLength(busy.length);
  expect((await dropped.read())?.complete).toBe(false);
});

it("restored evidence the relay no longer returns, deleted while this device was closed, is dropped", async () => {
  const storage = memoryUnreadStorage();
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answers = Array.from({ length: 10 }, (_, i) =>
    reply(peerKey, "team", root, T + 2 + i),
  );
  const [gone, alsoGone] = answers as [RelayEvent, RelayEvent];
  const store = [root, mine, ...answers];
  const first = await launch({ store, storage });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  expect(await saved(storage)).toEqual(
    expect.arrayContaining([gone.id, alsoGone.id]),
  );
  const thread = (owner: Awaited<ReturnType<typeof launch>>) =>
    owner.owner.capability.inbox().items.find((item) => item.rootId === root.id)
      ?.messageIds;
  // Reads that land while the evidence is still being verified.
  store.push(deletion(peerKey, "team", gone));
  const early = await launch({ store, storage });
  await early.owner.capability.ensure();
  await early.saved;
  expect(thread(early)).toContain(answers.at(-1)?.id);
  expect(thread(early)).not.toContain(gone.id);
  expect(await saved(storage)).not.toContain(gone.id);
  early.owner.dispose();
  // Reads that land once it is in.
  store.push(deletion(peerKey, "team", alsoGone));
  const count = (await saved(storage)).length;
  const late = await launch({ store, storage });
  const { release } = late.hold();
  const repair = late.owner.capability.ensure();
  try {
    await late.restored(count);
    expect(thread(late)).toContain(alsoGone.id);
  } finally {
    release();
  }
  await repair;
  expect(thread(late)).not.toContain(alsoGone.id);
  expect(thread(late)).toContain(answers.at(-1)?.id);
});

it("restored evidence whose read of deletions is dropped stays, owed to the next pass", async () => {
  const held = post(peerKey, "team", T);
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: { roots: new Map() },
    events: [held],
    structure: new Set(),
    complete: true,
    // Too old for a delta: the pass is the bootstrap.
    mark: { at: T + 200, checked: SECONDS - 86_401 },
  });
  // Above it, more than the channel's window holds, so no window judges it.
  const newer = Array.from({ length: 101 }, (_, i) =>
    hashed("team", T + 1 + i),
  );
  const overlays = (h: Launch) =>
    h.reader.read.mock.calls.flatMap(([filters]) =>
      filters.filter((filter) => filter.kinds?.join() === "40003,5,9005"),
    );
  let stalling = true;
  const h = await launch({
    store: [held, ...newer],
    storage,
    frontiers: { team: T - 1 },
    // The roster sample fails throughout, so no pass confirms the mark.
    fail: (filters) =>
      sampleRead(filters) ||
      (stalling &&
        filters.some((filter) => filter.kinds?.join() === "40003,5,9005")),
  });
  await h.owner.capability.ensure();
  await h.saved;
  const read = {
    kinds: [40003, 5, 9005],
    "#h": ["team"],
    since: T + 200 - 1865,
    limit: 500,
  };
  // Read, retried, and dropped.
  expect(overlays(h)).toEqual([read, read]);
  expect(h.owner.event(held.id)).toBeDefined();
  expect(await saved(storage)).toContain(held.id);
  stalling = false;
  await h.reconnected();
  expect(overlays(h)).toEqual([read, read, read]);
  expect(h.owner.event(held.id)).toBeDefined();
});

it("restored evidence of a channel whose membership is not confirmed yet waits for it, and is saved meanwhile", async () => {
  const storage = memoryUnreadStorage();
  const direct = post(peerKey, "dm", T);
  const store = [direct, post(peerKey, "team", T + 1)];
  const channels = (cached: boolean) => [
    { id: "team", name: "team", members: [viewer] },
    {
      id: "dm",
      name: "dm",
      members: [viewer],
      channelType: "dm" as const,
      ...(cached ? { cached: true as const } : {}),
    },
  ];
  const first = await launch({ store, storage, roster: channels(false) });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  expect(await saved(storage)).toContain(direct.id);
  // The roster starts from the downloaded membership; the repair reads, and
  // saves, the confirmed channel alone.
  const next = await launch({
    store: store.slice(1),
    storage,
    roster: channels(true),
  });
  await next.owner.capability.ensure();
  await next.saved;
  expect(await saved(storage)).toContain(direct.id);
  next.roster(channels(false));
  expect(next.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ channelId: "dm", messageIds: [direct.id] }),
  );
});

it("a save that is refused is written again, and one carrying only threads keeps the evidence", async () => {
  const memory = memoryUnreadStorage();
  let refuse = true;
  const storage: UnreadStorage = {
    ...memory,
    async save(record) {
      if (refuse) {
        refuse = false;
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return memory.save(record);
    },
  };
  const save = vi.spyOn(storage, "save");
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const h = await launch({ store: [root, mine, answer], storage });
  await h.owner.capability.ensure();
  expect(save).toHaveBeenCalledTimes(1);
  await expect(memory.read()).resolves.toBeUndefined();
  // The same record again: the refused one did not land.
  await h.owner.capability.refresh();
  expect(save).toHaveBeenCalledTimes(2);
  expect(await saved(memory)).toContain(answer.id);
  // Marking the thread unread moves its mark back to the root and saves
  // the threads; the evidence stays.
  await h.owner.capability.markUnreadLocal({
    kind: "thread",
    channelId: "team",
    rootId: root.id,
  });
  expect(save).toHaveBeenCalledTimes(3);
  await save.mock.results[2]?.value;
  expect(
    (await memory.read())?.participation.roots.get(`team:${root.id}`),
  ).toMatchObject({ at: root.created_at });
  expect(await saved(memory)).toEqual(
    expect.arrayContaining([root.id, mine.id, answer.id]),
  );
});

it("a warm launch reads only the delta, shows the restored rows before the relay answers, and loads and observes channels once restore and the delta's first page are in", async () => {
  const storage = memoryUnreadStorage();
  // The lost thread: the viewer replied long ago, and only the thread reads
  // reach it. Beside it, more unread DMs than restore verifies at once.
  const lost = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", lost, T + 1);
  const answer = reply(peerKey, "team", lost, T + 2);
  const direct = Array.from({ length: 9 }, (_, i) =>
    post(peerKey, "dm", T + 10 + i),
  );
  // A read channel's unread message, older than the delta reaches.
  const unread = post(peerKey, "quiet", T - 5000);
  const frontiers = { quiet: T - 10_000 };
  const store = [lost, mine, answer, unread, ...direct];
  const first = await launch({ store, storage, frontiers });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  const record = await storage.read();
  assert(record?.mark);
  expect(record.complete).toBe(true);
  const count = record.events.length;
  expect(count).toBeGreaterThan(8);
  const delta = {
    kinds: DELTA_KINDS,
    "#h": ROSTER,
    since: record.mark.at - 1865,
    limit: 500,
  };
  const rows = [
    expect.objectContaining({ rootId: lost.id, unreadCount: 1 }),
    expect.objectContaining({ channelId: "dm", unreadCount: 9 }),
  ];
  // The relay holds its answer: restore alone shows the rows.
  const held = await launch({ store, storage, frontiers });
  const network = held.hold();
  try {
    const launched = held.owner.capability.ensure();
    expect(await network.waiting).toEqual([delta]);
    await held.restored(count);
    expect(held.owner.capability.inbox()).toMatchObject({
      status: "loading",
      items: expect.arrayContaining(rows),
    });
    network.release();
    await launched;
  } finally {
    network.release();
  }
  held.owner.dispose();
  // Restore is held instead: the delta's page lands, with a reply sent
  // while this device was closed, and the Inbox still waits for restore.
  const later = reply(peerKey, "team", lost, T + 30);
  store.push(later);
  const release = holdRestore();
  const slow = await launch({ store, storage, frontiers });
  try {
    const launched = slow.owner.capability.ensure();
    await vi.waitFor(() => expect(slow.owner.event(later.id)).toBeDefined());
    expect(slow.verified()).toBeLessThan(count);
    expect(slow.owner.capability.inbox().status).toBe("loading");
    // A channel the delta read to its end counts the record too: it is not
    // observed, with nothing unread, while the record's unread is not in.
    expect(
      slow.owner.capability.snapshot({ kind: "channel", channelId: "quiet" }),
    ).toMatchObject({ coverage: "unknown" });
    release();
    await slow.restored(count);
    await launched;
  } finally {
    release();
  }
  expect(slow.owner.capability.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
    items: expect.arrayContaining([
      expect.objectContaining({ rootId: lost.id, unreadCount: 2 }),
      rows[1],
    ]),
  });
  expect(slow.count("quiet")).toBe(1);
  expect(slow.reader.read.mock.calls).toEqual([[[delta], expect.anything()]]);
  await slow.saved;
  expect(await storage.read()).toMatchObject({
    complete: true,
    mark: { at: later.created_at, checked: SECONDS },
  });
});

it("a delta-only pass advances the walk mark and the thread marks to the viewer's newest reply it read, with no authored page or thread read", async () => {
  const storage = memoryUnreadStorage();
  // A thread the viewer replied in, with no unread reply holding its mark.
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const store = [root, mine];
  const first = await launch({ store, storage });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  const key = `team:${root.id}`;
  expect(await storage.read()).toMatchObject({
    complete: true,
    whole: new Set([key]),
    participation: { walk: { since: mine.created_at } },
  });
  // The viewer replied again on another device while this one was closed.
  const again = reply(viewerKey, "team", root, T + 40);
  store.push(again);
  const warm = await launch({ store, storage });
  await warm.owner.capability.ensure();
  await warm.saved;
  expect(warm.reader.read.mock.calls.map(([filters]) => filters)).toEqual([
    [expect.objectContaining({ kinds: DELTA_KINDS })],
  ]);
  const record = await storage.read();
  expect(record?.participation.walk).toEqual({ since: again.created_at });
  expect(record?.participation.roots.get(key)?.at).toBe(again.created_at);
  expect(record?.complete).toBe(true);
});

it("a delta-only pass fetches by ID the root of a remembered thread it brought a reply to, which stays structure and groups the reply", async () => {
  // The viewer's reply is held without its root: it is read only by ID.
  const root = post(peerKey, "quiet", T);
  const mine = reply(viewerKey, "quiet", root, T + 1);
  const key = `quiet:${root.id}`;
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: { roots: new Map([[key, { at: T + 1 }]]) },
    events: [mine],
    structure: new Set(),
    complete: true,
    mark: { at: SECONDS - 600, checked: SECONDS - 60 },
    roster: new Set(ROSTER),
    whole: new Set([key]),
  });
  const answer = reply(peerKey, "quiet", root, SECONDS - 300);
  const h = await launch({ store: [root, mine, answer], storage });
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  expect(launched).toEqual([
    expect.objectContaining({ kinds: DELTA_KINDS }),
    expect.objectContaining({ ids: [root.id] }),
  ]);
  await h.saved;
  expect(h.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  // Structure: the reply alone counts.
  expect(h.count("quiet")).toBe(1);
  expect(await storage.read()).toMatchObject({
    complete: true,
    structure: new Set([root.id]),
  });
});

it("a full window's cut is its own limit-th match, and a deletion made while closed reaches the restored evidence below it", async () => {
  const storage = memoryUnreadStorage();
  // The viewer's newest message, at the channel's read mark: the authored
  // page returns it, and the channel's window matches it too. Above it are
  // more unread messages than the window holds.
  const mine = post(viewerKey, "team", T);
  const unread = Array.from({ length: 130 }, (_, i) =>
    post(peerKey, "team", T + 1 + i),
  );
  const store = [mine, ...unread];
  const frontiers = { ...BUSY_READ, team: T };
  const first = await launch({ store, storage, frontiers });
  await first.owner.capability.ensure();
  expect(first.count("team")).toBe(130);
  await first.saved;
  first.owner.dispose();
  const record = await storage.read();
  assert(record?.mark);
  expect(await saved(storage)).toEqual(
    expect.arrayContaining(unread.map(({ id }) => id)),
  );
  // While the device was closed, busier traffic moved the roster sample on,
  // and the oldest unread message was deleted.
  const [oldest] = unread as [RelayEvent];
  const removal = deletion(peerKey, "team", oldest);
  store.push(...busy, removal);
  const since = record.mark.at - 1865;
  const stale = { ...record.mark, checked: NOW / 1000 - 86_401 };
  const relaunch = async (
    mark: { at: number; checked: number },
    extra: readonly RelayEvent[] = [],
  ) => {
    const memory = memoryUnreadStorage();
    await memory.save({ ...record, mark } as typeof record & {
      events: RelayEvent[];
    });
    let warm: Awaited<ReturnType<typeof launch>> | undefined;
    const restoring: boolean[] = [];
    const inbox: string[] = [];
    warm = await launch({
      store: [...store, ...extra],
      storage: memory,
      frontiers,
      fail(filters) {
        if (deltaRead(filters)) {
          restoring.push((warm?.verified() ?? 0) < record.events.length);
          inbox.push(warm?.owner.capability.inbox().status ?? "");
        }
        return false;
      },
    });
    await warm.owner.capability.ensure();
    await warm.saved;
    return { warm, memory, restoring, inbox };
  };
  // A mark confirmed within the day: the delta since it, read first and
  // with no bootstrap, returns the deletion while restore is still
  // verifying the evidence it deletes, and the Inbox waits for both.
  const fresh = await relaunch(record.mark);
  const read = fresh.warm.reader.read.mock.calls.map(([filters]) => filters);
  expect(read[0]).toEqual([
    {
      kinds: DELTA_KINDS,
      "#h": ["team", "quiet", "dm", "busy"],
      since,
      limit: 500,
    },
  ]);
  expect(read.filter((filters) => !deltaRead(filters))).toEqual([]);
  expect(fresh.inbox).toEqual(["loading", "loading"]);
  expect(fresh.restoring).toEqual([true, true]);
  expect(fresh.warm.count("team")).toBe(129);
  expect(await saved(fresh.memory)).not.toContain(oldest.id);
  expect(await saved(fresh.memory)).not.toContain(removal.id);
  fresh.warm.owner.dispose();
  // One confirmed longer ago: the bootstrap's reads alone. The window
  // returns the newest 100 beside the authored page's older match, so the
  // 30 below its cut are not judged; the read of edits and deletions since
  // the mark in every channel holding evidence, which the roster sample
  // needs to confirm it again, returns this one.
  const late = await relaunch(stale);
  const calls = late.warm.reader.read.mock.calls.map(([filters]) => filters);
  expect(calls.filter(deltaRead)).toEqual([]);
  expect(calls[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ authors: [viewer] }),
      expect.objectContaining({ "#h": ["team"], since: T, limit: 100 }),
    ]),
  );
  expect(calls).toContainEqual([
    { kinds: [40003, 5, 9005], "#h": ["team", "busy"], since, limit: 500 },
  ]);
  expect(late.warm.count("team")).toBe(129);
  expect(await saved(late.memory)).toEqual(
    expect.arrayContaining(unread.slice(1).map(({ id }) => id)),
  );
  expect(await saved(late.memory)).not.toContain(oldest.id);
  expect(await saved(late.memory)).not.toContain(removal.id);
  late.warm.owner.dispose();
  // More edits and deletions since the mark than that read reads: those of
  // the restored evidence no read of the pass returned are read by ID, which
  // returns this deletion, the rest stays, and the roster sample moves the
  // mark, so the restored evidence owes no second read.
  const edits = Array.from({ length: 1001 }, (_, i) =>
    hashed("team", T + 200 + i, 40003, [["e", "f".repeat(64)]]),
  );
  const overflow = await relaunch(stale, edits);
  const overlays = overflow.warm.reader.read.mock.calls.filter(([filters]) =>
    filters.some((filter) => filter.kinds?.join() === "40003,5,9005"),
  );
  expect(overlays).toHaveLength(3);
  expect(new Set(overlays[2]?.[0][0]?.["#e"])).toEqual(
    new Set(unread.slice(0, 30).map(({ id }) => id)),
  );
  expect((await overflow.memory.read())?.mark).toEqual({
    at: T + 50_499,
    checked: SECONDS,
  });
  expect(overflow.warm.count("team")).toBe(129);
  expect(await saved(overflow.memory)).toEqual(
    expect.arrayContaining(unread.slice(1).map(({ id }) => id)),
  );
  expect(await saved(overflow.memory)).not.toContain(oldest.id);
});

it("a root a lookup fetched stays structure on every relaunch: it groups the mention and never counts", async () => {
  const storage = memoryUnreadStorage();
  // Older than the window's week, in a channel the viewer never opened:
  // only the structure lookup of a read mention that arrived live fetches it.
  const old = post(peerKey, "team", T - 600_000);
  const mention = reply(peerKey, "team", old, T + 10, [["p", viewer]]);
  const store = [old, ...busy];
  const frontiers = { ...BUSY_READ, [`msg:${mention.id}`]: T + 10 };
  const row = expect.objectContaining({ rootId: old.id, unreadCount: 0 });
  const first = await launch({ store, storage, frontiers });
  await first.owner.capability.ensure();
  await first.saved;
  store.push(mention);
  first.owner.accept([mention]);
  await first.inboxed((item) => item.rootId === old.id);
  const save = vi.spyOn(storage, "save");
  await first.owner.capability.refresh();
  expect(save).toHaveBeenCalled();
  await save.mock.results.at(-1)?.value;
  expect(first.owner.capability.inbox().items).toContainEqual(row);
  expect(first.count("team")).toBe(0);
  expect(first.owner.event(old.id)).toBeUndefined();
  const record = await storage.read();
  assert(record);
  expect(record.structure).toEqual(new Set([old.id]));
  expect(await saved(storage)).toEqual(
    expect.arrayContaining([old.id, mention.id]),
  );
  first.owner.dispose();
  // Online, the mention taught the pass its thread, whose read fetches the
  // root by ID: from the saved record, and from one holding only threads.
  for (const restored of [
    record,
    { ...record, events: [], structure: new Set<string>(), complete: false },
  ]) {
    const memory = memoryUnreadStorage();
    await memory.save(restored as typeof record & { events: RelayEvent[] });
    const online = await launch({ store, storage: memory, frontiers });
    await online.owner.capability.ensure();
    await online.saved;
    expect(online.owner.capability.inbox().items).toContainEqual(row);
    expect(online.count("team")).toBe(0);
    expect(online.owner.event(old.id)).toBeUndefined();
    online.owner.dispose();
  }
  // Offline, restore puts the root back before it admits the mention, so no
  // published Inbox shows the mention outside its thread.
  const offline = await launch({ store, storage, frontiers, down: true });
  const ungrouped: unknown[] = [];
  offline.owner.capability.subscribeInbox(() => {
    const items = offline.owner.capability.inbox().items;
    if (
      offline.owner.event(mention.id) &&
      !items.some((item) => item.rootId === old.id)
    )
      ungrouped.push(items);
  });
  await offline.owner.capability.ensure();
  await offline.restored(record.events.length);
  expect(ungrouped).toEqual([]);
  expect(offline.owner.capability.inbox().items).toContainEqual(row);
  expect(offline.count("team")).toBe(0);
  expect(offline.owner.event(old.id)).toBeUndefined();
});

it("the viewer's root a thread read fetches is their membership of its thread, with no lookup", async () => {
  // The viewer started the thread long ago; its unread answer is below the
  // channel's catch-up mark and older than the roster sample, so only the
  // remembered thread's read reaches either.
  const started = post(viewerKey, "team", T);
  const answer = reply(peerKey, "team", started, T + 1);
  const store = [started, answer, ...busy];
  const frontiers = { ...BUSY_READ, "activity:team": T + 95_000 };
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: {
      roots: new Map([[`team:${started.id}`, { at: answer.created_at }]]),
      walk: { since: T + 10 },
    },
    events: [],
    structure: new Set(),
    complete: false,
  });
  const lookups = (h: Awaited<ReturnType<typeof launch>>) =>
    h.reader.read.mock.calls.flatMap(([filters]) =>
      filters.filter((filter) => filter.authors && filter["#e"]),
    );
  const online = await launch({ store, storage, frontiers });
  await online.owner.capability.ensure();
  await online.saved;
  // Fetched by the thread read, the root is structure, so the row targets
  // its newest message, as a lookup-fetched root's row does.
  expect(online.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({
      rootId: started.id,
      unreadCount: 1,
      target: { kind: "message", channelId: "team", messageId: answer.id },
    }),
  );
  expect(online.count("team")).toBe(1);
  expect(lookups(online)).toEqual([]);
  online.owner.dispose();
  // Saved as the thread's witness, the root keeps the row offline.
  const count = (await saved(storage)).length;
  expect(await saved(storage)).toEqual(
    expect.arrayContaining([started.id, answer.id]),
  );
  const offline = await launch({ store, storage, frontiers, down: true });
  await offline.owner.capability.ensure();
  await offline.restored(count);
  // Restored as the witness, the root is evidence: the row targets the
  // thread.
  expect(offline.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({
      rootId: started.id,
      unreadCount: 1,
      target: { kind: "thread", channelId: "team", rootId: started.id },
    }),
  );
  expect(offline.count("team")).toBe(1);
  expect(lookups(offline)).toEqual([]);
});

/** Fifty threads the viewer wrote in recently, read whole on every repair,
 * and an older one read since its mark: its unread answer is below the
 * channel's catch-up mark and older than the roster sample, so only that
 * cold read reaches it, and the answer's landing fetches its root by ID. */
function rememberedThreads() {
  const hot = Array.from({ length: 50 }, (_, i) => {
    const root = post(peerKey, "team", T + 100 + 10 * i);
    return [root, reply(viewerKey, "team", root, T + 101 + 10 * i)] as const;
  });
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const marks = [...hot.map(([, theirs]) => theirs), mine].map(
    (event): [string, { at: number; newestId: string }] => [
      `team:${event.tags.find(([name]) => name === "e")?.[1]}`,
      { at: event.created_at, newestId: event.id },
    ],
  );
  return {
    root,
    answer,
    store: [...hot.flat(), root, mine, answer],
    frontiers: { ...BUSY_READ, "activity:team": T + 95_000 },
    record: {
      participation: { roots: new Map(marks), walk: { since: T + 10_000 } },
      events: [],
      structure: new Set<string>(),
      complete: false,
    },
  };
}

it("a remembered thread's root outlasts 1,024 other structure fetches, and a root let go is fetched again for a thread it teaches", async () => {
  const thread = rememberedThreads();
  // Remembered threads besides, whose roots are gone: the cache holds no
  // root of theirs, so it keeps no room for one.
  const gone = Array.from(
    { length: 100 },
    (_, i): [string, { at: number; newestId: string }] => [
      `team:${(i + 1).toString(16).padStart(64, "a")}`,
      { at: T - 100 + i, newestId: (i + 1).toString(16).padStart(64, "b") },
    ],
  );
  const storage = memoryUnreadStorage();
  await storage.save({
    ...thread.record,
    participation: {
      ...thread.record.participation,
      roots: new Map([...thread.record.participation.roots, ...gone]),
    },
  });
  // Read replies also sent to the channel, in threads the viewer is not
  // part of, each looked up for its root and none kept by a save: `first`,
  // then as many as the structure cache holds besides. Unsigned, as only a
  // restore verifies and none of them is restored.
  const unsigned = (created_at: number, tags: string[][] = []): RelayEvent => {
    const template = {
      kind: 9,
      pubkey: peerKey.pubkey,
      created_at,
      content: `quiet ${created_at}`,
      tags: [["h", "quiet"], ...tags],
    };
    return {
      ...template,
      id: getEventHash(template),
      sig: "0".repeat(128),
      [verifiedSymbol]: true,
    };
  };
  const first = unsigned(T - 600_000);
  const roots = Array.from({ length: 1024 }, (_, i) =>
    unsigned(T - 500_000 + i),
  );
  const replies = [first, ...roots].map((root, i) =>
    unsigned(T + 1000 + i, [
      ["e", root.id, "", "reply"],
      ["broadcast", "1"],
    ]),
  );
  // A read mention in a later channel: its lookup goes behind a batch's, so
  // its row grouping under its root says the batch has landed.
  let barriers = 0;
  const barrier = () => {
    const root = post(peerKey, "busy", T - 400_000 + barriers++);
    return {
      root,
      mention: reply(peerKey, "busy", root, T + 5000, [["p", viewer]]),
    };
  };
  const batches = [barrier(), barrier(), barrier()];
  const store = [
    ...thread.store,
    first,
    ...roots,
    ...batches.map(({ root }) => root),
    ...busy,
  ];
  const h = await launch({
    store,
    storage,
    frontiers: { ...thread.frontiers, quiet: T + 10_000 },
  });
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await h.saved;
  // The membership lookup finds the viewer's reply the cold read passed
  // over, and the thread is a row.
  await h.inboxed(
    (item) => item.rootId === thread.root.id && item.unreadCount === 1,
  );
  const grouped = expect.objectContaining({
    rootId: thread.root.id,
    unreadCount: 1,
  });
  const ungrouped: unknown[] = [];
  h.owner.capability.subscribeInbox(() => {
    const items = h.owner.capability.inbox().items;
    if (
      items.some(
        (item) =>
          item.messageIds.includes(thread.answer.id) &&
          item.rootId !== thread.root.id,
      )
    )
      ungrouped.push(items);
  });
  const asked = (id: string) =>
    h.reader.read.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.ids?.includes(id)),
    ).length;
  const landed = async (
    batch: (typeof batches)[number],
    ...live: RelayEvent[]
  ) => {
    h.owner.accept([...live, batch.mention]);
    await h.inboxed((item) => item.rootId === batch.root.id);
  };
  const [one, two, three] = batches;
  assert(one && two && three);
  await landed(one, ...replies.slice(0, 1));
  await landed(two, ...replies.slice(1));
  // The remembered roots stayed and their replies grouped; `first`'s root,
  // the oldest of the others, was let go, and with the read replies' own
  // released lookups it is not fetched again.
  expect(ungrouped).toEqual([]);
  expect(h.owner.capability.inbox().items).toContainEqual(grouped);
  expect(asked(first.id)).toBe(1);
  expect(roots.map((root) => asked(root.id))).toEqual(roots.map(() => 1));
  // A mention in its thread teaches the thread, so its root is fetched
  // again and kept from then on.
  const mention = reply(peerKey, "quiet", first, T + 6000, [["p", viewer]]);
  await landed(three, mention);
  expect(asked(first.id)).toBe(2);
  expect(h.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: first.id, messageIds: [mention.id] }),
  );
  // The record, once every save has landed, holds the remembered thread's
  // root as structure.
  await h.owner.capability.refresh();
  await Promise.all(save.mock.results.map(({ value }) => value));
  const record = await storage.read();
  expect(record?.structure.has(thread.root.id)).toBe(true);
  expect(await saved(storage)).toEqual(
    expect.arrayContaining([thread.root.id, thread.answer.id]),
  );
  expect(record?.complete).toBe(true);
  expect(ungrouped).toEqual([]);
});

it("a remembered thread's reply saved without its root, whose fetch was dropped, leaves the record incomplete", async () => {
  const thread = rememberedThreads();
  const storage = memoryUnreadStorage();
  await storage.save(thread.record);
  const h = await launch({
    store: [...thread.store, ...busy],
    storage,
    frontiers: thread.frontiers,
    fail: (filters) =>
      filters.some((filter) => filter.ids?.includes(thread.root.id)),
  });
  await h.owner.capability.ensure();
  await h.saved;
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect(await saved(storage)).toContain(thread.answer.id);
  expect(await saved(storage)).not.toContain(thread.root.id);
  expect((await storage.read())?.complete).toBe(false);
});

it("a save in flight is not written again, and one refused by a purge ends the session's saves", async () => {
  const memory = memoryUnreadStorage();
  let release = () => {};
  const landing = new Promise<void>((resolve) => {
    release = resolve;
  });
  let purged = false;
  const storage: UnreadStorage = {
    ...memory,
    async save(record) {
      await landing;
      if (purged) throw new UnreadRecordPurged();
      return memory.save(record);
    },
  };
  const save = vi.spyOn(storage, "save");
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const h = await launch({ store: [root, mine, answer], storage });
  await h.owner.capability.ensure();
  expect(save).toHaveBeenCalledTimes(1);
  // The same record while the first save has not landed.
  await h.owner.capability.refresh();
  expect(save).toHaveBeenCalledTimes(1);
  release();
  await save.mock.results[0]?.value;
  expect(await saved(memory)).toContain(answer.id);
  // Another window left the community: this session's next save is refused,
  // and nothing it holds is saved again.
  purged = true;
  h.owner.accept([reply(peerKey, "team", root, T + 3)]);
  await h.owner.capability.refresh();
  expect(save).toHaveBeenCalledTimes(2);
  await expect(save.mock.results[1]?.value).rejects.toThrow(UnreadRecordPurged);
  h.owner.accept([reply(peerKey, "team", root, T + 4)]);
  await h.owner.capability.refresh();
  expect(save).toHaveBeenCalledTimes(2);
});

it("a cache clear wipes the saved record, including what the launch was still reading", async () => {
  const storage = memoryUnreadStorage();
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const store = [root, mine, answer];
  const first = await launch({ store, storage });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  expect(await saved(storage)).toContain(answer.id);
  // The clear lands while the launch's storage read is in flight.
  let release = () => {};
  const reading = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await launch({
    store,
    storage: {
      ...storage,
      async read() {
        const record = await storage.read();
        await reading;
        return record;
      },
    },
    down: true,
  });
  const repair = h.owner.capability.ensure();
  const wiped = h.owner.clear();
  release();
  await repair.catch(() => {});
  await wiped;
  expect(h.owner.capability.inbox().items).toEqual([]);
  expect(await storage.read()).toEqual({
    participation: { roots: new Map() },
    events: [],
    structure: new Set(),
    complete: false,
  });
});

it("an access change while the launch reads storage keeps the record it read", async () => {
  const storage = memoryUnreadStorage();
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const store = [root, mine, answer];
  const first = await launch({ store, storage });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  // The membership is confirmed while the launch's storage read is in flight.
  const team = (cached: boolean): ChannelSummary[] => [
    {
      id: "team",
      name: "team",
      members: [viewer],
      ...(cached ? { cached: true as const } : {}),
    },
  ];
  let release = () => {};
  const reading = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const read = vi.fn(async () => {
    started();
    const record = await storage.read();
    await reading;
    return record;
  });
  const h = await launch({
    store,
    storage: { ...storage, read },
    roster: team(true),
    down: true,
  });
  const repair = h.owner.capability.ensure();
  await begun;
  h.roster(team(false));
  release();
  await repair.catch(() => {});
  // A record of at most 8 events is admitted within the storage read.
  expect(h.owner.event(answer.id)).toBeDefined();
  expect(h.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  expect(read).toHaveBeenCalledTimes(1);
});

it("a cache clear settles once the record is wiped, and rejects when the wipe fails", async () => {
  const memory = memoryUnreadStorage();
  let refusal: Error | undefined;
  const storage: UnreadStorage = {
    ...memory,
    async save(record) {
      if (refusal) throw refusal;
      return memory.save(record);
    },
  };
  const root = post(peerKey, "team", T);
  const answer = reply(peerKey, "team", root, T + 1);
  const h = await launch({ store: [root, answer], storage });
  await h.owner.capability.ensure();
  await h.saved;
  expect(await saved(memory)).toContain(answer.id);
  await h.owner.clear();
  expect(await memory.read()).toMatchObject({ events: [], complete: false });
  refusal = new DOMException("Quota exceeded", "QuotaExceededError");
  await expect(h.owner.clear()).rejects.toThrow("Quota exceeded");
  // A purge has wiped it already.
  refusal = new UnreadRecordPurged();
  await expect(h.owner.clear()).resolves.toBeUndefined();
});

/** A record that holds no evidence, complete, with `mark` covering
 * `roster`. */
async function marked(
  mark: { at: number; checked: number },
  roster: readonly string[] = ROSTER,
) {
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: { roots: new Map() },
    events: [],
    structure: new Set(),
    complete: true,
    mark,
    roster: new Set(roster),
  });
  return storage;
}
const members = (ids: readonly string[]) =>
  ids.map((id): ChannelSummary => ({ id, name: id, members: [viewer] }));
const sampleFilter = (filter: ReadFilter) =>
  !!filter["#h"] && filter.since === undefined && !filter["#e"];
// The roster sample fails where a test isolates the mark a delta confirms
// from the one the bootstrap's sample confirms.
const sampleRead = (filters: readonly ReadFilter[]) =>
  filters.some(sampleFilter);
type Launch = Awaited<ReturnType<typeof launch>>;
const deltas = (h: Launch) =>
  h.reader.read.mock.calls.flatMap(([filters]) =>
    deltaRead(filters) ? filters : [],
  );
/** What each delta page returned, in the order they were asked for. */
const deltaPages = (h: Launch) =>
  Promise.all(
    h.reader.read.mock.calls.flatMap(([filters], index) =>
      deltaRead(filters) ? [h.reader.read.mock.results[index]?.value] : [],
    ),
  ) as Promise<RelayEvent[][]>;

it("the delta reads each 128 channels of the roster from the mark less 1,865 s, paging across a second's ties to a short page", async () => {
  const ids = Array.from({ length: 130 }, (_, i) => `c${i}`);
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 60 }, ids);
  // More events in one second than a page holds.
  const tied = Array.from({ length: 600 }, () => hashed("c0", at + 30));
  const h = await launch({ store: tied, storage, roster: members(ids) });
  await h.owner.capability.ensure();
  const page = (part: readonly string[]) => ({
    kinds: DELTA_KINDS,
    "#h": part,
    since: at - 1865,
    limit: 500,
  });
  const byId = [...tied].sort((a, b) => a.id.localeCompare(b.id));
  expect(deltas(h)).toEqual([
    page(ids.slice(0, 128)),
    page(ids.slice(128)),
    { ...page(ids.slice(0, 128)), until: at + 30, before_id: byId[499]?.id },
  ]);
  // Every event of the second, none twice.
  const read = (await deltaPages(h)).flat();
  expect(read).toHaveLength(600);
  expect(new Set(read.map(({ id }) => id))).toEqual(
    new Set(tied.map(({ id }) => id)),
  );
  await h.saved;
  expect((await storage.read())?.mark).toEqual({
    at: at + 30,
    checked: SECONDS,
  });
});

it("an event committed after a delta, dated 1,800 s before the mark it confirmed, is read by the next delta", async () => {
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 60 });
  const store = [hashed("team", at + 100)];
  const h = await launch({ store, storage, fail: sampleRead });
  await h.owner.capability.ensure();
  expect(deltas(h)).toEqual([expect.objectContaining({ since: at - 1865 })]);
  const late = hashed("quiet", at + 100 - 1800);
  store.push(late);
  await h.reconnected();
  expect(deltas(h).at(-1)).toEqual(
    expect.objectContaining({ since: at + 100 - 1865 }),
  );
  expect((await deltaPages(h)).at(-1)).toContainEqual(late);
  expect(h.owner.event(late.id)).toBeDefined();
});

it("a delta with a chunk that fails leaves the mark, so the next delta reads from it again", async () => {
  const ids = Array.from({ length: 130 }, (_, i) => `c${i}`);
  const at = SECONDS - 600;
  const checked = SECONDS - 60;
  const storage = await marked({ at, checked }, ids);
  const store = [hashed("c0", at + 10), hashed("c129", at + 20)];
  let failing = true;
  const h = await launch({
    store,
    storage,
    roster: members(ids),
    fail: (filters) =>
      failing &&
      deltaRead(filters) &&
      filters.some((filter) => filter["#h"]?.includes("c129")),
  });
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await h.saved;
  // The other chunk read to its end; the mark is the one read.
  expect(h.owner.event(store[0]?.id ?? "")).toBeDefined();
  expect((await storage.read())?.mark).toEqual({ at, checked });
  failing = false;
  await h.reconnected();
  await save.mock.results.at(-1)?.value;
  // The failing chunk was read and retried, then read once more from the
  // same mark, and nothing but the delta was read.
  expect(
    deltas(h)
      .filter((filter) => filter["#h"]?.includes("c129"))
      .map(({ since }) => since),
  ).toEqual([at - 1865, at - 1865, at - 1865]);
  expect(
    h.reader.read.mock.calls.every(([filters]) => deltaRead(filters)),
  ).toBe(true);
  expect((await storage.read())?.mark).toEqual({
    at: at + 20,
    checked: SECONDS,
  });
});

it("a delta page is the relay's whole response, so a reaction's removal naming no channel fills it, and restored evidence below its cut stays", async () => {
  const at = SECONDS - 600;
  const since = at - 1865;
  const held = post(peerKey, "team", since + 50);
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: { roots: new Map() },
    events: [held],
    structure: new Set(),
    complete: true,
    mark: { at, checked: SECONDS - 60 },
  });
  // Above it, a page of messages less one, and a reaction taken off as
  // buzz-mcp's `react` does: a deletion that tags the reaction alone, which
  // the relay files under the reaction's channel.
  const newer = Array.from({ length: 499 }, (_, i) =>
    hashed("team", since + 100 + i),
  );
  const reaction = hashed("team", since + 700, 7, [["e", held.id]]);
  const template = {
    kind: 5,
    pubkey: peerKey.pubkey,
    created_at: since + 800,
    content: "",
    tags: [["e", reaction.id]],
  };
  const off: RelayEvent = {
    ...template,
    id: getEventHash(template),
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
  const h = await launch({
    store: [held, ...newer, reaction, off],
    storage,
    frontiers: { team: held.created_at - 1 },
    // The page below fails, as does the roster sample, so only the delta
    // could move the mark.
    fail: (filters) =>
      sampleRead(filters) ||
      (deltaRead(filters) && filters.some((filter) => filter.until)),
  });
  await h.owner.capability.ensure();
  await h.saved;
  // The first page was full, so it is read on from its oldest.
  const [oldest] = newer;
  assert(oldest);
  expect(deltas(h)).toContainEqual({
    kinds: DELTA_KINDS,
    "#h": ["team", "quiet", "dm", "busy"],
    since,
    limit: 500,
    until: oldest.created_at,
    before_id: oldest.id,
  });
  // That page dropped, so the mark stays, and the restored message below
  // the first page's cut is not judged gone.
  expect((await storage.read())?.mark).toEqual({
    at,
    checked: SECONDS - 60,
  });
  expect(h.owner.event(held.id)).toBeDefined();
  expect(await saved(storage)).toContain(held.id);
});

it("an event dated 900 s ahead raises the mark, and the next delta still reads a send the relay committed late before it", async () => {
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 60 });
  // The relay accepts sends dated up to 900 s ahead of its clock.
  const store = [hashed("team", SECONDS + 900)];
  const h = await launch({ store, storage, fail: sampleRead });
  await h.owner.capability.ensure();
  // Committed after that read, as late as the relay's commit floor allows:
  // 960 s, and its 5 s margin, before the read.
  const late = hashed("quiet", SECONDS - 965);
  store.push(late);
  await h.reconnected();
  expect(deltas(h).at(-1)).toEqual(
    expect.objectContaining({ since: SECONDS - 965 }),
  );
  expect(h.owner.event(late.id)).toBeDefined();
});

it("a delta that reads nothing newer keeps the mark's time and confirms it now", async () => {
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 3600 });
  const h = await launch({
    store: [hashed("team", at)],
    storage,
    fail: sampleRead,
  });
  await h.owner.capability.ensure();
  await h.saved;
  expect((await storage.read())?.mark).toEqual({ at, checked: SECONDS });
});

it("a chunk still full at six delta pages leaves the pass to the bootstrap, whose sample sets the mark the next delta reads to its end from", async () => {
  const at = SECONDS - 4000;
  const storage = await marked({ at, checked: SECONDS - 60 });
  // One event a second from the delta's start: more than six pages.
  const store = Array.from({ length: 3001 }, (_, i) =>
    hashed("team", at - 1865 + i),
  );
  const newest = at - 1865 + 3000;
  // Read, so the record holds only what the next repair's reads select.
  const h = await launch({ store, storage, frontiers: { team: SECONDS } });
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  expect((await deltaPages(h)).map((page) => page.length)).toEqual([
    500, 500, 500, 500, 500, 500,
  ]);
  // The delta's pages carried the edits and deletions they reached: the
  // read of them the sample needs starts where the pages stopped.
  expect(
    h.reader.read.mock.calls.flatMap(([filters]) =>
      filters.filter((filter) => filter.kinds?.join() === "40003,5,9005"),
    ),
  ).toEqual([
    {
      kinds: [40003, 5, 9005],
      "#h": ["team"],
      since: at - 1865,
      limit: 500,
      until: at - 1864,
      before_id: store[1]?.id,
    },
  ]);
  await h.saved;
  expect((await storage.read())?.mark).toEqual({
    at: newest,
    checked: SECONDS,
  });
  await h.reconnected();
  await save.mock.results.at(-1)?.value;
  expect(deltas(h)[6]).toEqual(
    expect.objectContaining({ since: newest - 1865 }),
  );
  expect((await deltaPages(h)).slice(6).map((page) => page.length)).toEqual([
    500, 500, 500, 366,
  ]);
});

it("a mark confirmed more than a day ago sends no delta, and one confirmed within it is read from however old it is", async () => {
  const stale = await marked({
    at: SECONDS - 600,
    checked: SECONDS - 86_401,
  });
  const store = [hashed("team", SECONDS - 600)];
  const h = await launch({ store, storage: stale });
  await h.owner.capability.ensure();
  expect(h.reader.read.mock.calls.length).toBeGreaterThan(0);
  expect(deltas(h)).toEqual([]);
  h.owner.dispose();
  // A quiet roster: its newest event is days old, but a read confirmed it
  // a minute ago.
  const days = SECONDS - 3 * 86_400;
  const quiet = await marked({ at: days, checked: SECONDS - 60 });
  const q = await launch({ store: [hashed("team", days)], storage: quiet });
  await q.owner.capability.ensure();
  expect(deltas(q)).toEqual([expect.objectContaining({ since: days - 1865 })]);
});

it("live events do not move the mark", async () => {
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 60 });
  const h = await launch({
    store: [hashed("team", at + 10)],
    storage,
    fail: sampleRead,
  });
  await h.owner.capability.ensure();
  h.owner.accept([hashed("team", at + 500)]);
  await h.reconnected();
  expect(deltas(h).map(({ since }) => since)).toEqual([
    at - 1865,
    at + 10 - 1865,
  ]);
});

it("a remembered thread's root the relay returns nothing for, deleted, is saved as absent, so the record stays complete on every relaunch", async () => {
  const thread = rememberedThreads();
  const storage = memoryUnreadStorage();
  await storage.save(thread.record);
  const store = [
    ...thread.store,
    deletion(peerKey, "team", thread.root),
    ...busy,
  ];
  const first = await launch({ store, storage, frontiers: thread.frontiers });
  await first.owner.capability.ensure();
  await first.saved;
  expect(await saved(storage)).toContain(thread.answer.id);
  expect(await storage.read()).toMatchObject({
    complete: true,
    absent: new Set([thread.root.id]),
  });
  first.owner.dispose();
  // A relaunch that cannot ask for it again still saves the record whole.
  const next = await launch({
    store,
    storage,
    frontiers: thread.frontiers,
    fail: (filters) =>
      filters.some((filter) => filter.ids?.includes(thread.root.id)),
  });
  await next.owner.capability.ensure();
  await next.saved;
  expect(await saved(storage)).toContain(thread.answer.id);
  expect(await storage.read()).toMatchObject({
    complete: true,
    absent: new Set([thread.root.id]),
  });
});

it("a pass whose roster sample fails leaves the mark unconfirmed, though its thread reads land", async () => {
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: {
      roots: new Map([
        [`team:${root.id}`, { at: mine.created_at, newestId: mine.id }],
      ]),
    },
    events: [],
    structure: new Set(),
    complete: false,
    // Too old for a delta: the pass is the bootstrap.
    mark: { at: T, checked: SECONDS - 86_401 },
  });
  const h = await launch({ store: [root, mine], storage, fail: sampleRead });
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await save.mock.results.at(-1)?.value;
  // The thread read landed.
  expect(
    h.reader.read.mock.calls.some(([filters]) =>
      filters.some(
        (filter) =>
          filter["#e"]?.includes(root.id) && filter.since === undefined,
      ),
    ),
  ).toBe(true);
  expect((await storage.read())?.mark).toEqual({
    at: T,
    checked: SECONDS - 86_401,
  });
});

it("a pass that could not read the viewer's authored page leaves the mark unset, though its roster sample lands", async () => {
  const storage = memoryUnreadStorage();
  const h = await launch({
    store: [hashed("team", T + 10), ...busy],
    storage,
    frontiers: { team: T, quiet: T, dm: T, busy: T },
    // The windows, and the authored page beside them: the channels alone
    // would only stay out of the roster set the mark covers.
    fail: (filters) =>
      filters.some(
        (filter) => filter["#h"] && filter.since !== undefined && !filter["#e"],
      ),
  });
  await h.owner.capability.ensure();
  await h.saved;
  expect(
    h.reader.read.mock.calls.filter(([filters]) => sampleRead(filters)),
  ).not.toEqual([]);
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect((await storage.read())?.mark).toBeUndefined();
});

it("a walk cut short by a dropped page saves an incomplete record, so the next launch reads the bootstrap, not the delta, and its walk", async () => {
  const storage = memoryUnreadStorage();
  // More of the viewer's messages than the authored page holds.
  const store = Array.from({ length: 101 }, (_, i) =>
    post(viewerKey, "quiet", T + i),
  );
  const later = (filters: readonly ReadFilter[]) =>
    filters.some((filter) => filter.authors && filter.until !== undefined);
  const first = await launch({ store, storage, fail: later });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  const record = await storage.read();
  expect(record?.mark).toEqual({ at: T + 100, checked: SECONDS });
  expect(record?.complete).toBe(false);
  // The walk's dropped page says nothing.
  expect(first.owner.capability.inbox().partial).toBeUndefined();
  const next = await launch({ store, storage });
  await next.owner.capability.ensure();
  await next.saved;
  expect(deltas(next)).toEqual([]);
  expect(next.reader.read.mock.calls.some(([filters]) => later(filters))).toBe(
    true,
  );
  expect((await storage.read())?.complete).toBe(true);
});

it("a held message deleted since the mark is read gone by a bootstrap before its roster sample confirms the mark past the deletion", async () => {
  const storage = memoryUnreadStorage();
  const held = post(peerKey, "team", T);
  const store = [held, ...busy];
  const h = await launch({
    store,
    storage,
    frontiers: { ...BUSY_READ, team: T - 1 },
  });
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await h.saved;
  const prior = (await storage.read())?.mark;
  expect(prior).toEqual({ at: T + 50_499, checked: SECONDS });
  expect(h.count("team")).toBe(1);
  // Deleted after that mark, and newer traffic moves the sample on.
  store.push(
    signed(peerKey, {
      kind: 5,
      content: "",
      created_at: T + 51_000,
      tags: [
        ["h", "team"],
        ["e", held.id],
      ],
    }),
    hashed("busy", T + 59_000),
  );
  await h.owner.capability.refresh();
  await save.mock.results.at(-1)?.value;
  expect(h.count("team")).toBe(0);
  expect((await storage.read())?.mark).toEqual({
    at: T + 59_000,
    checked: SECONDS,
  });
});

const overlayRead = (filters: readonly ReadFilter[]) =>
  filters.some((filter) => filter.kinds?.join() === "40003,5,9005");

const byIdRead = (filters: readonly ReadFilter[]) =>
  overlayRead(filters) && filters.some((filter) => !!filter["#e"]);

it("more edits and deletions since a stale mark than the bootstrap reads have those of the held content no read returned read by ID: a deletion applies, an unread message past its window's cut stays, and the mark moves once that read lands", async () => {
  const at = T + 10_000;
  // Confirmed over a day ago: the launch reads the bootstrap.
  const storage = await marked({ at, checked: SECONDS - 86_401 });
  // Unread, held before the pass, and past the cut of the channel's window
  // and the roster sample: one deleted by the oldest of more edits and
  // deletions since the mark than the read of them reaches, and a mention.
  const old = hashed("team", at + 1);
  const mention = hashed("team", at + 2, 9, [["p", viewer]]);
  const removal = hashed("team", at - 1865, 5, [["e", old.id]]);
  const noise = Array.from({ length: 1000 }, (_, i) =>
    hashed("team", at - 1864 + i, 5, [["e", "f".repeat(64)]]),
  );
  // What the window returns.
  const newer = Array.from({ length: 100 }, (_, i) =>
    hashed("team", at + 500 + i),
  );
  let failing = true;
  const h = await launch({
    store: [old, mention, removal, ...noise, ...newer, ...busy],
    storage,
    frontiers: { ...BUSY_READ, team: at },
    fail: (filters) => failing && byIdRead(filters),
  });
  h.owner.accept([old, mention]);
  const save = vi.spyOn(storage, "save");
  const { release, waiting } = h.hold();
  const launched = h.owner.capability.ensure();
  await waiting;
  // Received while the pass reads, and returned by none of its reads.
  const live = hashed("team", at + 600);
  h.owner.accept([live]);
  release();
  await launched;
  await save.mock.results.at(-1)?.value;
  const mentioned = () =>
    h.owner.capability
      .inbox()
      .items.some((item) => item.messageIds.includes(mention.id));
  // That read dropped: nothing is forgotten, the mark stays, and the Inbox
  // says some activity could not be checked.
  const sent = h.reader.read.mock.calls.map(([filters]) => filters);
  expect(sent.filter(overlayRead)).toHaveLength(4);
  expect(sent.filter(byIdRead)).toEqual([
    [
      {
        kinds: [40003, 5, 9005],
        "#e": [old.id, mention.id],
        since: at - 1865,
        limit: 500,
      },
    ],
    [
      {
        kinds: [40003, 5, 9005],
        "#e": [old.id, mention.id],
        since: at - 1865,
        limit: 500,
      },
    ],
  ]);
  expect(h.count("team")).toBe(103);
  expect(mentioned()).toBe(true);
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect((await storage.read())?.mark).toEqual({
    at,
    checked: SECONDS - 86_401,
  });
  // Landed on the next tick, it returns the deletion, which applies; the rest
  // stays, and the notice clears.
  failing = false;
  await h.reconnected();
  await save.mock.results.at(-1)?.value;
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect(h.owner.event(removal.id)).toBeDefined();
  expect(h.count("team")).toBe(102);
  expect(mentioned()).toBe(true);
  expect((await storage.read())?.mark).toEqual({
    at: T + 50_499,
    checked: SECONDS,
  });
  const next = await sentDuring(h, () => h.reconnected());
  await save.mock.results.at(-1)?.value;
  expect(next.filter(deltaFilter)).toEqual([
    expect.objectContaining({ since: T + 50_499 - 1865 }),
    expect.objectContaining({ since: T + 50_499 - 1865, until: T + 50_000 }),
  ]);
  expect(next.filter((filter) => overlayRead([filter]))).toEqual([]);
  expect(h.count("team")).toBe(102);
  expect(mentioned()).toBe(true);
});

it("of the reads by ID sharing a request, a full one pages on below the newest it matches, so another's older match does not skip a deletion it did not return", async () => {
  const at = T + 10_000;
  const since = at - 1865;
  const storage = await marked({ at, checked: SECONDS - 86_401 });
  // Unread past the window's cut and outside the roster sample: read by ID
  // in two filters, the first of 100 and the second of one.
  const held = Array.from({ length: 101 }, (_, i) =>
    hashed("team", at + 1 + i),
  );
  const newer = Array.from({ length: 100 }, (_, i) =>
    hashed("team", at + 500 + i),
  );
  // The first filter's 500 newest matches, then a deletion below them; the
  // second's one match is older still and matches the first too.
  const fill = Array.from({ length: 500 }, (_, i) =>
    hashed("team", since + 2 + i, 5, [["e", held[0]?.id ?? ""]]),
  );
  const hidden = hashed("team", since + 1, 5, [["e", held[50]?.id ?? ""]]);
  const cross = hashed("team", since, 5, [
    ["e", held[1]?.id ?? ""],
    ["e", held[100]?.id ?? ""],
  ]);
  // Newer than all of those, more than the read by channel reaches.
  const noise = Array.from({ length: 1000 }, (_, i) =>
    hashed("team", since + 502 + i, 5, [["e", "f".repeat(64)]]),
  );
  const h = await launch({
    store: [...held, ...newer, ...fill, hidden, cross, ...noise, ...busy],
    storage,
    frontiers: { ...BUSY_READ, team: at },
  });
  h.owner.accept(held);
  await h.owner.capability.ensure();
  const byId = h.reader.read.mock.calls
    .map(([filters]) => filters)
    .filter(byIdRead);
  expect(byId[0]?.map((filter) => filter["#e"]?.length)).toEqual([100, 1]);
  expect(h.owner.event(hidden.id)).toBeDefined();
  expect(h.count("team")).toBe(197);
});

it.each(["edited", "deleted"])(
  "a held message %s after more edits since the mark than a read by ID pages through has that read halved down to it alone, whose newest edits read it, while the other half applies a deletion below where the read of both stopped, so the mark moves",
  async (variant) => {
    const at = T + 10_000;
    const since = at - 1865;
    const storage = await marked({ at, checked: SECONDS - 86_401 });
    // Unread past the window's cut and outside the roster sample, read by ID
    // together: one an agent edits more often than that read pages through,
    // twice over, and one deleted below where its pages of both stop.
    const status = hashed("team", at - 2000);
    const other = hashed("team", at - 1999);
    const edits = Array.from({ length: 2001 }, (_, i) =>
      hashed("team", since + i, 40003, [["e", status.id]]),
    );
    const removal = hashed("team", since + 2001, 5, [["e", status.id]]);
    const gone = hashed("team", since + 500, 5, [["e", other.id]]);
    // Newer than all of those, more than the read by channel reaches.
    const noise = Array.from({ length: 1000 }, (_, i) =>
      hashed("team", since + 2002 + i, 5, [["e", "f".repeat(64)]]),
    );
    const newer = Array.from({ length: 100 }, (_, i) =>
      hashed("team", at + 500 + i),
    );
    const deleted = variant === "deleted";
    const h = await launch({
      store: [
        status,
        other,
        ...edits,
        ...(deleted ? [removal] : []),
        gone,
        ...noise,
        ...newer,
        ...busy,
      ],
      storage,
      frontiers: { ...BUSY_READ, team: at - 3000 },
    });
    h.owner.accept([status, other]);
    const save = vi.spyOn(storage, "save");
    await h.owner.capability.ensure();
    await save.mock.results.at(-1)?.value;
    // The other's half applies its deletion.
    expect(h.owner.event(gone.id)).toBeDefined();
    expect(h.count("team")).toBe(deleted ? 100 : 101);
    expect(h.owner.capability.inbox().partial).toBeUndefined();
    expect((await storage.read())?.mark).toEqual({
      at: T + 50_499,
      checked: SECONDS,
    });
    // Two pages of both, then each half on from where they stopped: the
    // deleted one is short, the edited one full at its last page.
    const shift = deleted ? 1 : 0;
    expect(
      h.reader.read.mock.calls
        .map(([filters]) => filters)
        .filter(byIdRead)
        .map(([filter]) => [filter?.["#e"], filter?.until]),
    ).toEqual([
      [[status.id, other.id], undefined],
      [[status.id, other.id], since + 1501 + shift],
      [[status.id], since + 1001 + shift],
      [[other.id], since + 1001 + shift],
      [[status.id], since + 501 + shift],
    ]);
  },
);

it("a held unread mention edited 3,000 times since the mark is held and saved with its newest edit alone, so the pass moves the mark and saves the record complete, and the next launch restores it edited", async () => {
  const at = T + 10_000;
  const since = at - 1865;
  const storage = await marked({ at, checked: SECONDS - 86_401 });
  // Unread past the window's cut and outside the roster sample, read by ID
  // together: a mention an agent edits more times than the record holds
  // events, and one never edited. What the record keeps is signed, for the
  // relaunch to verify.
  const status = post(peerKey, "team", at - 2000, [["p", viewer]]);
  const other = post(peerKey, "team", at - 1999);
  const edits = Array.from({ length: 2999 }, (_, i) =>
    hashed("team", since + i, 40003, [["e", status.id]]),
  );
  const newest = signed(peerKey, {
    kind: 40003,
    content: "status, edited",
    created_at: since + 2999,
    tags: [
      ["h", "team"],
      ["e", status.id],
    ],
  });
  const newer = Array.from({ length: 100 }, (_, i) =>
    post(peerKey, "team", at + 500 + i),
  );
  const store = [status, other, ...edits, newest, ...newer, ...busy];
  const frontiers = { ...BUSY_READ, team: at - 3000 };
  const h = await launch({ store, storage, frontiers });
  h.owner.accept([status, other]);
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await save.mock.results.at(-1)?.value;
  const edited = expect.objectContaining({
    messageIds: [status.id],
    preview: "status, edited",
  });
  expect(h.rows()).toContainEqual(edited);
  expect(h.count("team")).toBe(102);
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  const record = await storage.read();
  expect(record?.mark).toEqual({ at: T + 50_499, checked: SECONDS });
  expect(record?.complete).toBe(true);
  // The window, the roster sample, the two read by ID and one edit.
  const kept = await saved(storage);
  expect(kept).toHaveLength(100 + 500 + 2 + 1);
  expect(kept).toContain(newest.id);
  h.owner.dispose();
  // The relay cannot be read: the edited mention comes from storage alone.
  const offline = await launch({ store, storage, frontiers, down: true });
  await offline.owner.capability.ensure();
  await offline.restored(kept.length);
  expect(offline.rows()).toContainEqual(edited);
  expect(offline.count("team")).toBe(102);
});

it("a held message edited more times than the evidence holds events has one edit held, so its edits evict nothing: every held message stays counted, and the mark moves", async () => {
  const at = T + 10_000;
  const since = at - 1865;
  const storage = await marked({ at, checked: SECONDS - 86_401 });
  // Unread past the window's cut and outside the roster sample, read by ID
  // together, the oldest of them edited by an agent 5,000 times.
  const held = Array.from({ length: 22 }, (_, i) =>
    hashed("team", at - 2000 + i),
  );
  const [status] = held;
  assert(status);
  const edits = Array.from({ length: 5000 }, (_, i) =>
    hashed("team", since + i, 40003, [["e", status.id]]),
  );
  const newer = Array.from({ length: 100 }, (_, i) =>
    hashed("team", at + 500 + i),
  );
  const h = await launch({
    store: [...held, ...edits, ...newer, ...busy],
    storage,
    frontiers: { ...BUSY_READ, team: at - 3000 },
  });
  h.owner.accept(held);
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await save.mock.results.at(-1)?.value;
  expect(h.count("team")).toBe(122);
  expect(h.owner.event(status.id)).toBeDefined();
  expect(h.owner.event(edits.at(-1)?.id ?? "")).toBeDefined();
  expect(h.owner.event(edits.at(-2)?.id ?? "")).toBeUndefined();
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.mark).toEqual({
    at: T + 50_499,
    checked: SECONDS,
  });
});

it("a read by ID that would need more than 200 halves is dropped there, nothing queued behind it read: the mark stays and the Inbox says some activity could not be checked", async () => {
  const at = T + 10_000;
  const since = at - 1865;
  const storage = await marked({ at, checked: SECONDS - 86_401 });
  // Unread past the window's cut and outside the roster sample, read by ID
  // in two filters of 100, beside more edits and deletions than the read by
  // channel reaches.
  const held = Array.from({ length: 200 }, (_, i) =>
    hashed("team", at - 2000 + i),
  );
  const noise = Array.from({ length: 1000 }, (_, i) =>
    hashed("team", since + i, 5, [["e", "f".repeat(64)]]),
  );
  const newer = Array.from({ length: 100 }, (_, i) =>
    hashed("team", at + 500 + i),
  );
  const h = await launch({
    store: [...held, ...noise, ...newer, ...busy],
    storage,
    frontiers: { ...BUSY_READ, team: at - 3000 },
  });
  // Each filter's first message has more edits than any page reaches, so
  // every page by ID is full and each second page of more than one message
  // is halved, until the 101st would make more than 200 halves. The edits
  // are made as they are read, below where each page starts.
  const relay = h.reader.read.getMockImplementation();
  assert(relay);
  const pages = new Map<string, number>();
  let made = 0;
  let splits = 0;
  let after = 0;
  h.reader.read.mockImplementation(async (filters) => {
    if (!byIdRead(filters)) return relay(filters);
    if (splits > 100) after++;
    return filters.flatMap((filter) => {
      const ids = filter["#e"] ?? [];
      const page = (pages.get(ids.join()) ?? 0) + 1;
      pages.set(ids.join(), page);
      if (page === 2 && ids.length > 1) splits++;
      const top = filter.until ?? since + 10_000;
      return Array.from(
        { length: 500 },
        (_, i): RelayEvent => ({
          kind: 40003,
          pubkey: peerKey.pubkey,
          created_at: top - 1 - i,
          content: "",
          tags: [
            ["h", "team"],
            ["e", ids[0] ?? ""],
          ],
          id: (made++).toString(16).padStart(64, "0"),
          sig: "0".repeat(128),
          [verifiedSymbol]: true,
        }),
      );
    });
  });
  h.owner.accept(held);
  await h.owner.capability.ensure();
  expect(splits).toBe(101);
  expect(after).toBe(0);
  expect(h.count("team")).toBe(300);
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect((await storage.read())?.mark).toEqual({
    at,
    checked: SECONDS - 86_401,
  });
});

it("a read by ID dropped at 200 halves is resumed by the next pass from where it stopped, its IDs read again only since that pass's newest less the lookback, which a deletion made since is newer than: the next pass reads it to its end in far fewer requests, the deletion applies, the mark moves and the notice clears", async () => {
  const at = T + 10_000;
  const since = at - 1865;
  const storage = await marked({ at, checked: SECONDS - 86_401 });
  // Unread past the window's cut and outside the roster sample, read by ID
  // in 15 filters of 100, beside more edits and deletions than the read by
  // channel reaches.
  const held = Array.from({ length: 1500 }, (_, i) =>
    hashed("team", at - 2000 + i),
  );
  const noise = Array.from({ length: 1000 }, (_, i) =>
    hashed("team", since + i, 5, [["e", "f".repeat(64)]]),
  );
  const newer = Array.from({ length: 100 }, (_, i) =>
    hashed("team", at + 500 + i),
  );
  const store = [...held, ...noise, ...newer, ...busy];
  const h = await launch({
    store,
    storage,
    frontiers: { ...BUSY_READ, team: at - 3000 },
  });
  // Each filter's first message is edited every second of the 10,000 since
  // the mark, its others in the newest 1,000 alone, all before the roster's
  // newest: halving takes each filter down to its first, 7 halvings a
  // filter, 105 in all, more than the 100 a read makes.
  const deep = new Set(held.flatMap((event, i) => (i % 100 ? [] : [event.id])));
  const newest = since + 10_000;
  const relay = h.reader.read.getMockImplementation();
  assert(relay);
  let made = 0;
  const edits = (filter: ReadFilter) => {
    const ids = filter["#e"] ?? [];
    const top = Math.min(filter.until ?? newest, newest);
    const floor = Math.max(
      filter.since ?? 0,
      ids.some((id) => deep.has(id)) ? since : newest - 1000,
    );
    return Array.from(
      { length: Math.max(0, Math.min(filter.limit, top - floor)) },
      (_, i): RelayEvent => ({
        kind: 40003,
        pubkey: peerKey.pubkey,
        created_at: top - 1 - i,
        content: "",
        tags: [
          ["h", "team"],
          ["e", ids[0] ?? ""],
        ],
        id: (made++).toString(16).padStart(64, "0"),
        sig: "0".repeat(128),
        [verifiedSymbol]: true,
      }),
    );
  };
  h.reader.read.mockImplementation(async (filters) =>
    byIdRead(filters)
      ? [...(await relay(filters)), ...filters.flatMap(edits)]
      : relay(filters),
  );
  const requests = () =>
    h.reader.read.mock.calls.map(([filters]) => filters).filter(byIdRead);
  h.owner.accept(held);
  await h.owner.capability.ensure();
  const first = requests();
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect((await storage.read())?.mark).toEqual({
    at,
    checked: SECONDS - 86_401,
  });
  // Meanwhile one the dropped read had read to its end is deleted, as the
  // relay's clock goes, behind more deletions than the read by channel
  // reaches.
  const target = held[1];
  assert(target);
  const gone = hashed("team", SECONDS - 500, 5, [["e", target.id]]);
  store.push(
    gone,
    ...Array.from({ length: 1000 }, (_, i) =>
      hashed("team", SECONDS - 400 + (i % 400), 5, [["e", "f".repeat(64)]]),
    ),
  );
  const save = vi.spyOn(storage, "save");
  await h.reconnected();
  await save.mock.results.at(-1)?.value;
  const second = requests().slice(first.length);
  expect(h.owner.event(gone.id)).toBeDefined();
  expect(h.count("team")).toBe(1599);
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.mark).toEqual({
    at: T + 50_499,
    checked: SECONDS,
  });
  // On from where the dropped read stopped, and its IDs again since the
  // roster's newest less the lookback: nothing is read again from the top
  // since the mark.
  expect(second.flat().filter((filter) => filter.until === undefined)).toEqual(
    first[0]?.concat(first[1] ?? []).map((filter) => ({
      ...filter,
      since: T + 50_499 - 1865,
    })),
  );
  expect(first.length).toBeGreaterThan(200);
  expect(second.length).toBeLessThan(first.length / 4);
});

it("on a roster of more than 128 channels holding evidence, only the chunks whose edits and deletions were not read to their end have their held content read by ID", async () => {
  const at = T + 10_000;
  const since = at - 1865;
  // The first 128 channels holding evidence, then a quiet one beside one
  // whose 500 newer messages keep the quiet one's out of the roster sample.
  const extra = Array.from({ length: 124 }, (_, i) => `c${i}`);
  const ids = [...ROSTER, ...extra, "edge", "loud"];
  const storage = await marked({ at, checked: SECONDS - 86_401 }, ids);
  // Read, so no window returns it: one held in each channel but busy and
  // loud, which the roster sample fills.
  const held = ids
    .filter((id) => id !== "busy" && id !== "loud")
    .map((id) => hashed(id, T));
  const loud = Array.from({ length: 500 }, (_, i) =>
    hashed("loud", T + 60_000 + i),
  );
  // More edits and deletions in team than the read of them reaches.
  const noise = Array.from({ length: 1000 }, (_, i) =>
    hashed("team", since + i, 5, [["e", "f".repeat(64)]]),
  );
  const h = await launch({
    store: [...held, ...loud, ...noise, ...busy],
    storage,
    roster: summaries(ids),
    frontiers: {
      ...Object.fromEntries(ids.map((id) => [id, T + 20_000])),
      ...BUSY_READ,
      loud: T + 70_000,
    },
  });
  h.owner.accept(held);
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await save.mock.results.at(-1)?.value;
  const sent = h.reader.read.mock.calls.map(([filters]) => filters);
  // Read by channel in two chunks, the first full and the second short.
  expect(
    sent
      .filter((filters) => overlayRead(filters) && !byIdRead(filters))
      .map(([filter]) => filter?.["#h"]?.length),
  ).toEqual([128, 2, 128]);
  const edge = held.at(-1);
  expect(
    sent
      .filter(byIdRead)
      .flat()
      .flatMap((filter) => filter["#e"] ?? [])
      .sort(),
  ).toEqual(
    held
      .filter((item) => item !== edge)
      .map((item) => item.id)
      .sort(),
  );
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.mark).toEqual({
    at: T + 60_499,
    checked: SECONDS,
  });
});

it("unread messages in a channel whose window dropped beside a busy one's edits and deletions stay until the window is read again", async () => {
  const at = T + 10_000;
  // Past the 127 windows riding with the viewer's authored page.
  const extra = Array.from({ length: 126 }, (_, i) => `c${i}`);
  const storage = await marked({ at, checked: SECONDS - 86_401 }, [
    ...ROSTER,
    ...extra,
  ]);
  // More than one request's reads by ID cover.
  const unread = Array.from({ length: 1000 }, (_, i) =>
    hashed("team", at + 1 + i),
  );
  const noise = Array.from({ length: 1001 }, (_, i) =>
    hashed("team", at - 1864 + i, 5, [["e", "f".repeat(64)]]),
  );
  let failing = true;
  const h = await launch({
    store: [...unread, ...noise, ...busy],
    storage,
    roster: summaries([...ROSTER, ...extra]),
    frontiers: {
      ...BUSY_READ,
      team: at,
      ...Object.fromEntries(extra.map((id) => [id, T + 20_000])),
    },
    fail: (filters) => failing && filters.some(windowOf("team")),
  });
  h.owner.accept(unread);
  await h.owner.capability.ensure();
  const sent = h.reader.read.mock.calls.map(([filters]) => filters);
  expect(
    sent
      .filter((filters) => filters.some(windowOf("team")))
      .every((filters) => !filters.some((filter) => filter.authors)),
  ).toBe(true);
  // Each within the reader's 64 KiB of filters, together every one.
  const byId = sent.filter(byIdRead);
  expect(
    byId.every(
      (filters) =>
        new TextEncoder().encode(JSON.stringify(filters)).byteLength <=
        64 * 1024,
    ),
  ).toBe(true);
  expect(
    byId
      .flat()
      .flatMap((filter) => filter["#e"] ?? [])
      .sort(),
  ).toEqual(unread.map((item) => item.id).sort());
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect(h.count("team")).toBe(1000);
  failing = false;
  await h.reconnected();
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect(h.count("team")).toBe(1000);
});

// What the mark does not cover is read once beside the delta (design §3.6);
// a pass that catches up reads nothing else of the bootstrap.
/** The filters of the reads sent while `pass` ran. */
async function sentDuring(h: Launch, pass: () => Promise<unknown>) {
  const from = h.reader.read.mock.calls.length;
  await pass();
  return h.reader.read.mock.calls.slice(from).flatMap(([filters]) => filters);
}
const windowOf = (id: string) => (filter: ReadFilter) =>
  filter.include_aux === true &&
  filter.since !== undefined &&
  !filter["#e"] &&
  filter["#h"]?.join() === id;
const wholeOf = (rootId: string) => (filter: ReadFilter) =>
  !!filter["#e"]?.includes(rootId) && filter.since === undefined;
const deltaFilter = (filter: ReadFilter) => deltaRead([filter]);
/** A launch from a complete record whose mark covers the default roster. */
async function caughtUp(
  store: RelayEvent[],
  roster = summaries(ROSTER),
  frontiers: Readonly<Record<string, number>> = {},
) {
  const storage = await marked({
    at: SECONDS - 600,
    checked: SECONDS - 60,
  });
  const h = await launch({ store, storage, roster, frontiers });
  await h.owner.capability.ensure();
  return { h, storage };
}

it("joining a channel holding an old unread message, and a DM, reads each once beside the delta, and not again on the next tick", async () => {
  // Older than the delta reaches.
  const old = post(peerKey, "fresh", T + 10);
  const direct = post(peerKey, "dm2", T + 20);
  const { h, storage } = await caughtUp([old, direct]);
  const joined = [
    ...summaries([...ROSTER, "fresh"]),
    {
      id: "dm2",
      name: "dm2",
      members: [viewer, peerKey.pubkey],
      channelType: "dm" as const,
    },
  ];
  const joining = await sentDuring(h, () => {
    h.roster(joined);
    return h.owner.capability.ensure();
  });
  expect(joining.filter(deltaFilter)).not.toEqual([]);
  for (const id of ["fresh", "dm2"])
    expect(joining.filter(windowOf(id))).toHaveLength(1);
  expect(joining.filter(windowOf("team"))).toEqual([]);
  expect(joining.filter(sampleFilter)).toHaveLength(1);
  expect(h.count("fresh")).toBe(1);
  expect(h.count("dm2")).toBe(1);
  expect((await storage.read())?.roster).toEqual(
    new Set([...ROSTER, "fresh", "dm2"]),
  );
  const ticking = await sentDuring(h, () => h.reconnected());
  for (const id of ["fresh", "dm2"])
    expect(ticking.filter(windowOf(id))).toEqual([]);
  expect(ticking.filter(sampleFilter)).toEqual([]);
});

it("a channel joined while this device was closed is read once on the next launch, not trusted to the mark", async () => {
  const old = post(peerKey, "fresh", T + 10);
  const { h, storage } = await caughtUp([old], summaries([...ROSTER, "fresh"]));
  const launched = h.reader.read.mock.calls.flatMap(([filters]) => filters);
  expect(launched.filter(deltaFilter)).not.toEqual([]);
  expect(launched.filter(windowOf("fresh"))).toHaveLength(1);
  expect(launched.filter(windowOf("team"))).toEqual([]);
  expect(h.count("fresh")).toBe(1);
  expect((await storage.read())?.roster).toEqual(new Set([...ROSTER, "fresh"]));
  const ticking = await sentDuring(h, () => h.reconnected());
  expect(ticking.filter(windowOf("fresh"))).toEqual([]);
});

it("leaving a busy channel reads the roster sample once more at once, saving the record complete, and rejoining it reads its window once", async () => {
  const { h, storage } = await caughtUp([...busy]);
  const left = summaries(ROSTER.filter((id) => id !== "busy"));
  const leaving = await sentDuring(h, () => {
    h.roster(left);
    return h.owner.capability.ensure();
  });
  expect(leaving.filter(sampleFilter)).toEqual([
    expect.objectContaining({ "#h": ["team", "quiet", "dm"] }),
  ]);
  expect(await storage.read()).toMatchObject({
    complete: true,
    roster: new Set(["team", "quiet", "dm"]),
  });
  const ticking = await sentDuring(h, () => h.reconnected());
  expect(ticking.filter(sampleFilter)).toEqual([]);
  // Its evidence was purged with it: a re-grant is a join.
  const rejoining = await sentDuring(h, () => {
    h.roster(summaries(ROSTER));
    return h.owner.capability.ensure();
  });
  expect(rejoining.filter(windowOf("busy"))).toHaveLength(1);
});

it("a channel the mark does not cover has its remembered threads past the 50 hot ones read since their marks once beside the delta, and not again", async () => {
  const hot = Array.from({ length: 50 }, (_, i) =>
    post(peerKey, "team", T + 100 + i),
  );
  const cold = post(peerKey, "quiet", T);
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: {
      roots: new Map([
        ...hot.map((root): [string, { at: number }] => [
          `team:${root.id}`,
          { at: root.created_at },
        ]),
        [`quiet:${cold.id}`, { at: T }],
      ]),
    },
    events: [],
    structure: new Set(),
    complete: true,
    mark: { at: SECONDS - 600, checked: SECONDS - 60 },
    roster: new Set(ROSTER.filter((id) => id !== "quiet")),
  });
  const h = await launch({ store: [...hot, cold], storage });
  const coldOf = (filter: ReadFilter) =>
    !!filter["#e"]?.includes(cold.id) && filter.since === T;
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  expect(launched.filter(deltaFilter)).not.toEqual([]);
  expect(launched.filter(coldOf)).toHaveLength(1);
  const ticking = await sentDuring(h, () => h.reconnected());
  expect(ticking.filter(coldOf)).toEqual([]);
});

it("a channel the mark does not cover whose cold thread read drops stays out of the roster set, and is read once again on the next pass", async () => {
  const hot = Array.from({ length: 50 }, (_, i) =>
    post(peerKey, "team", T + 100 + i),
  );
  const cold = post(peerKey, "quiet", T);
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: {
      roots: new Map([
        ...hot.map((root): [string, { at: number }] => [
          `team:${root.id}`,
          { at: root.created_at },
        ]),
        [`quiet:${cold.id}`, { at: T }],
      ]),
    },
    events: [],
    structure: new Set(),
    complete: true,
    mark: { at: SECONDS - 600, checked: SECONDS - 60 },
    roster: new Set(ROSTER.filter((id) => id !== "quiet")),
    whole: new Set(hot.map((root) => `team:${root.id}`)),
  });
  const coldOf = (filter: ReadFilter) =>
    !!filter["#e"]?.includes(cold.id) && filter.since === T;
  let failing = true;
  const h = await launch({
    store: [...hot, cold],
    storage,
    fail: (filters) => failing && filters.some(coldOf),
  });
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  await h.saved;
  // Its window and the sample landed; its cold read, retried, did not.
  expect(launched.filter(windowOf("quiet"))).toHaveLength(1);
  expect(launched.filter(coldOf)).toHaveLength(2);
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect((await storage.read())?.roster).toEqual(
    new Set(ROSTER.filter((id) => id !== "quiet")),
  );
  failing = false;
  const ticking = await sentDuring(h, () => h.reconnected());
  expect(ticking.filter(windowOf("quiet"))).toHaveLength(1);
  expect(ticking.filter(coldOf)).toHaveLength(1);
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.roster).toEqual(new Set(ROSTER));
});

it("a reply of the viewer's in an old thread has the thread read whole once beside the delta, and not again", async () => {
  const root = post(peerKey, "team", T);
  const store = [root, reply(peerKey, "team", root, T + 1)];
  const { h, storage } = await caughtUp(store);
  const mine = reply(viewerKey, "team", root, SECONDS - 10);
  store.push(mine);
  h.owner.accept([mine]);
  const replied = await sentDuring(h, () => h.reconnected());
  expect(replied.filter(wholeOf(root.id))).toHaveLength(1);
  expect((await storage.read())?.whole).toEqual(new Set([`team:${root.id}`]));
  const ticking = await sentDuring(h, () => h.reconnected());
  expect(ticking.filter(wholeOf(root.id))).toEqual([]);
});

/** A launch caught up on a thread the viewer has no part in, and a pass
 * after following it or not. */
async function following() {
  const root = post(peerKey, "team", T);
  const { h, storage } = await caughtUp([
    root,
    reply(peerKey, "team", root, T + 1),
  ]);
  const follow = async (on: boolean) => {
    h.owner.capability.follow("team", root.id, on);
    return (await sentDuring(h, () => h.reconnected())).filter(
      wholeOf(root.id),
    );
  };
  return { h, storage, root, follow };
}

it("following a thread has it read whole once beside the delta", async () => {
  const { h, root, follow } = await following();
  expect(await follow(true)).toHaveLength(1);
  const ticking = await sentDuring(h, () => h.reconnected());
  expect(ticking.filter(wholeOf(root.id))).toEqual([]);
});

it("unfollowing a thread drops it from the threads read whole, so following it again reads it whole again", async () => {
  const { storage, root, follow } = await following();
  await follow(true);
  expect((await storage.read())?.whole).toEqual(new Set([`team:${root.id}`]));
  expect(await follow(false)).toEqual([]);
  expect((await storage.read())?.whole).toBeUndefined();
  expect(await follow(true)).toHaveLength(1);
});

it("a dropped whole read of a thread is read again on the next pass for that thread alone", async () => {
  const kept = post(peerKey, "team", T);
  const lost = post(peerKey, "quiet", T + 5);
  const keys = [`team:${kept.id}`, `quiet:${lost.id}`];
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: {
      roots: new Map([
        [keys[0] ?? "", { at: T + 1 }],
        [keys[1] ?? "", { at: T + 6 }],
      ]),
    },
    events: [],
    structure: new Set(),
    complete: true,
    mark: { at: SECONDS - 600, checked: SECONDS - 60 },
    roster: new Set(ROSTER),
    whole: new Set([keys[0] ?? ""]),
  });
  let failing = true;
  const h = await launch({
    store: [
      kept,
      reply(peerKey, "team", kept, T + 1),
      lost,
      reply(peerKey, "quiet", lost, T + 6),
    ],
    storage,
    fail: (filters) =>
      failing && filters.some((filter) => filter["#e"]?.includes(lost.id)),
  });
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  // The promotion of the one not read whole, retried once, dropped.
  expect(launched.filter(wholeOf(lost.id))).toHaveLength(2);
  expect(launched.filter(wholeOf(kept.id))).toEqual([]);
  expect((await storage.read())?.whole).toEqual(new Set([keys[0]]));
  failing = false;
  const ticking = await sentDuring(h, () => h.reconnected());
  expect(ticking.filter(wholeOf(kept.id))).toEqual([]);
  expect(ticking.filter(wholeOf(lost.id))).toHaveLength(1);
  expect((await storage.read())?.whole).toEqual(new Set(keys));
});

it("a delta that drops keeps the mark though the roster sample lands, leaves the pass partial and adds what it read once to the roster set, and the next pass reads it from the same mark", async () => {
  const at = SECONDS - 600;
  const checked = SECONDS - 60;
  const storage = await marked({ at, checked });
  let failing = true;
  const h = await launch({
    store: [hashed("team", at + 10), post(peerKey, "fresh", T + 10)],
    storage,
    roster: summaries([...ROSTER, "fresh"]),
    fail: (filters) => failing && deltaRead(filters),
  });
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await save.mock.results.at(-1)?.value;
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect(h.count("fresh")).toBe(1);
  expect(await storage.read()).toMatchObject({
    mark: { at, checked },
    roster: new Set([...ROSTER, "fresh"]),
  });
  failing = false;
  const next = await sentDuring(h, () => h.reconnected());
  await save.mock.results.at(-1)?.value;
  expect(next.filter(deltaFilter)).toEqual([
    expect.objectContaining({ since: at - 1865 }),
  ]);
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.mark).toEqual({
    at: at + 10,
    checked: SECONDS,
  });
});

it("Refresh pressed while a pass catches up has the bootstrap read after it, and each press settles once that has", async () => {
  const storage = await marked({ at: SECONDS - 600, checked: SECONDS - 60 });
  // Only the bootstrap after the reconnect's pass reads the channel's
  // window, which fails, so only its end leaves the Inbox partial.
  const h = await launch({
    store: [hashed("team", SECONDS - 300)],
    storage,
    fail: (filters) => filters.some(windowOf("team")),
  });
  await h.owner.capability.ensure();
  const from = h.reader.read.mock.calls.length;
  const { release, waiting } = h.hold();
  let pressed: Promise<void>[] = [];
  try {
    h.owner.reconnect();
    await waiting;
    const syncing = vi.spyOn(h.reads, "refresh");
    pressed = [h.owner.capability.refresh(), h.owner.capability.refresh()];
    // Each asks for its repair as soon as the read state settles, before
    // anything awaiting that settles.
    await Promise.all(syncing.mock.results.map(({ value }) => value));
  } finally {
    release();
  }
  for (const press of [pressed[1], pressed[0]]) {
    await press;
    expect(h.owner.capability.inbox().partial).toBe(true);
  }
  const sent = h.reader.read.mock.calls
    .slice(from)
    .flatMap(([filters]) => filters);
  expect(sent.filter(deltaFilter)).toHaveLength(1);
  // Read and retried once.
  expect(sent.filter(windowOf("team"))).toHaveLength(2);
});

it("Refresh pressed while a pass asked to catch up reads the bootstrap joins it, and one pressed before that pass routes has it read the bootstrap", async () => {
  const store = [hashed("team", SECONDS - 300)];
  // A mark confirmed over a day ago: the launch's pass reads the bootstrap.
  const stale = await launch({
    store,
    storage: await marked({ at: SECONDS - 600, checked: SECONDS - 86_401 }),
  });
  const { release, waiting } = stale.hold();
  let pressed: Promise<void> | undefined;
  try {
    const syncing = vi.spyOn(stale.reads, "refresh");
    const launched = stale.owner.capability.ensure();
    await waiting;
    pressed = stale.owner.capability.refresh();
    await Promise.all(syncing.mock.results.map(({ value }) => value));
    release();
    await launched;
  } finally {
    release();
  }
  await pressed;
  const sent = stale.reader.read.mock.calls.flatMap(([filters]) => filters);
  expect(sent.filter(deltaFilter)).toEqual([]);
  expect(sent.filter(sampleFilter)).toHaveLength(1);
  stale.owner.dispose();
  // A mark confirmed a minute ago, read before the launch's pass routes.
  const fresh = await marked({ at: SECONDS - 600, checked: SECONDS - 60 });
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const h = await launch({
    store,
    storage: {
      ...fresh,
      read: () => opened.then(() => fresh.read()),
    },
  });
  const syncing = vi.spyOn(h.reads, "refresh");
  const launched = h.owner.capability.ensure();
  pressed = h.owner.capability.refresh();
  await Promise.all(syncing.mock.results.map(({ value }) => value));
  open();
  await Promise.all([launched, pressed]);
  const routed = h.reader.read.mock.calls.flatMap(([filters]) => filters);
  expect(routed.filter(deltaFilter)).toEqual([]);
  expect(routed.filter(sampleFilter)).toHaveLength(1);
});

it("a pass an access change retires settles a launch's wait only once the pass after it has read", async () => {
  const h = await launch({
    store: [post(peerKey, "fresh", T + 10)],
    storage: memoryUnreadStorage(),
  });
  const first = h.hold();
  let launched: Promise<void> | undefined;
  try {
    launched = h.owner.capability.ensure();
    await first.waiting;
    h.roster(summaries([...ROSTER, "fresh"]));
    // The pass after it holds at its first read, past the retired one's end.
    const next = h.hold();
    first.release();
    try {
      await next.waiting;
    } finally {
      next.release();
    }
  } finally {
    first.release();
  }
  await launched;
  expect(h.owner.capability.inbox().freshness).toBe("observed");
  expect(h.count("fresh")).toBe(1);
});

it("a resume launch whose cached roster is confirmed unchanged catches up with the delta, reading no channel once", async () => {
  const cached = summaries(ROSTER).map((channel) => ({
    ...channel,
    cached: true as const,
  }));
  const { h } = await caughtUp([hashed("team", SECONDS - 300)], cached);
  // The launch's pass found no confirmed channel to read.
  expect(deltas(h)).toEqual([]);
  const confirming = await sentDuring(h, () => {
    h.roster(summaries(ROSTER));
    return h.owner.capability.ensure();
  });
  expect(confirming.filter(deltaFilter)).toEqual([
    expect.objectContaining({ since: SECONDS - 600 - 1865 }),
  ]);
  for (const id of ROSTER) expect(confirming.filter(windowOf(id))).toEqual([]);
  expect(confirming.filter(sampleFilter)).toEqual([]);
});

it("a channel whose window dropped stays out of the roster set the mark covers, and is read once on the next pass", async () => {
  const ids = Array.from({ length: 130 }, (_, i) => `c${i}`);
  const storage = memoryUnreadStorage();
  let failing = true;
  const h = await launch({
    store: [hashed("c129", T + 10)],
    storage,
    roster: members(ids),
    // The windows past those riding with the viewer's authored page.
    fail: (filters) =>
      failing &&
      filters.some(windowOf("c129")) &&
      !filters.some((filter) => filter.authors),
  });
  await h.owner.capability.ensure();
  const record = await storage.read();
  expect(record?.mark).toEqual({ at: T + 10, checked: SECONDS });
  expect(record?.roster).toEqual(new Set(ids.slice(0, 127)));
  failing = false;
  const next = await sentDuring(h, () => h.reconnected());
  expect(next.filter(deltaFilter)).not.toEqual([]);
  for (const id of ids.slice(127))
    expect(next.filter(windowOf(id))).toHaveLength(1);
  expect(next.filter(windowOf("c0"))).toEqual([]);
  expect((await storage.read())?.roster).toEqual(new Set(ids));
});

it("a delta over a partly confirmed roster keeps covering only the channels it read, walks the viewer's messages beside it, and the rest are read once when confirmed", async () => {
  const partly = summaries(ROSTER).map((channel) =>
    channel.id === "dm" || channel.id === "busy"
      ? { ...channel, cached: true as const }
      : channel,
  );
  // The viewer replied in `busy`, still cached, and read past the reply,
  // then posted in `team`: the delta reads `team`, not `busy`, and `busy`'s
  // window and the roster sample do not reach the reply.
  const root = post(peerKey, "busy", T + 39_000);
  const mine = reply(viewerKey, "busy", root, T + 40_000);
  const posted = post(viewerKey, "team", SECONDS - 400);
  const { h, storage } = await caughtUp(
    [hashed("team", SECONDS - 300), root, mine, posted, ...busy],
    partly,
    BUSY_READ,
  );
  expect(deltas(h)).toEqual([
    expect.objectContaining({ "#h": ["team", "quiet"] }),
  ]);
  const record = await storage.read();
  expect(record?.roster).toEqual(new Set(["team", "quiet"]));
  expect(record?.participation.walk).toEqual({ since: posted.created_at });
  const confirming = await sentDuring(h, () => {
    h.roster(summaries(ROSTER));
    return h.owner.capability.ensure();
  });
  for (const id of ["dm", "busy"])
    expect(confirming.filter(windowOf(id))).toHaveLength(1);
  expect(confirming.filter(windowOf("team"))).toEqual([]);
  // The walk beside the first delta learned the thread, which is now read
  // whole once and remembered.
  expect(confirming.filter(wholeOf(root.id))).toHaveLength(1);
  const confirmed = await storage.read();
  expect(confirmed?.roster).toEqual(new Set(ROSTER));
  expect(confirmed?.participation.roots.has(`busy:${root.id}`)).toBe(true);
});

it("a walk beside the delta that drops leaves the walk mark where it was and the record owing a walk", async () => {
  const partly = summaries(ROSTER).map((channel) =>
    channel.id === "busy" ? { ...channel, cached: true as const } : channel,
  );
  const storage = await marked({ at: SECONDS - 600, checked: SECONDS - 60 });
  const h = await launch({
    store: [post(viewerKey, "team", SECONDS - 400)],
    storage,
    roster: partly,
    fail: (filters) => filters.some((filter) => !!filter.authors),
  });
  await h.owner.capability.ensure();
  await h.saved;
  expect(deltas(h)).not.toEqual([]);
  const record = await storage.read();
  expect(record?.complete).toBe(false);
  expect(record?.participation.walk).toBeUndefined();
  expect(h.owner.capability.inbox().partial).toBe(true);
});

// A full repair from a mark (design §3.7): the threads read through to it
// are asked for replies since the mark less 1,865 s in one read of their
// roots, not each on its own.
const CONTENT = [9, 40002, 40008];
const threadReads = (filters: readonly ReadFilter[]) =>
  filters.filter(
    (filter) => !!filter["#e"] && filter.kinds?.join() === CONTENT.join(),
  );
const ownReads = (filters: readonly ReadFilter[]) =>
  threadReads(filters).filter(
    (filter) => filter.since === undefined || filter.limit === 50,
  );
/** A record not complete, so the launch reads the bootstrap from its mark,
 * confirmed at `checked` (a minute ago unless given), holding no evidence:
 * `hot` threads read whole and through, `cold` ones read through, and
 * `owed` ones neither. */
async function readThrough({
  hot = [],
  cold = [],
  owed = [],
  checked = SECONDS - 60,
}: {
  hot?: readonly [string, RelayEvent][];
  cold?: readonly [string, RelayEvent][];
  owed?: readonly [string, RelayEvent][];
  checked?: number;
}) {
  const key = ([channelId, root]: [string, RelayEvent]) =>
    `${channelId}:${root.id}`;
  const storage = memoryUnreadStorage();
  const mark = { at: SECONDS - 600, checked };
  await storage.save({
    participation: {
      roots: new Map(
        [...hot, ...cold, ...owed].map((entry) => [
          key(entry),
          { at: entry[1].created_at },
        ]),
      ),
    },
    events: [],
    structure: new Set(),
    complete: false,
    mark,
    roster: new Set(ROSTER),
    whole: new Set(hot.map(key)),
    through: new Set([...hot, ...cold].map(key)),
  });
  return { storage, mark, since: mark.at - 1865 };
}

it("a warm Refresh reads the threads read through to the mark in one read of their roots since it less 1,865 s, beside the windows and the roster sample, where a fresh device reads each thread", async () => {
  const roots = Array.from({ length: 60 }, (_, i) =>
    post(peerKey, "team", T + i),
  );
  const store = [
    ...roots,
    ...roots.map((root, i) => reply(viewerKey, "team", root, T + 100 + i)),
    ...busy,
  ];
  const storage = memoryUnreadStorage();
  const fresh = await launch({ store, storage, frontiers: BUSY_READ });
  const first = await sentDuring(fresh, () => fresh.owner.capability.ensure());
  await fresh.saved;
  // A fresh device: the 50 hot threads read whole, each cold one since its
  // newest time, and no read past a mark.
  expect(ownReads(first).filter((filter) => !filter.since)).toEqual([
    expect.objectContaining({ "#h": ["team"] }),
  ]);
  expect(ownReads(first).filter((filter) => filter.since)).toHaveLength(10);
  expect(threadReads(first)).toHaveLength(11);
  const record = await storage.read();
  expect(record?.through?.size).toBe(60);
  const mark = record?.mark?.at ?? 0;
  fresh.owner.dispose();
  const warm = await launch({ store, storage, frontiers: BUSY_READ });
  await warm.owner.capability.ensure();
  const refreshed = await sentDuring(warm, () =>
    warm.owner.capability.refresh(),
  );
  expect(threadReads(refreshed)).toEqual([
    {
      kinds: CONTENT,
      "#h": ["team"],
      "#e": expect.arrayContaining(roots.map((root) => root.id)),
      since: mark - 1865,
      include_aux: true,
      limit: 500,
    },
  ]);
  expect(threadReads(refreshed)[0]?.["#e"]).toHaveLength(60);
  expect(refreshed.filter(windowOf("team"))).toHaveLength(1);
  expect(refreshed.filter(sampleFilter)).toHaveLength(1);
  expect(warm.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.through?.size).toBe(60);
});

it("a full read past the mark is read again in halves of its roots, each naming its own channels, and not paged", async () => {
  const a = post(peerKey, "team", T);
  const b = post(peerKey, "quiet", T + 1);
  const { storage, since } = await readThrough({
    hot: [
      ["team", a],
      ["quiet", b],
    ],
  });
  const replies = [a, b].flatMap((root, n) =>
    Array.from({ length: 300 }, (_, i) =>
      hashed(n ? "quiet" : "team", since + 1 + i, 9, [
        ["e", root.id, "", "reply"],
      ]),
    ),
  );
  const h = await launch({ store: [a, b, ...replies, ...busy], storage });
  await h.owner.capability.ensure();
  const requests = h.reader.read.mock.calls
    .map(([filters]) => threadReads(filters))
    .filter((filters) => filters.length);
  const read = (channelId: string, rootIds: string[]) => ({
    kinds: CONTENT,
    "#h": [channelId],
    "#e": rootIds,
    since,
    include_aux: true,
    limit: 500,
  });
  // Newest first.
  expect(requests).toEqual([
    [{ ...read("quiet", [b.id, a.id]), "#h": ["quiet", "team"] }],
    [read("quiet", [b.id]), read("team", [a.id])],
  ]);
  expect(h.owner.capability.inbox().partial).toBeUndefined();
});

it("a dropped read past the mark holds the mark and says some activity could not be checked, and the next pass reads it again", async () => {
  const root = post(peerKey, "team", T);
  const { storage, mark, since } = await readThrough({
    hot: [["team", root]],
  });
  let failing = true;
  const past = (filter: ReadFilter) =>
    !!filter["#e"]?.includes(root.id) && filter.since === since;
  const h = await launch({
    store: [root, reply(peerKey, "team", root, since + 5), ...busy],
    storage,
    frontiers: BUSY_READ,
    fail: (filters) => failing && filters.some(past),
  });
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  // Retried once, then dropped.
  expect(launched.filter(past)).toHaveLength(2);
  expect(ownReads(launched)).toEqual([]);
  expect(h.owner.capability.inbox().partial).toBe(true);
  await h.saved;
  expect((await storage.read())?.mark).toEqual(mark);
  failing = false;
  const refreshed = await sentDuring(h, () => h.owner.capability.refresh());
  expect(refreshed.filter(past)).toHaveLength(1);
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.mark?.checked).toBeGreaterThan(mark.checked);
});

it("a remembered thread not read through since the mark, whose newest time predates the mark less 1,865 s, is read since that time on its own beside the read past the mark", async () => {
  const hot = Array.from({ length: 50 }, (_, i): [string, RelayEvent] => [
    "team",
    post(peerKey, "team", T + 10 + i),
  ]);
  const kept = post(peerKey, "quiet", T + 1);
  const learned = post(peerKey, "quiet", T);
  const { storage, since } = await readThrough({
    hot,
    cold: [["quiet", kept]],
    owed: [["quiet", learned]],
  });
  const h = await launch({
    store: [...hot.map(([, root]) => root), kept, learned, ...busy],
    storage,
    frontiers: BUSY_READ,
  });
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  const reads = threadReads(launched);
  const past = reads.filter((filter) => filter.since === since);
  expect(past).toEqual([
    expect.objectContaining({ "#h": ["team", "quiet"], limit: 500 }),
  ]);
  expect(new Set(past[0]?.["#e"])).toEqual(
    new Set([...hot.map(([, root]) => root.id), kept.id]),
  );
  expect(ownReads(launched)).toEqual([
    {
      kinds: CONTENT,
      "#h": ["quiet"],
      "#e": [learned.id],
      since: T,
      include_aux: true,
      limit: 50,
    },
  ]);
  expect((await storage.read())?.through?.has(`quiet:${learned.id}`)).toBe(
    true,
  );
});

it("a read by ID asks 50 IDs a filter at most: the roots replies lack, and the marked messages whose channel is not known", async () => {
  const roots = Array.from({ length: 120 }, (_, i) =>
    post(peerKey, "team", T + i),
  );
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: {
      roots: new Map(
        roots.map((root) => [`team:${root.id}`, { at: root.created_at }]),
      ),
    },
    events: [],
    structure: new Set(),
    complete: false,
  });
  // Unknown marked messages, covered by the team channel's mark.
  const marks = Array.from({ length: 60 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const h = await launch({
    store: [
      ...roots,
      ...roots.map((root, i) => reply(peerKey, "team", root, T + 1000 + i)),
      ...busy,
    ],
    storage,
    frontiers: {
      ...BUSY_READ,
      team: T + 2000,
      ...Object.fromEntries(marks.map((id) => [`msg:${id}`, T])),
    },
  });
  await h.owner.capability.ensure();
  const asked = () =>
    h.reader.read.mock.calls.flatMap(([filters]) =>
      filters.flatMap((filter) => (filter.ids ? [filter] : [])),
    );
  await vi.waitFor(() =>
    expect(
      asked()
        .filter((filter) => !filter.include_aux)
        .flatMap((filter) => filter.ids ?? []),
    ).toHaveLength(60),
  );
  const fetched = asked()
    .filter((filter) => filter.include_aux)
    .flatMap((filter) => filter.ids ?? []);
  expect(new Set(fetched)).toEqual(new Set(roots.map((root) => root.id)));
  expect(Math.max(...asked().map((filter) => filter.ids?.length ?? 0))).toBe(
    50,
  );
});

it("restored evidence discarded after a full repair from the mark asked its threads past it has them read again on their own, so the reply that read passed over still counts", async () => {
  const { root, store } = discardable();
  // Newer traffic moves the mark past the thread's unread answer.
  const later = [...store, post(peerKey, "busy", T + 5000)];
  const storage = await tamperedLate(later);
  const record = await storage.read();
  expect(record?.through).toEqual(new Set([`team:${root.id}`]));
  const since = (record?.mark?.at ?? 0) - 1865;
  expect(since).toBeGreaterThan(T + 2);
  const past = (filter: ReadFilter) =>
    !!filter["#e"]?.includes(root.id) && filter.since === since;
  const sent = (h: Launch) =>
    h.reader.read.mock.calls.flatMap(([filters]) => filters);
  const release = holdRestore();
  // Refresh on launch reads the bootstrap from the mark while restore still
  // verifies.
  const h = await launch({ store: later, storage });
  let launched: Promise<void> | undefined;
  try {
    launched = h.owner.capability.refresh();
    await vi.waitFor(() => expect(sent(h).filter(past)).toHaveLength(1));
  } finally {
    release();
  }
  await launched;
  expect(sent(h).filter(past)).toHaveLength(1);
  expect(sent(h).filter(wholeOf(root.id))).toHaveLength(1);
  expect(h.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
});

// A thread whose restored reply is forgotten is read whole or on its own
// again: read past the mark alone, a reply older than it would be lost.
it.each([
  ["a full repair from a mark confirmed over a day ago", 86_401, 1001],
  // Fresh, so the full repair reads past the mark.
  [
    "a catch-up still full at its last page, read in full from its mark",
    60,
    3000,
  ],
] as const)(
  "restored evidence forgotten by %s, whose roster sample drops and whose edits since the mark are more than its read of deletions takes, leaves its thread read neither whole nor through: the next launch reads it whole and the unread reply counts",
  async (_, age, edited) => {
    const root = post(viewerKey, "team", T);
    const answer = reply(peerKey, "team", root, T + 2);
    const key = `team:${root.id}`;
    const at = SECONDS - 600;
    const storage = memoryUnreadStorage();
    await storage.save({
      participation: { roots: new Map([[key, { at: T }]]) },
      events: [root, answer],
      structure: new Set(),
      complete: true,
      mark: { at, checked: SECONDS - age },
      roster: new Set(ROSTER),
      whole: new Set([key]),
      through: new Set([key]),
    });
    // Newer posts fill team's window above the answer; they are saved, so
    // signed. The edits are of a message no longer held.
    const newer = Array.from({ length: 101 }, (_, i) =>
      post(peerKey, "team", at + 1 + i),
    );
    const edits = Array.from({ length: edited }, (_, i) =>
      hashed("team", at + 200 + i, 40003, [["e", "f".repeat(64)]]),
    );
    const store = [root, answer, ...newer, ...edits];
    const first = await launch({ store, storage, fail: sampleRead });
    await first.owner.capability.ensure();
    await first.saved;
    first.owner.dispose();
    const h = await launch({ store, storage });
    const launched = await sentDuring(h, () => h.owner.capability.ensure());
    expect(launched.filter(wholeOf(root.id))).toHaveLength(1);
    expect(h.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
    );
  },
);

it("a full repair from a mark confirmed more than a day ago reads each remembered thread on its own, none past the mark", async () => {
  const hot = Array.from({ length: 50 }, (_, i): [string, RelayEvent] => [
    "team",
    post(peerKey, "team", T + 10 + i),
  ]);
  const cold = post(peerKey, "quiet", T);
  const { storage, since } = await readThrough({
    hot,
    cold: [["quiet", cold]],
    checked: SECONDS - 25 * 3600,
  });
  const h = await launch({
    store: [...hot.map(([, root]) => root), cold, ...busy],
    storage,
    frontiers: BUSY_READ,
  });
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  const reads = threadReads(launched);
  expect(reads.filter((filter) => filter.since === since)).toEqual([]);
  expect(
    new Set(
      reads
        .filter((filter) => filter.since === undefined)
        .flatMap((filter) => filter["#e"] ?? []),
    ),
  ).toEqual(new Set(hot.map(([, root]) => root.id)));
  expect(ownReads(launched).filter((filter) => filter.since)).toEqual([
    {
      kinds: CONTENT,
      "#h": ["quiet"],
      "#e": [cold.id],
      since: T,
      include_aux: true,
      limit: 50,
    },
  ]);
});

// The hot threads' replies are admitted, so the budget refuses the rest;
// the cold ones' are read and older than their thread's newest time, so are
// passed over and none is refused.
it.each([
  ["hot threads", false],
  ["cold threads whose replies are read", true],
] as const)(
  "a read past the mark of %s still full after eight splits is dropped there: its threads are no longer read through, the mark stays, the Inbox says so, and the next full repair reads each of them on its own",
  async (_, read) => {
    const { since } = await readThrough({});
    // Ranked below 50 hotter threads that have no replies.
    const hotter = read
      ? Array.from({ length: 50 }, (_, i): [string, RelayEvent] => [
          "quiet",
          post(peerKey, "quiet", since + 400 + i),
        ])
      : [];
    const roots = Array.from({ length: 10 }, (_, i): [string, RelayEvent] => [
      "team",
      post(peerKey, "team", read ? since + 300 + i : T + i),
    ]);
    const { storage, mark } = await readThrough(
      read ? { hot: hotter, cold: roots } : { hot: roots },
    );
    // Any two of them have more replies since the mark than a page holds, so
    // every read of more than one is split.
    const replies = roots.flatMap(([, root]) =>
      Array.from({ length: 251 }, (_, i) =>
        hashed("team", since + 1 + i, 9, [["e", root.id, "", "reply"]]),
      ),
    );
    const h = await launch({
      store: [
        ...[...hotter, ...roots].map(([, root]) => root),
        ...replies,
        ...busy,
      ],
      storage,
      frontiers: { ...BUSY_READ, team: SECONDS },
    });
    const past = (filter: ReadFilter) =>
      !!filter["#e"] && filter.since === since;
    const from = h.reader.read.mock.calls.length;
    await h.owner.capability.ensure();
    const requests = h.reader.read.mock.calls
      .slice(from)
      .map(([filters]) => filters.filter(past))
      .filter((filters) => filters.length);
    // The read and its eight splits.
    expect(requests).toHaveLength(9);
    // The roots of a read of many whose page is full and that is not split.
    const filters = requests.flat();
    const capped = filters.flatMap((filter) => {
      const ids = filter["#e"] ?? [];
      const page = replies.filter((event) =>
        event.tags.some(([name, id]) => name === "e" && ids.includes(id ?? "")),
      ).length;
      const split = filters.some(
        (other) =>
          (other["#e"]?.length ?? 0) < ids.length &&
          other["#e"]?.every((id) => ids.includes(id)),
      );
      return ids.length > 1 && page >= filter.limit && !split ? ids : [];
    });
    expect(capped).not.toEqual([]);
    expect(h.owner.capability.inbox().partial).toBe(true);
    await h.saved;
    const record = await storage.read();
    expect(record?.mark).toEqual(mark);
    expect(record?.through).toEqual(
      new Set(
        [...hotter, ...roots]
          .filter(([, root]) => !capped.includes(root.id))
          .map(([channelId, root]) => `${channelId}:${root.id}`),
      ),
    );
    const refreshed = await sentDuring(h, () => h.owner.capability.refresh());
    expect(
      new Set(
        threadReads(refreshed)
          .filter((filter) => !past(filter))
          .flatMap((filter) => filter["#e"] ?? []),
      ),
    ).toEqual(new Set(capped));
    expect(
      refreshed
        .filter(past)
        .flatMap((filter) => filter["#e"] ?? [])
        .filter((id) => capped.includes(id)),
    ).toEqual([]);
    expect(h.owner.capability.inbox().partial).toBeUndefined();
  },
);

it("a catch-up that ends while the channel list is still being read leaves the walk mark, so a channel that read then lists is walked from it and the viewer's reply there is remembered", async () => {
  const walked = SECONDS - 1000;
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: { roots: new Map(), walk: { since: walked } },
    events: [],
    structure: new Set(),
    complete: true,
    mark: { at: SECONDS - 600, checked: SECONDS - 60 },
    roster: new Set(ROSTER),
  });
  const store: RelayEvent[] = [];
  let settled = true;
  // The viewer reads `added` on another device after replying there.
  const h = await launch({
    store,
    storage,
    frontiers: { added: SECONDS - 350 },
    rosterSettled: () => settled,
  });
  await h.owner.capability.ensure();
  // While away the viewer was added to `added` and replied there, then
  // posted in team; busier channels' newer traffic keeps the reply out of
  // the roster's newest events.
  const root = post(peerKey, "added", SECONDS - 500);
  const mine = reply(viewerKey, "added", root, SECONDS - 400);
  store.push(
    root,
    mine,
    ...Array.from({ length: 500 }, (_, i) =>
      hashed("busy", SECONDS - 390 + (i % 50)),
    ),
    post(viewerKey, "team", SECONDS - 300),
  );
  // A reconnect's catch-up ends before the channel list read beside it.
  settled = false;
  await h.reconnected();
  expect((await storage.read())?.participation.walk).toEqual({
    since: walked,
  });
  settled = true;
  h.roster(summaries([...ROSTER, "added"]));
  await h.owner.capability.ensure();
  expect(
    (await storage.read())?.participation.roots.has(`added:${root.id}`),
  ).toBe(true);
});

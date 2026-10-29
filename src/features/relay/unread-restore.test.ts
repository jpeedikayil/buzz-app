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

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});

/** One launch against a relay holding `store`: its query returns each
 * filter's newest matches, leaves deleted events out, and, as the relay
 * does, attaches edits and deletions only to top-level and depth-limited
 * reads, which the repair does not send. `down` fails every evidence read,
 * `fail` the ones it matches. */
async function launch({
  store,
  storage,
  frontiers = {},
  follows = memoryThreadFollows(),
  roster = ["team", "quiet", "dm", "busy"].map(
    (id): ChannelSummary => ({
      id,
      name: id,
      members: [viewer],
      ...(id === "dm" ? { channelType: "dm" as const } : {}),
    }),
  ),
  down = false,
  fail = () => false,
}: {
  store: readonly RelayEvent[];
  storage: UnreadStorage;
  frontiers?: Readonly<Record<string, number>>;
  follows?: ReturnType<typeof memoryThreadFollows>;
  roster?: readonly ChannelSummary[];
  down?: boolean;
  fail?: (filters: readonly ReadFilter[]) => boolean;
}) {
  const tagged = (item: RelayEvent, name: string, values: readonly string[]) =>
    item.tags.some(
      ([tag, value]) => tag === name && values.includes(value ?? ""),
    );
  let held: Promise<void> | undefined;
  let waiting: (filters: readonly ReadFilter[]) => void = () => {};
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      if (filters.some((filter) => filter.kinds?.includes(9))) {
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
              (!filter["#h"] || tagged(item, "h", filter["#h"])) &&
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
    now: () => NOW,
  });
  owners.push(owner);
  return {
    owner,
    reader,
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
    /** Evidence reads wait until `release`; `waiting` resolves with the
     * first that does. */
    hold() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = resolve;
      });
      const first = new Promise<readonly ReadFilter[]>((resolve) => {
        waiting = resolve;
      });
      return { release, waiting: first };
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
  expect(online.reader.read.mock.calls.flat(2)).toContainEqual(
    expect.objectContaining({ "#h": ["team"], "#e": [root.id] }),
  );
  expect(online.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
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

it("a full window's cut is its own limit-th match, not an older match another filter of the request returned", async () => {
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
  expect(await saved(storage)).toEqual(
    expect.arrayContaining(unread.map(({ id }) => id)),
  );
  // While the device was closed, busier traffic moved the roster sample on,
  // and the oldest unread message was deleted.
  const [oldest] = unread as [RelayEvent];
  const removal = deletion(peerKey, "team", oldest);
  store.push(...busy, removal);
  const warm = await launch({ store, storage, frontiers });
  const save = vi.spyOn(storage, "save");
  await warm.owner.capability.ensure();
  expect(warm.reader.read.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ authors: [viewer] }),
      expect.objectContaining({ "#h": ["team"], since: T, limit: 100 }),
    ]),
  );
  // Saved once restore and every reconcile are done. The window returned
  // the newest 100 beside the authored page's older match: the 30 below its
  // cut are not judged, so the deleted one stays until its deletion arrives.
  await warm.saved;
  expect(warm.count("team")).toBe(130);
  expect(await saved(storage)).toEqual(
    expect.arrayContaining(unread.map(({ id }) => id)),
  );
  warm.owner.accept([removal]);
  expect(warm.count("team")).toBe(129);
  await warm.owner.capability.refresh();
  await save.mock.results.at(-1)?.value;
  expect(await saved(storage)).not.toContain(oldest.id);
  expect(await saved(storage)).not.toContain(removal.id);
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
  const storage = memoryUnreadStorage();
  await storage.save(thread.record);
  // Read replies also sent to the channel, in threads the viewer is not
  // part of, each looked up for its root and none kept by a save: `first`,
  // then more than the structure cache holds besides. Unsigned, as only a
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
  const roots = Array.from({ length: 1100 }, (_, i) =>
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

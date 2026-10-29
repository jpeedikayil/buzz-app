import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { ReadFilter, RelayEvent } from "./events";
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
 * reads, which the repair does not send. `down` fails every evidence read. */
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
}: {
  store: readonly RelayEvent[];
  storage: UnreadStorage;
  frontiers?: Readonly<Record<string, number>>;
  follows?: ReturnType<typeof memoryThreadFollows>;
  roster?: readonly ChannelSummary[];
  down?: boolean;
}) {
  const tagged = (item: RelayEvent, name: string, values: readonly string[]) =>
    item.tags.some(
      ([tag, value]) => tag === name && values.includes(value ?? ""),
    );
  const deleted = (item: RelayEvent) =>
    store.some(
      (other) =>
        other.kind === 5 &&
        other.pubkey === item.pubkey &&
        tagged(other, "e", [item.id]),
    );
  let held: Promise<void> | undefined;
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        await held;
        if (down) throw new Error("Relay read timed out");
      }
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
  const owner = createUnread({
    reads,
    channels,
    reader,
    viewer,
    follows,
    storage,
    now: () => NOW,
  });
  owners.push(owner);
  return {
    owner,
    reader,
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
    /** Evidence reads wait until the returned release. */
    hold() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = resolve;
      });
      return release;
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
  // A lost thread: the viewer replied long ago, and only the thread reads
  // reach it; its unread answer was edited.
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
  fresh.owner.accept([asked, mention]);
  await fresh.owner.capability.ensure();
  fresh.owner.accept([edit]);
  await fresh.owner.capability.refresh();
  fresh.owner.dispose();
  const warm = await launch({ store, storage, frontiers, follows });
  await warm.owner.capability.ensure();
  const expected = [
    { rootId: lost.id, unreadCount: 1, preview: "edited" },
    { rootId: asked.id, unreadCount: 0 },
    { rootId: followed.id, unreadCount: 1 },
    { rootId: started.id, unreadCount: 1 },
    { channelId: "dm", unreadCount: 1 },
  ];
  await vi.waitFor(() =>
    expect(warm.owner.capability.inbox().items).toEqual(
      expect.arrayContaining(
        expected.map((row) => expect.objectContaining(row)),
      ),
    ),
  );
  expect(warm.count("quiet")).toBe(1);
  const rows = warm.rows();
  const shown = rows.flatMap((row) => row.messageIds);
  await vi.waitFor(async () =>
    expect(await saved(storage)).toEqual(expect.arrayContaining(shown)),
  );
  expect((await storage.read())?.complete).toBe(true);
  warm.owner.dispose();
  // The relay cannot be read: the rows and counts come from storage alone,
  // verified as the channel heads' restore is.
  cpu.mockClear();
  const offline = await launch({
    store,
    storage,
    frontiers,
    follows,
    down: true,
  });
  await offline.owner.capability.ensure();
  await vi.waitFor(() =>
    expect(offline.rows()).toEqual(expect.arrayContaining(rows)),
  );
  expect(offline.count("quiet")).toBe(1);
  expect(
    cpu.mock.calls
      .filter(([stage]) => stage === "verify.restore")
      .reduce((total, [, , count]) => total + count, 0),
  ).toBe((await saved(storage)).length);
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
  await vi.waitFor(() =>
    expect(fresh.owner.capability.inbox().items).toContainEqual(row),
  );
  fresh.owner.dispose();
  expect(await saved(storage)).not.toContain(cold.root.id);
  // Neither a warm repair nor what it restores lists it again.
  const warm = await launch({ store, storage, frontiers });
  await warm.owner.capability.ensure();
  expect(warm.owner.capability.inbox().items).not.toContainEqual(row);
  expect(warm.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: threads.at(-1)?.root.id }),
  );
  warm.owner.dispose();
  const offline = await launch({ store, storage, frontiers, down: true });
  await offline.owner.capability.ensure();
  await vi.waitFor(() =>
    expect(offline.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({ rootId: threads.at(-1)?.root.id }),
    ),
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
  // Nothing is restored, not even the events that verify.
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
  await vi.waitFor(async () =>
    expect(await over.read()).toMatchObject({ events: [], complete: false }),
  );
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
  const release = second.hold();
  const repair = second.owner.capability.ensure();
  try {
    await vi.waitFor(() =>
      expect(second.reader.read.mock.calls.flat(2)).toContainEqual(
        expect.objectContaining({ authors: [viewer] }),
      ),
    );
    second.owner.accept(later);
  } finally {
    release();
  }
  await repair;
  expect(second.owner.event(authored.id)).toBeUndefined();
  await vi.waitFor(async () =>
    expect((await dropped.read())?.events).toHaveLength(busy.length),
  );
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
  await vi.waitFor(() => expect(thread(early)).toContain(answers.at(-1)?.id));
  expect(thread(early)).not.toContain(gone.id);
  await vi.waitFor(async () =>
    expect(await saved(storage)).not.toContain(gone.id),
  );
  early.owner.dispose();
  // Reads that land once it is in.
  store.push(deletion(peerKey, "team", alsoGone));
  const late = await launch({ store, storage });
  const release = late.hold();
  const repair = late.owner.capability.ensure();
  try {
    await vi.waitFor(() => expect(thread(late)).toContain(alsoGone.id));
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
  first.owner.dispose();
  expect(await saved(storage)).toContain(direct.id);
  // The roster starts from the downloaded membership; the repair reads, and
  // saves, the confirmed channel alone.
  const next = await launch({
    store: store.slice(1),
    storage,
    roster: channels(true),
  });
  const save = vi.spyOn(storage, "save");
  await next.owner.capability.ensure();
  await vi.waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 20_000 });
  expect(await saved(storage)).toContain(direct.id);
  next.roster(channels(false));
  await vi.waitFor(() =>
    expect(next.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({ channelId: "dm", messageIds: [direct.id] }),
    ),
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
  await vi.waitFor(async () =>
    expect(
      (await memory.read())?.participation.roots.get(`team:${root.id}`),
    ).toMatchObject({ at: root.created_at }),
  );
  expect(save).toHaveBeenCalledTimes(3);
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
  await vi.waitFor(() => expect(save).toHaveBeenCalled());
  expect(warm.count("team")).toBe(130);
  expect(await saved(storage)).toEqual(
    expect.arrayContaining(unread.map(({ id }) => id)),
  );
  warm.owner.accept([removal]);
  expect(warm.count("team")).toBe(129);
  await warm.owner.capability.refresh();
  await vi.waitFor(async () =>
    expect(await saved(storage)).not.toContain(oldest.id),
  );
  expect(await saved(storage)).not.toContain(removal.id);
});

it("a root a lookup fetched is restored as structure: it groups the mention and never counts", async () => {
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
  store.push(mention);
  first.owner.accept([mention]);
  await vi.waitFor(() =>
    expect(first.owner.capability.inbox().items).toContainEqual(row),
  );
  await first.owner.capability.refresh();
  expect(first.owner.event(old.id)).toBeUndefined();
  await vi.waitFor(async () =>
    expect((await storage.read())?.structure).toEqual(new Set([old.id])),
  );
  expect(await saved(storage)).toEqual(
    expect.arrayContaining([old.id, mention.id]),
  );
  first.owner.dispose();
  const offline = await launch({ store, storage, frontiers, down: true });
  await offline.owner.capability.ensure();
  await vi.waitFor(() =>
    expect(offline.owner.capability.inbox().items).toContainEqual(row),
  );
  expect(offline.count("team")).toBe(0);
  expect(offline.owner.event(old.id)).toBeUndefined();
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
  await vi.waitFor(async () =>
    expect(await saved(memory)).toContain(answer.id),
  );
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
  h.owner.clear();
  release();
  await repair.catch(() => {});
  expect(h.owner.capability.inbox().items).toEqual([]);
  expect(await storage.read()).toEqual({
    participation: { roots: new Map() },
    events: [],
    structure: new Set(),
    complete: false,
  });
});

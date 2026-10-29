import { verifiedSymbol } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries } from "./contracts";
import type { ReadFilter, RelayEvent } from "./events";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import {
  NO_THREAD_PARTICIPATION,
  type ThreadMark,
  type ThreadParticipation,
} from "./thread-participation";
import { createUnread } from "./unread";
import { memoryUnreadStorage, type UnreadStorage } from "./unread-storage";

// Repair's evidence reads: per-channel windows since each channel's read mark
// and the participation pass that refetches the viewer's threads. Events are
// marked verified instead of signed, as in unread-lookups.test.ts.
let next = 0;
function event(
  channelId: string,
  pubkey: string,
  created_at: number,
  tags: string[][] = [],
  content = "",
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind: 9,
    created_at,
    content,
    tags: [["h", channelId], ...tags],
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const reply = (
  channelId: string,
  pubkey: string,
  time: number,
  root: RelayEvent,
  tags: string[][] = [],
) => event(channelId, pubkey, time, [["e", root.id, "", "reply"], ...tags]);
const viewer = "a".repeat(64),
  peer = "b".repeat(64);
const flood = (channelId: string, count: number, from: number) =>
  Array.from({ length: count }, (_, i) => event(channelId, peer, from + i));
const NOW = 10_000_000;
// The threads storage holds for the next launch, and a record seeding them.
const remembered = async (storage: UnreadStorage) =>
  (await storage.read())?.participation ?? NO_THREAD_PARTICIPATION;
const remember = (storage: UnreadStorage, participation: ThreadParticipation) =>
  storage.save({ participation, events: [], complete: false });

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function setup({
  channels: ids,
  frontiers,
  storage = memoryUnreadStorage(),
  authoredPage = true,
  sampled = true,
  localUnread = {},
}: {
  channels: readonly string[];
  frontiers: Readonly<Record<string, number>>;
  storage?: UnreadStorage;
  // Whether the viewer's newest authored page still reaches their old replies.
  authoredPage?: boolean;
  // Whether the roster sample still reaches this history; busier channels
  // move it past a quiet channel within hours, which windows and thread reads
  // do not depend on.
  sampled?: boolean;
  // Messages marked unread on this device, which a relaunch keeps.
  localUnread?: Readonly<Record<string, number>>;
}) {
  const store: RelayEvent[] = [];
  // Channels whose window requests fail: every time, or only the first.
  const failing = new Set<string>();
  const transient = new Set<string>();
  // Channels whose window requests wait for release.
  const held = new Map<string, Promise<void>>();
  const tagged = (item: RelayEvent, name: string, values: readonly string[]) =>
    item.tags.some(
      ([tag, value]) => tag === name && values.includes(value ?? ""),
    );
  // The roster sample: the newest across channels, with no start.
  const sample = (filter: ReadFilter) =>
    !!filter["#h"] && !filter["#e"] && filter.since === undefined;
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      // The roster sample fails or waits as the "sample" channel would.
      const windows = filters.flatMap((filter) =>
        sample(filter) ? ["sample"] : (filter["#h"] ?? []),
      );
      // The walk's pages beyond the first fail as the "walk" channel would,
      // and single-root `since` thread reads as "cold".
      if (filters.some((filter) => filter.until !== undefined))
        windows.push("walk");
      if (
        filters.some(
          (filter) => filter.since !== undefined && filter["#e"]?.length === 1,
        )
      )
        windows.push("cold");
      await Promise.all(windows.map((id) => held.get(id)));
      if (windows.some((id) => failing.has(id)))
        throw new Error("Relay read timed out");
      if (windows.some((id) => transient.delete(id)))
        throw new DOMException("Relay read timed out", "TimeoutError");
      return filters.flatMap((filter) => {
        if (filter.authors && !filter["#e"] && !authoredPage) return [];
        if (sample(filter) && !sampled) return [];
        // `until` is exclusive at the keyset cursor, as the relay's is.
        const before = (item: RelayEvent) =>
          filter.until === undefined ||
          item.created_at < filter.until ||
          (item.created_at === filter.until &&
            (filter.before_id === undefined || item.id > filter.before_id));
        const matched = store
          .filter(
            (item) =>
              (!filter.kinds || filter.kinds.includes(item.kind)) &&
              (!filter.ids || filter.ids.includes(item.id)) &&
              (!filter.authors || filter.authors.includes(item.pubkey)) &&
              (filter.since === undefined || item.created_at >= filter.since) &&
              before(item) &&
              (!filter["#h"] || tagged(item, "h", filter["#h"])) &&
              (!filter["#e"] || tagged(item, "e", filter["#e"])),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
        // `include_aux`: the relay adds the deletions of what matched.
        const ids = matched.map((item) => item.id);
        return filter.include_aux
          ? [
              ...matched,
              ...store.filter(
                (item) => item.kind === 5 && tagged(item, "e", ids),
              ),
            ]
          : matched;
      });
    }),
  };
  let journal: ReadJournal | undefined = {
    ...newReadJournal(),
    state: { frontiers, overrides: {} },
    localUnread: { ...localUnread },
    // A saved mark's revision is at most the journal's.
    revision: Math.max(0, ...Object.values(localUnread)),
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
  const channels: ChannelQueries = {
    list: () => ({
      status: "ready" as const,
      channels: ids.map((id) => ({ id, name: id, members: [viewer] })),
    }),
    subscribeList: () => () => {},
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
    storage,
    now: () => NOW * 1000,
  });
  owners.push(owner);
  const filters = () => reader.read.mock.calls.flatMap(([filters]) => filters);
  const hold = (channelId: string) => {
    let release = () => {};
    held.set(
      channelId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  };
  return {
    owner,
    store,
    reader,
    filters,
    failing,
    transient,
    hold,
    storage,
  };
}

it("a thread the viewer replied in outlives its channel's later traffic and a busier channel", async () => {
  const h = await setup({
    channels: ["quiet", "busy"],
    // The viewer read the quiet channel through their own reply, and the
    // busy channel long ago.
    frontiers: { quiet: 1015, busy: 1500 },
  });
  const root = event("quiet", peer, 1000);
  const mine = reply("quiet", viewer, 1010, root);
  const answers = [1020, 1030, 1040].map((time) =>
    reply("quiet", peer, time, root),
  );
  // Later top-level traffic fills the quiet channel's one-page window, and
  // the busy channel holds far more than the roster sample.
  h.store.push(root, mine, ...answers, ...flood("quiet", 120, 1100));
  h.store.push(...flood("busy", 600, 2000));
  await h.owner.capability.ensure();
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({ status: "ready", freshness: "observed" });
  const thread = inbox.items.find((item) => item.rootId === root.id);
  assert(thread, "the thread row is missing");
  expect(thread).toMatchObject({ channelId: "quiet", unreadCount: 3 });
  expect(thread.messageIds).toEqual(
    expect.arrayContaining(answers.map((answer) => answer.id)),
  );
  // Windows are read per channel since its own mark; the thread came from
  // the viewer's authored page and one `#e` read of its root.
  const windows = h.filters().filter((filter) => filter.since !== undefined);
  expect(windows).toEqual([
    expect.objectContaining({ "#h": ["busy"], since: 1500, limit: 100 }),
    expect.objectContaining({ "#h": ["quiet"], since: 1015, limit: 100 }),
  ]);
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["quiet"], "#e": [root.id] }),
  );
});

it("an unread reply below a channel's catch-up mark, in a thread the viewer started, is in the Inbox and stays after the sample moves on", async () => {
  const storage = memoryUnreadStorage();
  // The channel was only scrolled to its end, so its one mark is the
  // catch-up mark, which reads no replies; the viewer has written much
  // since, so their authored page no longer reaches the root.
  const launch = (sampled: boolean) =>
    setup({
      channels: ["c0"],
      frontiers: { "activity:c0": 3000 },
      storage,
      authoredPage: false,
      sampled,
    });
  const root = event("c0", viewer, 1000);
  const answer = reply("c0", peer, 2000, root);
  const history = [root, answer, event("c0", peer, 3000)];
  const row = (h: Awaited<ReturnType<typeof launch>>) =>
    h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
  const first = await launch(true);
  first.store.push(...history);
  await first.owner.capability.ensure();
  // The window starts at the mark, after the reply; the roster sample,
  // with no start, holds it.
  expect(first.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], since: 3000 }),
  );
  expect(row(first)).toMatchObject({ unreadCount: 1, messageIds: [answer.id] });
  expect(first.owner.capability.attention("c0", answer.id)).toMatchObject({
    status: "eligible",
    category: "thread",
    unread: true,
  });
  // The thread is remembered as of its root, so a launch after busier
  // channels have moved the sample on still reads the reply.
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1000,
    newestId: root.id,
  });
  first.owner.dispose();
  const second = await launch(false);
  second.store.push(...history);
  await second.owner.capability.ensure();
  await vi.waitFor(() =>
    expect(row(second)).toMatchObject({
      unreadCount: 1,
      messageIds: [answer.id],
    }),
  );
});

it("the roster sample keeps a read mention older than its channel's mark and a mention older than a never-read channel's week", async () => {
  const h = await setup({
    channels: ["read", "never"],
    frontiers: { read: 5000 },
  });
  const floor = NOW - 7 * 24 * 60 * 60;
  const read = event("read", peer, 4000, [["p", viewer]]);
  const old = event("never", peer, floor - 86400, [["p", viewer]]);
  h.store.push(read, old);
  await h.owner.capability.ensure();
  const items = h.owner.capability.inbox().items;
  expect(items).toContainEqual(
    expect.objectContaining({ messageId: read.id, unreadCount: 0 }),
  );
  expect(items).toContainEqual(
    expect.objectContaining({ messageId: old.id, unreadCount: 1 }),
  );
});

it("a read mention whose root the windows dropped groups under its fetched root, and its thread is read in the same repair", async () => {
  const storage = memoryUnreadStorage();
  const save = vi.spyOn(storage, "save");
  const h = await setup({
    channels: ["c0", "own"],
    // The catch-up mark is older than the read mark, so the window reaches
    // the read mention; its root is older still.
    frontiers: { c0: 1100, "activity:c0": 1010 },
    storage,
  });
  const root = event("c0", peer, 1000);
  const mention = reply("c0", peer, 1020, root, [["p", viewer]]);
  h.store.push(root, mention, ...flood("c0", 80, 1100));
  // A full authored page keeps the walk, and so the repair, reading while
  // the mention's structure lookup lands.
  h.store.push(
    ...Array.from({ length: 100 }, (_, i) => event("own", viewer, 3000 + i)),
  );
  const release = h.hold("walk");
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() =>
      expect(h.owner.capability.inbox().items).toContainEqual(
        expect.objectContaining({
          rootId: root.id,
          messageIds: [mention.id],
          unreadCount: 0,
        }),
      ),
    );
  } finally {
    release();
  }
  await done;
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ ids: [root.id] }),
  );
  // The fetched root hands the mention's thread to the repair, which reads
  // it and remembers it before finishing: one save, the repair's own.
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], "#e": [root.id] }),
  );
  expect(save).toHaveBeenCalledTimes(1);
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1020,
    newestId: mention.id,
  });
  // A single row names the thread; the mention is not its own row as well.
  expect(
    h.owner.capability.inbox().items.filter((item) => item.channelId === "c0"),
  ).toHaveLength(1);
});

it("a full budget evicts the busiest channel's oldest ordinary evidence, never a quiet channel's only message or the viewer's thread", async () => {
  const h = await setup({
    channels: ["quiet", "lone", "busy"],
    frontiers: { quiet: 1015, lone: 1500, busy: 1500 },
  });
  const root = event("quiet", peer, 1000);
  const mine = reply("quiet", viewer, 1010, root);
  const answer = reply("quiet", peer, 1020, root);
  const only = event("lone", peer, 1600);
  h.store.push(root, mine, answer, ...flood("quiet", 120, 1100), only);
  const windowed = flood("busy", 10, 2000);
  h.store.push(...windowed);
  await h.owner.capability.ensure();
  const inbox = () => h.owner.capability.inbox();
  const snapshot = (channelId: string) =>
    h.owner.capability.snapshot({ kind: "channel", channelId });
  const unread = (channelId: string, id: string | undefined) =>
    h.owner.capability.attention(channelId, id ?? "").unread;
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id }),
  );
  expect(snapshot("lone").observedCount).toBe(1);
  // Its window holds the quiet channel's newest 100; the roster sample, all
  // 120 of its messages and the thread.
  expect(snapshot("quiet").observedCount).toBe(121);
  // Live traffic fills the event budget. Only what goes first is evicted: the
  // busy channel's own older traffic, since it holds the most — never the
  // lone channel's one unread message, whose count would otherwise become a
  // confident zero, nor the quiet channel's evidence or the viewer's thread.
  const live = flood("busy", 4096, 3000);
  h.owner.accept(live);
  expect(inbox().freshness).toBe("observed");
  expect(inbox().error).toBeUndefined();
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  expect(snapshot("lone")).toMatchObject({
    observedCount: 1,
    coverage: "observed",
  });
  expect(snapshot("quiet").observedCount).toBe(121);
  expect(snapshot("busy").observedCount).toBe(4096 - 123 - 1);
  expect(unread("busy", live.at(-1)?.id)).toBe(true);
  expect(unread("busy", windowed[0]?.id)).toBe(false);
  expect(unread("lone", only.id)).toBe(true);
  // The byte budget evicts the same way: large live messages push out the
  // busy channel's oldest, not the other channels' evidence.
  const large = Array.from({ length: 20 }, (_, i) =>
    event("busy", peer, 9000 + i, [], "x".repeat(450_000)),
  );
  h.owner.accept(large);
  expect(snapshot("lone").observedCount).toBe(1);
  expect(snapshot("quiet").observedCount).toBe(121);
  expect(snapshot("busy").observedCount).toBeLessThan(30);
  expect(unread("busy", large.at(-1)?.id)).toBe(true);
  expect(unread("busy", live.at(-1)?.id)).toBe(false);
  // A refresh reads the windows again; what is retained stays known.
  await h.owner.capability.refresh();
  expect(snapshot("lone").observedCount).toBe(1);
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
});

it("an edit or deletion of a pinned message is admitted once pinned evidence fills the budget", async () => {
  const h = await setup({
    channels: ["c0", "c1"],
    frontiers: { c0: 1015, c1: 100 },
  });
  const lone = event("c1", peer, 500);
  h.store.push(lone);
  // Two of the viewer's threads: the older one's root and reply go first.
  const older = event("c0", peer, 1000);
  const mineOlder = reply("c0", viewer, 1010, older);
  const root = event("c0", peer, 2000);
  const mine = reply("c0", viewer, 2010, root);
  const answers = Array.from({ length: 3 }, (_, i) =>
    reply("c0", peer, 2020 + i, root),
  );
  h.store.push(older, mineOlder, root, mine, ...answers);
  await h.owner.capability.ensure();
  // Live replies in the viewer's thread fill the event budget: every retained
  // message is pinned.
  const live = Array.from({ length: 4096 - 7 }, (_, i) =>
    reply("c0", peer, 3000 + i, root),
  );
  const snapshot = (channelId: string) =>
    h.owner.capability.snapshot({ kind: "channel", channelId });
  expect(snapshot("c1").observedCount).toBe(1);
  h.owner.accept(live);
  const row = () =>
    h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
  expect(row()?.unreadCount).toBe(3 + live.length);
  // The other channel's only message went first, as nothing else was
  // ordinary; with nothing retained, it is unknown rather than zero.
  expect(snapshot("c1")).toMatchObject({
    observedCount: null,
    coverage: "unknown",
  });
  const [edited, newest] = live.slice(-2);
  assert(edited && newest);
  // The peer deletes their newest reply: the deletion is kept with its
  // target, making room ahead of it, so the reply no longer counts.
  const deletion = { ...event("c0", peer, 8000, [["e", newest.id]]), kind: 5 };
  h.owner.accept([deletion]);
  expect(h.owner.capability.attention("c0", newest.id).unread).toBe(false);
  expect(row()?.unreadCount).toBe(3 + live.length - 1);
  // And edits the one before it: the row shows the edited body.
  const edit = {
    ...event("c0", peer, 8001, [["e", edited.id]], "edited"),
    kind: 40003,
  };
  h.owner.accept([edit]);
  expect(row()).toMatchObject({
    previewMessageId: edited.id,
    preview: "edited",
  });
  expect(h.owner.capability.inbox().freshness).toBe("observed");
});

it("a window that times out once is read again in its slot and the repair completes", async () => {
  const h = await setup({
    channels: ["quiet", "busy"],
    frontiers: { quiet: 1015, busy: 1500 },
  });
  h.store.push(...flood("busy", 5, 2000));
  h.transient.add("busy");
  await h.owner.capability.ensure();
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({ status: "ready", freshness: "observed" });
  expect(inbox.partial).toBeUndefined();
  expect(inbox.error).toBeUndefined();
  expect(
    h.filters().filter((filter) => filter["#h"]?.[0] === "busy"),
  ).toHaveLength(2);
  expect(
    h.owner.capability.snapshot({ kind: "channel", channelId: "busy" }),
  ).toMatchObject({ observedCount: 5, freshness: "observed" });
});

// A roster whose windows need a second request: the first carries the
// viewer's authored page and 127 windows, most recently read first.
const filler = Array.from({ length: 125 }, (_, i) => `f${i}`);
const fillerFrontiers = Object.fromEntries(filler.map((id) => [id, 1050]));

it("a window dropped after its retry leaves its channel unknown and the Inbox partial, with the viewer's thread still read", async () => {
  // The never-read channel's window goes last, in the second request.
  const h = await setup({
    channels: ["quiet", "busy", "c2", "c3", ...filler],
    frontiers: {
      quiet: 1055,
      busy: 900,
      c2: 1200,
      c3: 1100,
      ...fillerFrontiers,
    },
  });
  const root = event("quiet", peer, 1000);
  const mine = reply("quiet", viewer, 1010, root);
  const answer = reply("quiet", peer, 1060, root);
  h.store.push(root, mine, answer, ...flood("quiet", 120, 1100));
  h.failing.add("busy");
  await h.owner.capability.ensure();
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({
    status: "ready",
    freshness: "observed",
    partial: true,
  });
  expect(inbox.error).toBeUndefined();
  expect(inbox.items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["quiet"], "#e": [root.id] }),
  );
  expect(
    h.filters().filter((filter) => filter["#h"]?.[0] === "busy"),
  ).toHaveLength(2);
  const snapshot = (channelId: string) =>
    h.owner.capability.snapshot({ kind: "channel", channelId });
  expect(snapshot("busy")).toMatchObject({
    coverage: "unknown",
    observedCount: null,
  });
  expect(snapshot("quiet").coverage).toBe("observed");
  // No automatic retry; an explicit refresh reads the channel again.
  const attempted = h.reader.read.mock.calls.length;
  await h.owner.capability.ensure();
  expect(h.reader.read).toHaveBeenCalledTimes(attempted);
  h.failing.clear();
  await h.owner.capability.refresh();
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect(snapshot("busy").coverage).toBe("observed");
});

it("reads the viewer's page with 127 windows first, remembered and newly taught threads next, then the remaining windows and the roster sample", async () => {
  const storage = memoryUnreadStorage();
  const remembered = "f".repeat(64);
  await remember(storage, {
    roots: new Map([[`c1:${remembered}`, { at: 1000 }]]),
  });
  const channels = ["never1", "c1", "c2", "c3", "never2", ...filler];
  const h = await setup({
    channels,
    frontiers: { c1: 1100, c2: 1300, c3: 1200, ...fillerFrontiers },
    storage,
  });
  // A thread the viewer replied in before c3's mark: only the authored page
  // reaches it, and its read goes ahead of the never-read windows.
  const root = event("c3", peer, 1000);
  h.store.push(root, reply("c3", viewer, 1010, root));
  await h.owner.capability.ensure();
  const requests = h.reader.read.mock.calls.map(([filters]) => filters);
  expect(requests[0]).toHaveLength(128);
  expect(requests[0]?.[0]).toMatchObject({ authors: [viewer] });
  expect(requests[0]?.slice(1, 4).map((filter) => filter["#h"]?.[0])).toEqual([
    "c2",
    "c3",
    "c1",
  ]);
  expect(requests[1]).toEqual([
    expect.objectContaining({ "#h": ["c1"], "#e": [remembered], limit: 200 }),
    expect.objectContaining({ ids: [remembered], limit: 1 }),
  ]);
  const floor = NOW - 7 * 24 * 60 * 60;
  const taught = requests.findIndex((request) =>
    request.some((filter) => filter["#e"]?.[0] === root.id),
  );
  const never = requests.findIndex((request) =>
    request.some((filter) => filter["#h"]?.[0] === "never1"),
  );
  expect(taught).toBeGreaterThan(1);
  expect(never).toBeGreaterThan(taught);
  expect(requests[never]).toEqual([
    expect.objectContaining({ "#h": ["f124"], since: 1050 }),
    expect.objectContaining({ "#h": ["never1"], since: floor }),
    expect.objectContaining({ "#h": ["never2"], since: floor }),
  ]);
  // The roster sample, one request per 128 channels, with no start.
  expect(requests.slice(never + 1)).toEqual(
    [channels.slice(0, 128), channels.slice(128)].map((ids) => [
      { kinds: [9, 40002, 40008], "#h": ids, include_aux: true, limit: 500 },
    ]),
  );
});

it("a thread read's full-page split goes ahead of the remaining windows", async () => {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["c1", "c0", ...filler, "never"],
    frontiers: { c1: 5000, c0: 4000, ...fillerFrontiers },
    storage,
  });
  const roots = [event("c1", peer, 1000), event("c1", peer, 1001)];
  await remember(storage, {
    roots: new Map(roots.map((root, i) => [`c1:${root.id}`, { at: 2000 + i }])),
  });
  // Each root has a full page of replies, so one read of both overflows.
  for (const root of roots)
    for (let i = 0; i < 200; i++)
      h.store.push(reply("c1", peer, 1100 + i, root));
  h.store.push(...roots);
  // The first request waits until the thread read has landed and queued its
  // split, so the split and the remaining window compete for the next slot.
  const release = h.hold("c0");
  const requests = () => h.reader.read.mock.calls.map(([filters]) => filters);
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() =>
      expect(
        requests().some((request) =>
          request.some((filter) => filter["#e"]?.length === 1),
        ),
      ).toBe(true),
    );
  } finally {
    release();
  }
  await done;
  const whole = requests().findIndex((request) =>
    request.some((filter) => filter["#e"]?.length === 2),
  );
  const split = requests().findIndex((request) =>
    request.some((filter) => filter["#e"]?.length === 1),
  );
  const never = requests().findIndex((request) =>
    request.some((filter) => filter["#h"]?.[0] === "never"),
  );
  expect(whole).toBe(1);
  expect(split).toBeGreaterThan(whole);
  expect(never).toBeGreaterThan(split);
  expect(requests()[split]).toEqual(
    expect.arrayContaining(
      roots.map((root) =>
        expect.objectContaining({ "#h": ["c1"], "#e": [root.id] }),
      ),
    ),
  );
});

it("a full page's split rereads count each reply once against the participation budget", async () => {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 5000 },
    storage,
  });
  // Four remembered threads of 200 replies each, all read and outside the
  // channel window. One read of the four pages full, as does each half, and
  // each root's own read returns its 200: 1,400 rows across the split tree,
  // 800 of them distinct, all within the 1,024-reply budget.
  const roots = Array.from({ length: 4 }, (_, i) =>
    event("c0", peer, 1000 + i),
  );
  await remember(storage, {
    roots: new Map(roots.map((root, i) => [`c0:${root.id}`, { at: 3000 + i }])),
  });
  for (const root of roots) {
    h.store.push(root, reply("c0", viewer, 1010, root));
    for (let i = 0; i < 199; i++)
      h.store.push(reply("c0", peer, 1100 + i, root));
  }
  await h.owner.capability.ensure();
  const items = h.owner.capability.inbox().items;
  for (const root of roots)
    expect(items).toContainEqual(
      expect.objectContaining({
        rootId: root.id,
        unreadCount: 0,
        messageIds: expect.toSatisfy(
          (ids: readonly string[]) => ids.length === 199,
        ),
      }),
    );
});

// Six remembered threads the viewer replied in, of 300 unread replies each
// outside the channel's full window and the roster sample, and 44 remembered threads with nothing:
// the hot tier, whose whole reads offer 1,194 replies to the 1,024-reply
// budget. `cold` roots are remembered behind them with the time given, so
// their reads are the last request, held until the six whole reads have
// landed; the authored page is since the walk mark, so only the viewer's
// replies in the busy threads are retained.
async function spentBudget(
  cold: readonly (readonly [RelayEvent, number])[],
  events: readonly RelayEvent[],
) {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 5000 },
    storage,
    sampled: false,
  });
  const busy = Array.from({ length: 6 }, (_, i) => event("c0", peer, 1000 + i));
  const peerReplies = new Set<string>();
  for (const [i, root] of busy.entries()) {
    h.store.push(root, reply("c0", viewer, 8500 + i, root));
    for (let j = 0; j < 300; j++) {
      const answer = reply("c0", peer, 5100 + j, root);
      peerReplies.add(answer.id);
      h.store.push(answer);
    }
  }
  h.store.push(...flood("c0", 100, 9000), ...events);
  const quiet = Array.from({ length: 44 }, (_, i): [string, ThreadMark] => [
    `c0:${"f".repeat(60)}${i.toString(16).padStart(4, "0")}`,
    { at: 6000 + i },
  ]);
  await remember(storage, {
    roots: new Map<string, ThreadMark>([
      ...quiet,
      ...busy.map((root, i): [string, ThreadMark] => [
        `c0:${root.id}`,
        { at: 7000 + i },
      ]),
      ...cold.map(([root, at]): [string, ThreadMark] => [
        `c0:${root.id}`,
        { at },
      ]),
    ]),
    walk: { since: 8000 },
  });
  const release = h.hold("cold");
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() =>
      expect(
        busy.every((root) =>
          h
            .filters()
            .some(
              (filter) =>
                filter["#e"]?.[0] === root.id &&
                filter["#e"].length === 1 &&
                filter.since === undefined,
            ),
        ),
      ).toBe(true),
    );
  } finally {
    release();
  }
  await done;
  const items = () => h.owner.capability.inbox().items;
  const busyReplies = new Set(
    items()
      .filter((item) => busy.some((root) => root.id === item.rootId))
      .flatMap((item) => item.messageIds)
      .filter((id) => peerReplies.has(id)),
  ).size;
  return { h, items, busyReplies };
}

it("a thread whose read lands after busier threads spent the budget still gets its newest unread reply", async () => {
  const root = event("c0", peer, 1000);
  const answer = reply("c0", peer, 5050, root);
  // The thread's newest reply is the viewer's, read; the one before it is a
  // peer's, unread. Its slot was kept while the busier threads read.
  const { items, busyReplies } = await spentBudget(
    [[root, 1010]],
    [
      root,
      reply("c0", viewer, 1010, root),
      answer,
      reply("c0", viewer, 5060, root),
    ],
  );
  expect(busyReplies).toBe(1023);
  await vi.waitFor(() =>
    expect(items()).toContainEqual(
      expect.objectContaining({
        rootId: root.id,
        unreadCount: 1,
        messageIds: [answer.id],
      }),
    ),
  );
});

it("each thread in a landing is given its newest unread reply before the busiest one takes the rest", async () => {
  const roots = [event("c0", peer, 1000), event("c0", peer, 1001)];
  const [talkative, quiet] = roots;
  assert(talkative && quiet);
  const answer = reply("c0", peer, 5050, quiet);
  // Two slots were kept for the two threads; newest first alone would give
  // both to the talkative thread's newer replies.
  const { items, busyReplies } = await spentBudget(
    [
      [talkative, 1020],
      [quiet, 1010],
    ],
    [
      ...roots,
      reply("c0", viewer, 1020, talkative),
      ...Array.from({ length: 40 }, (_, i) =>
        reply("c0", peer, 5100 + i, talkative),
      ),
      reply("c0", viewer, 1010, quiet),
      answer,
    ],
  );
  expect(busyReplies).toBe(1022);
  await vi.waitFor(() => {
    expect(items()).toContainEqual(
      expect.objectContaining({
        rootId: talkative.id,
        unreadCount: 1,
        messageIds: [expect.toSatisfy((id: string) => id !== answer.id)],
      }),
    );
    expect(items()).toContainEqual(
      expect.objectContaining({
        rootId: quiet.id,
        unreadCount: 1,
        messageIds: [answer.id],
      }),
    );
  });
});

it("a dropped read releases its thread's reserved slot to the reads still to land", async () => {
  const storage = memoryUnreadStorage();
  const cold = event("c0", peer, 1000);
  await coldThread(storage, "c0", cold, 1010);
  const h = await setup({
    channels: ["c0", "busy"],
    frontiers: { c0: 5000, busy: 5000 },
    storage,
    sampled: false,
  });
  h.store.push(cold, reply("c0", viewer, 1010, cold));
  // Six threads the viewer replied in after the channel's mark: the window
  // teaches them once it lands, after the cold read has been dropped, and
  // their whole reads offer 1,194 read replies to the budget.
  const busy = Array.from({ length: 6 }, (_, i) =>
    event("busy", peer, 1000 + i),
  );
  const peerReplies = new Set<string>();
  for (const [i, root] of busy.entries()) {
    h.store.push(root, reply("busy", viewer, 5500 + i, root));
    for (let j = 0; j < 300; j++) {
      const answer = reply("busy", peer, 1100 + j, root);
      peerReplies.add(answer.id);
      h.store.push(answer);
    }
  }
  h.failing.add("cold");
  const release = h.hold("busy");
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() => expect(coldReads(h, cold)).toHaveLength(2));
  } finally {
    release();
  }
  await done;
  const admitted = new Set(
    h.owner.capability
      .inbox()
      .items.filter((item) => busy.some((root) => root.id === item.rootId))
      .flatMap((item) => item.messageIds)
      .filter((id) => peerReplies.has(id)),
  );
  expect(admitted.size).toBe(1024);
});

it("a large cold set keeps at most a quarter of the budget from the hot landing, and its landing threads still each admit one reply", async () => {
  // 950 remembered threads behind the hot ones, their reads held while the
  // six whole reads land: the landings still fill three quarters of the
  // budget, rather than the 74 slots the whole cold set would leave. Five of
  // the cold threads, in the first cold request to land (the most recently
  // written in), have an unread reply each: with 822 roots still pending
  // the reserve is at its cap, but a landing root's one slot is drawn on
  // the whole budget, not on the budget less the reserve, which is spent.
  // The viewer's own reply in each, at the thread's mark, is not admitted;
  // the membership lookup finds it and the row shows.
  const cold = Array.from(
    { length: 950 },
    (_, i) => [event("c0", peer, 100 + i), 500 + i] as const,
  );
  const answered = cold.slice(945).map(([root]) => root);
  const answers = answered.map((root, i) => reply("c0", peer, 5050 + i, root));
  const { items, busyReplies } = await spentBudget(cold, [
    ...answered,
    ...answered.map((root, i) => reply("c0", viewer, 1445 + i, root)),
    ...answers,
  ]);
  expect(busyReplies).toBe(768);
  await vi.waitFor(() => {
    for (const [i, root] of answered.entries())
      expect(items()).toContainEqual(
        expect.objectContaining({
          rootId: root.id,
          unreadCount: 1,
          messageIds: [answers[i]?.id],
        }),
      );
  });
});

it("a dropped first request still lets the Inbox leave loading", async () => {
  const h = await setup({
    channels: ["c1", "c0", ...filler, "quiet"],
    frontiers: { c1: 1000, c0: 1000, ...fillerFrontiers, quiet: 900 },
  });
  h.store.push(event("quiet", peer, 1100, [["p", viewer]]));
  // The request carrying the authored page and c1 fails both reads; the
  // second request, quiet's window, lands, and so does the roster sample,
  // which names c1 first but, having no start, claims nothing of it.
  h.failing.add("c1");
  await h.owner.capability.ensure();
  expect(h.owner.capability.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
    partial: true,
    items: [expect.objectContaining({ channelId: "quiet", unreadCount: 1 })],
  });
  expect(
    h
      .filters()
      .filter(
        (filter) => filter["#h"]?.[0] === "c1" && filter.since !== undefined,
      ),
  ).toHaveLength(2);
  expect(
    h.owner.capability.snapshot({ kind: "channel", channelId: "c1" }),
  ).toMatchObject({ coverage: "unknown", observedCount: null });
});

it("replies of a thread never show as rows of their own while the repair fetches its root", async () => {
  const h = await setup({
    channels: ["other", "second"],
    frontiers: { other: 1005, second: 1000 },
  });
  // The root predates other's read mark, so the window returns the replies
  // alone; the viewer's reply in the authored page makes them the viewer's
  // conversation, and the thread read it teaches fetches the root.
  const root = event("other", peer, 1000);
  h.store.push(
    root,
    reply("other", viewer, 1010, root),
    ...Array.from({ length: 3 }, (_, i) =>
      reply("other", peer, 1020 + i, root),
    ),
    event("second", peer, 1100, [["p", viewer]]),
  );
  const counts: number[] = [];
  const inbox = () => h.owner.capability.inbox();
  h.owner.capability.subscribeInbox(() => counts.push(inbox().items.length));
  const read = h.reader.read.getMockImplementation();
  assert(read);
  h.reader.read.mockImplementation(async (filters: readonly ReadFilter[]) => {
    counts.push(inbox().items.length);
    return read(filters);
  });
  await h.owner.capability.ensure();
  expect(inbox().items).toEqual([
    expect.objectContaining({ channelId: "second", unreadCount: 1 }),
    expect.objectContaining({ rootId: root.id, unreadCount: 3 }),
  ]);
  expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  expect(
    h.filters().filter((filter) => filter["#e"]?.[0] === root.id),
  ).toHaveLength(1);
});

it("a first run with a large roster sizes each window so the pass fits the budget, and a quiet channel's mention survives", async () => {
  const ids = Array.from({ length: 41 }, (_, i) => `c${i}`);
  const h = await setup({ channels: ids, frontiers: {} });
  const floor = NOW - 7 * 24 * 60 * 60;
  const mention = event("c0", peer, floor + 10, [["p", viewer]]);
  h.store.push(mention);
  for (let i = 1; i < ids.length; i++)
    h.store.push(...flood(`c${i}`, 100, floor + 1000 * i));
  await h.owner.capability.ensure();
  const windows = h.filters().filter((filter) => filter.since !== undefined);
  expect(windows).toHaveLength(41);
  // floor(3072 / 41): forty pages of 74 and the mention all fit in 4,096.
  for (const window of windows)
    expect(window).toMatchObject({ since: floor, limit: 74 });
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({ status: "ready", freshness: "observed" });
  expect(inbox.items).toContainEqual(
    expect.objectContaining({
      channelId: "c0",
      messageIds: [mention.id],
      unreadCount: 1,
    }),
  );
  // A window holds its page; the roster sample adds the newest 500, the
  // five newest channels' 100 each.
  const observed = (channelId: string) =>
    h.owner.capability.snapshot({ kind: "channel", channelId }).observedCount;
  expect(observed("c35")).toBe(74);
  expect(observed("c36")).toBe(100);
  expect(observed("c40")).toBe(100);
});

it("remembers threads the viewer took part in, not every message they wrote", async () => {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 900 },
    storage,
  });
  // A one-liner nobody answered, the viewer's root a peer answered, a
  // peer's root the viewer answered, and a thread between peers.
  const note = event("c0", viewer, 1000);
  const asked = event("c0", viewer, 1010);
  const answer = reply("c0", peer, 1020, asked);
  const theirs = event("c0", peer, 1030);
  const mine = reply("c0", viewer, 1040, theirs);
  const other = event("c0", peer, 1050);
  const unrelated = reply("c0", peer, 1060, other);
  h.store.push(note, asked, answer, theirs, mine, other, unrelated);
  await h.owner.capability.ensure();
  // The walk mark is the newest message the viewer wrote. The unread answer
  // advances nothing: the viewer's root marks that thread.
  expect(await remembered(storage)).toEqual({
    roots: new Map([
      [`c0:${asked.id}`, { at: 1010, newestId: asked.id }],
      [`c0:${theirs.id}`, { at: 1040, newestId: mine.id }],
    ]),
    walk: { since: 1040 },
  });
});

it("a followed thread is remembered as of the follow and refetched", async () => {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 1100 },
    storage,
  });
  const root = event("c0", peer, 1000);
  const answer = reply("c0", peer, 1020, root);
  h.store.push(root, answer, ...flood("c0", 120, 1100));
  await h.owner.capability.ensure();
  const inbox = () => h.owner.capability.inbox();
  expect(inbox().items).not.toContainEqual(
    expect.objectContaining({ rootId: root.id }),
  );
  h.owner.capability.follow("c0", root.id, true);
  await h.owner.capability.refresh();
  expect(await remembered(storage)).toEqual({
    roots: new Map([[`c0:${root.id}`, { at: NOW }]]),
  });
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], "#e": [root.id] }),
  );
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 0 }),
  );
});

it("the Inbox leaves loading once the viewer's page and remembered threads land, observing until the windows do", async () => {
  const h = await setup({
    channels: ["c0", "c1", "c2", "c3", "c4", ...filler],
    frontiers: {
      c0: 1400,
      c1: 1300,
      c2: 1200,
      c3: 1100,
      c4: 1000,
      ...fillerFrontiers,
    },
  });
  h.store.push(event("c0", peer, 1500, [["p", viewer]]));
  const release = h.hold("c4");
  const inbox = () => h.owner.capability.inbox();
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() =>
      expect(inbox()).toMatchObject({
        status: "ready",
        freshness: "observing",
      }),
    );
    expect(inbox().items).toHaveLength(1);
  } finally {
    release();
  }
  await done;
  expect(inbox()).toMatchObject({ status: "ready", freshness: "observed" });
});

it("a read reply outside the viewer's conversations fetches only its root, never a membership lookup", async () => {
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 1100 },
    sampled: false,
  });
  const root = event("c0", peer, 1000);
  const answer = reply("c0", peer, 1020, root);
  h.store.push(root, answer, ...flood("c0", 120, 1100));
  await h.owner.capability.ensure();
  h.owner.accept([answer]);
  await vi.waitFor(() => {
    h.owner.capability.inbox();
    expect(h.filters()).toContainEqual(
      expect.objectContaining({ ids: [root.id] }),
    );
  });
  expect(
    h.filters().filter((filter) => filter.authors && filter["#e"]),
  ).toEqual([]);
});

it("remembered participation is saved and refetches the thread after the authored page moves on", async () => {
  const storage = memoryUnreadStorage();
  const save = vi.spyOn(storage, "save");
  const first = await setup({
    channels: ["c0"],
    frontiers: { c0: 1015 },
    storage,
  });
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  // A thread page of later replies: the thread read reaches none older.
  const answers = Array.from({ length: 200 }, (_, i) =>
    reply("c0", peer, 1020 + i, root),
  );
  first.store.push(root, mine, ...answers);
  await first.owner.capability.ensure();
  expect(first.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 200 }),
  );
  // Remembered as of the viewer's reply: the unread answers advance nothing.
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      participation: {
        roots: new Map([[`c0:${root.id}`, { at: 1010, newestId: mine.id }]]),
        walk: { since: 1010 },
      },
    }),
  );
  first.owner.dispose();
  // A later session: the viewer has since written a page of newer messages
  // elsewhere, so their authored page no longer reaches the old reply, which
  // the thread page ends before as well; the replies have been read since.
  const second = await setup({
    channels: ["c0"],
    frontiers: { c0: 1300 },
    storage,
    authoredPage: false,
    sampled: false,
  });
  second.store.push(...first.store);
  await second.owner.capability.ensure();
  expect(second.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], "#e": [root.id] }),
  );
  // The viewer's membership is looked up and verified, so the read thread
  // stays in the Inbox.
  await vi.waitFor(() =>
    expect(second.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({ rootId: root.id, unreadCount: 0 }),
    ),
  );
  expect(second.filters()).toContainEqual(
    expect.objectContaining({
      authors: [viewer],
      "#h": ["c0"],
      "#e": expect.arrayContaining([root.id]),
    }),
  );
});

it("a remembered thread the viewer's deleted reply joined leaves the Inbox after restart", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  await remember(storage, {
    roots: new Map([[`c0:${root.id}`, { at: 1219 }]]),
  });
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 1300 },
    storage,
    authoredPage: false,
  });
  const mine = reply("c0", viewer, 1010, root);
  const retraction = {
    ...event("c0", viewer, 1015, [["e", mine.id]]),
    kind: 5,
  };
  h.store.push(root, mine, retraction);
  for (let i = 0; i < 200; i++) h.store.push(reply("c0", peer, 1020 + i, root));
  await h.owner.capability.ensure();
  // Projecting the read replies asks for the viewer's membership; the
  // deletion rides the answer, so no witness is kept and the thread leaves.
  await vi.waitFor(() => {
    h.owner.capability.inbox();
    expect(h.filters()).toContainEqual(
      expect.objectContaining({ authors: [viewer], "#e": [root.id] }),
    );
  });
  await vi.waitFor(() =>
    expect(
      h.owner.capability.inbox().items.find((item) => item.rootId === root.id),
    ).toBeUndefined(),
  );
});

// A viewer with 140 threads behind 480 later one-liners: the newest page is
// one-liners only, so only the walk reaches the threads.
function history(h: Awaited<ReturnType<typeof setup>>) {
  const roots = Array.from({ length: 140 }, (_, i) =>
    event(i % 2 ? "b" : "a", peer, 1000 + i),
  );
  const mine = roots.map((root, i) =>
    reply(root.tags[0]?.[1] ?? "", viewer, 2000 + i, root),
  );
  const notes = Array.from({ length: 480 }, (_, i) =>
    event("a", viewer, 3000 + i),
  );
  h.store.push(...roots, ...mine, ...notes);
  return { roots, mine, notes };
}

it("a device's first repair walks the viewer's history behind the windows, remembering every thread they replied in, and reads new replies in the older ones", async () => {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["a", "b"],
    frontiers: { a: 9600, b: 9600 },
    storage,
    sampled: false,
  });
  const { roots, notes } = history(h);
  // A peer answered the oldest thread since; the others are quiet.
  const [oldest, quiet] = roots as [RelayEvent, RelayEvent];
  const answer = reply("a", peer, 9500, oldest);
  h.store.push(answer);
  await h.owner.capability.ensure();
  const requests = h.reader.read.mock.calls.map(([filters]) => filters);
  // Today's page first, then two keyset pages of 500 behind the windows:
  // the third is short, so the walk ends.
  expect(requests[0]?.[0]).toEqual({
    kinds: [9, 40002, 40008],
    authors: [viewer],
    include_aux: true,
    limit: 100,
  });
  const pages = requests.filter((request) =>
    request.some((filter) => filter.until !== undefined),
  );
  expect(pages).toEqual([
    [
      expect.objectContaining({
        authors: [viewer],
        until: 3380,
        before_id: notes[380]?.id,
        limit: 500,
      }),
    ],
    [
      expect.objectContaining({
        authors: [viewer],
        until: 2020,
        before_id: h.store.find((item) => item.created_at === 2020)?.id,
        limit: 500,
      }),
    ],
  ]);
  const windows = requests.findIndex((request) =>
    request.some((filter) => filter["#h"] && !filter["#e"]),
  );
  expect(requests.indexOf(pages[0] as ReadFilter[])).toBeGreaterThan(windows);
  // The 50 newest threads are read whole with their roots; the other 90 are
  // each asked for replies since their newest time, and only the answered
  // thread's root is then fetched.
  const hot = h
    .filters()
    .filter(
      (filter) => filter["#e"] && !filter.authors && filter.since === undefined,
    );
  expect(hot.map((filter) => filter["#e"]?.length)).toEqual([25, 25]);
  expect(hot.every((filter) => filter.limit === 200)).toBe(true);
  const cold = h
    .filters()
    .filter((filter) => filter["#e"] && filter.since !== undefined);
  expect(cold).toHaveLength(90);
  expect(cold.at(-1)).toEqual(
    expect.objectContaining({
      "#h": ["a"],
      "#e": [oldest.id],
      since: 2000,
      limit: 50,
    }),
  );
  expect(cold).toContainEqual(
    expect.objectContaining({ "#h": ["b"], "#e": [quiet.id], since: 2001 }),
  );
  // Each cold read is inclusive of the thread's newest time, which the walk
  // taught from the viewer's reply, so that reply returns and is passed over
  // by ID: the hot roots and the answered thread's are the ones fetched.
  const fetched = h.filters().flatMap((filter) => filter.ids ?? []);
  expect(fetched).toHaveLength(51);
  expect(fetched).toContain(oldest.id);
  expect(fetched).not.toContain(quiet.id);
  const inbox = () => h.owner.capability.inbox();
  expect(inbox()).toMatchObject({ status: "ready", freshness: "observed" });
  expect(inbox().partial).toBeUndefined();
  // The viewer's reply is older than the read reaches, so their membership
  // is looked up; the read answer then shows under its fetched root.
  await vi.waitFor(() =>
    expect(inbox().items).toContainEqual(
      expect.objectContaining({
        rootId: oldest.id,
        messageIds: [answer.id],
        unreadCount: 0,
      }),
    ),
  );
  // A cold thread the viewer has read is not a row until it gets a reply
  // they have not read; see docs/inbox.md.
  expect(
    inbox().items.find((item) => item.rootId === quiet.id),
  ).toBeUndefined();
  // The walk's pages are not evidence: the one-liners outside the window are
  // not retained, so channel a's count stays that of its window.
  expect(
    h.owner.capability.snapshot({ kind: "channel", channelId: "a" })
      .observedCount,
  ).toBe(0);
  const saved = await remembered(storage);
  expect(saved.roots.size).toBe(140);
  expect(saved.roots.get(`a:${oldest.id}`)).toEqual({
    at: 9500,
    newestId: answer.id,
  });
  expect(saved.roots.get(`b:${quiet.id}`)).toEqual({
    at: 2001,
    newestId: h.store.find((item) => item.created_at === 2001)?.id,
  });
  expect(saved.walk).toEqual({ since: 3479 });
  h.owner.dispose();
  // The next repair reads only what was authored since the walk — the mark
  // itself repeats, as `since` is inclusive — and walks no further.
  const second = await setup({
    channels: ["a", "b"],
    frontiers: { a: 9600, b: 9600 },
    storage,
  });
  second.store.push(...h.store);
  const late = event("b", peer, 9000);
  second.store.push(late, reply("b", viewer, 9700, late));
  await second.owner.capability.ensure();
  const again = second.reader.read.mock.calls.map(([filters]) => filters);
  expect(again[0]?.[0]).toMatchObject({
    authors: [viewer],
    since: 3479,
    limit: 100,
  });
  expect(
    second.filters().filter((filter) => filter.until !== undefined),
  ).toEqual([]);
  // The 50 newest remembered threads by channel, then the thread the page
  // just taught; the other 90 are asked one by one.
  expect(
    second
      .filters()
      .filter((filter) => filter["#e"] && !filter.authors && !filter.since),
  ).toHaveLength(3);
  expect(
    second.filters().filter((filter) => filter["#e"] && filter.since),
  ).toHaveLength(90);
  expect(await remembered(second.storage)).toMatchObject({
    walk: { since: 9700 },
  });
  expect((await remembered(storage)).roots.size).toBe(141);
});

it("a dropped walk page leaves the walk to the next repair without marking channels unchecked", async () => {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["a", "b"],
    frontiers: { a: 9600, b: 9600 },
    storage,
    sampled: false,
  });
  history(h);
  h.failing.add("walk");
  await h.owner.capability.ensure();
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({ status: "ready", freshness: "observed" });
  expect(inbox.partial).toBeUndefined();
  expect(inbox.error).toBeUndefined();
  // The page was tried twice; nothing beyond today's page was learned.
  expect(
    h.filters().filter((filter) => filter.until !== undefined),
  ).toHaveLength(2);
  expect(await remembered(storage)).toEqual({ roots: new Map() });
  // The next repair walks again from the newest page.
  h.failing.clear();
  await h.owner.capability.refresh();
  const saved = await remembered(storage);
  expect(saved.roots.size).toBe(140);
  expect(saved.walk).toEqual({ since: 3479 });
});

// A remembered thread outside the 50 most recently active, so the repair asks
// it for replies since its newest time rather than reading it whole: 50 newer
// threads are remembered beside it, and the walk mark is past everything.
async function coldThread(
  storage: UnreadStorage,
  channelId: string,
  root: RelayEvent,
  at: number,
  newestId?: string,
) {
  const newer = Array.from({ length: 50 }, (_, i): [string, ThreadMark] => [
    `${channelId}:${"f".repeat(60)}${i.toString(16).padStart(4, "0")}`,
    { at: 5000 + i },
  ]);
  await remember(storage, {
    roots: new Map([
      ...newer,
      [`${channelId}:${root.id}`, newestId ? { at, newestId } : { at }],
    ]),
    walk: { since: 6000 },
  });
}
const coldReads = (h: Awaited<ReturnType<typeof setup>>, root: RelayEvent) =>
  h
    .filters()
    .filter(
      (filter) =>
        filter["#e"]?.length === 1 &&
        filter["#e"][0] === root.id &&
        filter.since !== undefined,
    );

it("a cold thread's read is inclusive of its newest time, so a peer reply in the same second as the viewer's is recovered", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  await coldThread(storage, "c0", root, 1010);
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 1005 },
    storage,
  });
  const mine = reply("c0", viewer, 1010, root);
  const answer = reply("c0", peer, 1010, root);
  // Later traffic keeps the channel window from reaching the replies.
  h.store.push(root, mine, answer, ...flood("c0", 100, 2000));
  await h.owner.capability.ensure();
  expect(coldReads(h, root)).toEqual([
    expect.objectContaining({
      "#h": ["c0"],
      "#e": [root.id],
      since: 1010,
      limit: 50,
    }),
  ]);
  await vi.waitFor(() =>
    expect(h.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({
        rootId: root.id,
        messageIds: [answer.id],
        unreadCount: 1,
      }),
    ),
  );
  // Of the two replies in that second, the viewer's sorts first.
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1010,
    newestId: mine.id,
  });
});

it("a cold thread's boundary reply that is still unread returns to a warm repair and shows unread, and a new reply in the same second joins it", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1005, root);
  const boundary = reply("c0", peer, 1010, root);
  // A record from before unread replies kept their place names the unread
  // reply as the one last seen.
  await coldThread(storage, "c0", root, 1010, boundary.id);
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 1005 },
    storage,
    sampled: false,
  });
  h.store.push(root, mine, boundary, ...flood("c0", 100, 2000));
  await h.owner.capability.ensure();
  const fetched = () => h.filters().flatMap((filter) => filter.ids ?? []);
  const inbox = () => h.owner.capability.inbox();
  expect(coldReads(h, root)).toEqual([
    expect.objectContaining({ "#e": [root.id], since: 1010 }),
  ]);
  // Unread, the boundary reply is not passed over: its root is fetched and
  // it shows, and the mark does not move.
  expect(inbox()).toMatchObject({ status: "ready", freshness: "observed" });
  expect(fetched()).toContain(root.id);
  await vi.waitFor(() =>
    expect(inbox().items).toContainEqual(
      expect.objectContaining({
        rootId: root.id,
        messageIds: [boundary.id],
        unreadCount: 1,
      }),
    ),
  );
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1010,
    newestId: boundary.id,
  });
  // Another peer reply in the same second joins it under the root.
  const another = reply("c0", peer, 1010, root);
  h.store.push(another);
  await h.owner.capability.refresh();
  expect(coldReads(h, root)).toHaveLength(2);
  await vi.waitFor(() =>
    expect(inbox().items).toContainEqual(
      expect.objectContaining({
        rootId: root.id,
        messageIds: expect.arrayContaining([boundary.id, another.id]),
        unreadCount: 2,
      }),
    ),
  );
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1010,
    newestId: boundary.id,
  });
});

it("a cold thread's unread replies return on every launch until read; read, the newest is passed over on the next", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  await coldThread(storage, "c0", root, 1010, mine.id);
  const answers = Array.from({ length: 3 }, (_, i) =>
    reply("c0", peer, 2000 + i, root),
  );
  const newest = answers[2];
  assert(newest);
  const history = [root, mine, ...answers, ...flood("c0", 100, 3000)];
  const launch = async (frontiers: Readonly<Record<string, number>>) => {
    const h = await setup({
      channels: ["c0"],
      frontiers,
      storage,
      sampled: false,
    });
    h.store.push(...history);
    await h.owner.capability.ensure();
    return h;
  };
  type Launch = Awaited<ReturnType<typeof launch>>;
  const row = (h: Launch) =>
    h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
  const fetched = (h: Launch) =>
    h.filters().flatMap((filter) => filter.ids ?? []);
  const mark = async () =>
    (await remembered(storage)).roots.get(`c0:${root.id}`);
  // A session admits the three unread replies; they advance nothing.
  const first = await launch({ c0: 1500 });
  await vi.waitFor(() => expect(row(first)).toMatchObject({ unreadCount: 3 }));
  expect(await mark()).toEqual({ at: 1010, newestId: mine.id });
  first.owner.dispose();
  // Relaunched with nothing retained, the cold read returns all three again.
  const second = await launch({ c0: 1500 });
  expect(coldReads(second, root)).toEqual([
    expect.objectContaining({ since: 1010 }),
  ]);
  expect(fetched(second)).toContain(root.id);
  await vi.waitFor(() =>
    expect(row(second)).toMatchObject({
      unreadCount: 3,
      messageIds: expect.arrayContaining(answers.map((answer) => answer.id)),
    }),
  );
  second.owner.dispose();
  // Read through the newest on another device, the replies return once more,
  // read, and the repair learns the newest as the boundary.
  const read = { c0: 1500, [`thread:${root.id}`]: 2002 };
  const third = await launch(read);
  expect(coldReads(third, root)).toEqual([
    expect.objectContaining({ since: 1010 }),
  ]);
  await vi.waitFor(() => expect(row(third)).toMatchObject({ unreadCount: 0 }));
  expect(await mark()).toEqual({ at: 2002, newestId: newest.id });
  third.owner.dispose();
  // On the next launch the boundary alone returns and is passed over: no
  // root fetched, no row.
  const fourth = await launch(read);
  expect(coldReads(fourth, root)).toEqual([
    expect.objectContaining({ since: 2002 }),
  ]);
  expect(fourth.owner.capability.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
  });
  expect(fetched(fourth)).not.toContain(root.id);
  expect(row(fourth)).toBeUndefined();
  expect(await mark()).toEqual({ at: 2002, newestId: newest.id });
});

it("a cold thread's boundary reply marked unread on this device is admitted on the next launch, not passed over", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  const answer = reply("c0", peer, 2000, root);
  await coldThread(storage, "c0", root, 1010, mine.id);
  const history = [root, mine, answer, ...flood("c0", 100, 3000)];
  // The thread was read through the answer on another device.
  const frontiers = { c0: 1500, [`thread:${root.id}`]: 2000 };
  const launch = async (localUnread: Readonly<Record<string, number>> = {}) => {
    const h = await setup({
      channels: ["c0"],
      frontiers,
      storage,
      localUnread,
    });
    h.store.push(...history);
    await h.owner.capability.ensure();
    return h;
  };
  type Launch = Awaited<ReturnType<typeof launch>>;
  const row = (h: Launch) =>
    h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
  const mark = async () =>
    (await remembered(storage)).roots.get(`c0:${root.id}`);
  // The read answer is the thread's newest reply: the repair learns it as
  // the boundary. Marked unread here, it counts at once.
  const first = await launch();
  await vi.waitFor(() => expect(row(first)).toMatchObject({ unreadCount: 0 }));
  expect(await mark()).toEqual({ at: 2000, newestId: answer.id });
  await first.owner.capability.markUnreadLocal({
    kind: "message",
    channelId: "c0",
    messageId: answer.id,
  });
  expect(row(first)).toMatchObject({ unreadCount: 1, manual: true });
  expect(await mark()).toEqual({ at: 2000, newestId: answer.id });
  first.owner.dispose();
  // Relaunched, the cold read returns the boundary alone; still marked
  // unread on this device, it is admitted under its fetched root and its
  // mark does not pass it.
  const second = await launch({ [`msg:${answer.id}`]: 1 });
  expect(coldReads(second, root)).toEqual([
    expect.objectContaining({ since: 2000 }),
  ]);
  await vi.waitFor(() =>
    expect(row(second)).toMatchObject({
      unreadCount: 1,
      manual: true,
      messageIds: [answer.id],
    }),
  );
  expect(await mark()).toEqual({ at: 2000, newestId: answer.id });
});

it("a cold thread's reply marked unread below its mark moves the mark back to it, and the mark stays there across launches until the mark is cleared", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  const answer = reply("c0", peer, 2000, root);
  const later = reply("c0", peer, 2100, root);
  await coldThread(storage, "c0", root, 1010, mine.id);
  const history = [root, mine, answer, later, ...flood("c0", 100, 3000)];
  // The thread was read through the later reply on another device.
  const frontiers = { c0: 1500, [`thread:${root.id}`]: 2100 };
  const launch = async (localUnread: Readonly<Record<string, number>> = {}) => {
    const h = await setup({
      channels: ["c0"],
      frontiers,
      storage,
      localUnread,
    });
    h.store.push(...history);
    await h.owner.capability.ensure();
    return h;
  };
  type Launch = Awaited<ReturnType<typeof launch>>;
  const row = (h: Launch) =>
    h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
  const mark = async () =>
    (await remembered(storage)).roots.get(`c0:${root.id}`);
  const save = vi.spyOn(storage, "save");
  // Both read replies return and the mark advances past them. Marking the
  // older one unread moves the mark back to it, saved at once.
  const first = await launch();
  await vi.waitFor(() => expect(row(first)).toMatchObject({ unreadCount: 0 }));
  expect(await mark()).toEqual({ at: 2100, newestId: later.id });
  save.mockClear();
  await first.owner.capability.markUnreadLocal({
    kind: "message",
    channelId: "c0",
    messageId: answer.id,
  });
  expect(row(first)).toMatchObject({ unreadCount: 1, manual: true });
  expect(save).toHaveBeenCalledTimes(1);
  expect(await mark()).toEqual({ at: 2000 });
  first.owner.dispose();
  // Relaunched, the cold read reaches the marked reply again; the later
  // read reply returns too and does not move the mark past it.
  const marked = { [`msg:${answer.id}`]: 1 };
  const second = await launch(marked);
  expect(coldReads(second, root)).toEqual([
    expect.objectContaining({ since: 2000 }),
  ]);
  await vi.waitFor(() =>
    expect(row(second)).toMatchObject({
      unreadCount: 1,
      manual: true,
      messageIds: expect.arrayContaining([answer.id, later.id]),
    }),
  );
  expect(await mark()).toEqual({ at: 2000 });
  second.owner.dispose();
  // And on the launch after that. Cleared, the next repair learns the later
  // reply as the boundary again.
  const third = await launch(marked);
  await vi.waitFor(() =>
    expect(row(third)).toMatchObject({ unreadCount: 1, manual: true }),
  );
  expect(await mark()).toEqual({ at: 2000 });
  await third.owner.capability.clearUnreadLocal({
    kind: "message",
    channelId: "c0",
    messageId: answer.id,
  });
  expect(row(third)).toMatchObject({ unreadCount: 0, manual: false });
  await third.owner.capability.refresh();
  expect(await mark()).toEqual({ at: 2100, newestId: later.id });
});

// A cold thread read through its newest reply on this device, then marked
// unread as a whole or by its root: the mark holds at the root across
// launches while the intent lasts, so the row keeps returning. A thread mark
// counts nothing on the row; a peer's root is held for grouping but is not a
// row entry, so its own mark shows nowhere in the Inbox.
for (const [name, target] of [
  [
    "thread",
    (root: RelayEvent) => ({ kind: "thread" as const, rootId: root.id }),
  ],
  [
    "root",
    (root: RelayEvent) => ({ kind: "message" as const, messageId: root.id }),
  ],
] as const) {
  it(`a cold thread marked unread by its ${name} holds its mark at the root across launches until the mark is cleared`, async () => {
    const storage = memoryUnreadStorage();
    const root = event("c0", peer, 1000);
    const mine = reply("c0", viewer, 1010, root);
    const answer = reply("c0", peer, 2000, root);
    const later = reply("c0", peer, 2100, root);
    await coldThread(storage, "c0", root, 1010, mine.id);
    const history = [root, mine, answer, later, ...flood("c0", 100, 3000)];
    // The thread was read through the later reply on another device.
    const frontiers = { c0: 1500, [`thread:${root.id}`]: 2100 };
    const launch = async (
      localUnread: Readonly<Record<string, number>> = {},
    ) => {
      const h = await setup({
        channels: ["c0"],
        frontiers,
        storage,
        localUnread,
      });
      h.store.push(...history);
      await h.owner.capability.ensure();
      return h;
    };
    type Launch = Awaited<ReturnType<typeof launch>>;
    const row = (h: Launch) =>
      h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
    const mark = async () =>
      (await remembered(storage)).roots.get(`c0:${root.id}`);
    const marked = { channelId: "c0", ...target(root) };
    const manual = name === "thread";
    const first = await launch();
    await vi.waitFor(() =>
      expect(row(first)).toMatchObject({ unreadCount: 0, manual: false }),
    );
    expect(await mark()).toEqual({ at: 2100, newestId: later.id });
    await first.owner.capability.markUnreadLocal(marked);
    expect(row(first)).toMatchObject({ unreadCount: 0, manual });
    expect((await mark())?.at).toBe(1000);
    first.owner.dispose();
    // Relaunched, the cold read begins at the root and the row returns; the
    // read replies it carries do not advance the mark.
    const kept = { [`${name === "thread" ? "thread" : "msg"}:${root.id}`]: 1 };
    const second = await launch(kept);
    expect(coldReads(second, root)).toEqual([
      expect.objectContaining({ since: 1000 }),
    ]);
    await vi.waitFor(() =>
      expect(row(second)).toMatchObject({
        unreadCount: 0,
        manual,
        messageIds: expect.arrayContaining([answer.id, later.id]),
      }),
    );
    expect((await mark())?.at).toBe(1000);
    second.owner.dispose();
    // And on the launch after that. Cleared, the next repair learns the later
    // reply as the boundary again.
    const third = await launch(kept);
    expect(coldReads(third, root)).toEqual([
      expect.objectContaining({ since: 1000 }),
    ]);
    await vi.waitFor(() =>
      expect(row(third)).toMatchObject({ unreadCount: 0, manual }),
    );
    expect((await mark())?.at).toBe(1000);
    await third.owner.capability.clearUnreadLocal(marked);
    expect(row(third)).toMatchObject({ unreadCount: 0, manual: false });
    await third.owner.capability.refresh();
    expect(await mark()).toEqual({ at: 2100, newestId: later.id });
  });
}

it("a lookup feeding a thread whose mark was just lowered cannot re-advance it before another thread's mark is saved", async () => {
  const storage = memoryUnreadStorage();
  const rootA = event("c0", peer, 20);
  const rootB = event("c0", peer, 20);
  const answerA = reply("c0", peer, 700, rootA);
  const answerB = reply("c0", peer, 720, rootB);
  // Both threads were read through 900 on another device.
  await remember(storage, {
    roots: new Map([
      [`c0:${rootA.id}`, { at: 900 }],
      [`c0:${rootB.id}`, { at: 900 }],
    ]),
    walk: { since: 6000 },
  });
  const h = await setup({
    channels: ["c0"],
    frontiers: {
      c0: 20,
      [`thread:${rootA.id}`]: 900,
      [`thread:${rootB.id}`]: 900,
    },
    storage,
  });
  h.store.push(rootA, rootB, answerA, answerB);
  await h.owner.capability.ensure();
  const marks = async () => {
    const { roots } = await remembered(storage);
    return [roots.get(`c0:${rootA.id}`), roots.get(`c0:${rootB.id}`)];
  };
  expect(await marks()).toEqual([{ at: 900 }, { at: 900 }]);
  // Marking A's reply unread lowers A's mark to it.
  await h.owner.capability.markUnreadLocal({
    kind: "message",
    channelId: "c0",
    messageId: answerA.id,
  });
  expect(await marks()).toEqual([{ at: 700 }, { at: 900 }]);
  // The viewer replies in A from another device, newer than the lowered
  // mark; the read reply's membership lookup finds that reply and feeds it
  // to the pass, which has already read A: no follow-up, no full learn.
  const mine = reply("c0", viewer, 800, rootA);
  h.store.push(mine);
  h.owner.capability.inbox();
  await vi.waitFor(() =>
    expect(h.owner.capability.attention("c0", answerA.id)).toMatchObject({
      category: "thread",
    }),
  );
  expect(h.filters()).toContainEqual(
    expect.objectContaining({
      authors: [viewer],
      "#e": expect.arrayContaining([rootA.id]),
    }),
  );
  // Lowering B's mark saves the record: A's mark is still the lowered one.
  await h.owner.capability.markUnreadLocal({
    kind: "message",
    channelId: "c0",
    messageId: answerB.id,
  });
  expect(await marks()).toEqual([{ at: 700 }, { at: 720 }]);
});

it("a cold thread whose page comes back full is read whole, losing none of its replies", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  await coldThread(storage, "c0", root, 1010);
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 1005 },
    storage,
  });
  const answers = Array.from({ length: 60 }, (_, i) =>
    reply("c0", peer, 1020 + i, root),
  );
  const mine = reply("c0", viewer, 1010, root);
  h.store.push(root, mine, ...answers, ...flood("c0", 100, 2000));
  await h.owner.capability.ensure();
  // The 50-reply page since 1010 is full, so the whole thread is read next.
  expect(coldReads(h, root)).toHaveLength(1);
  expect(h.filters()).toContainEqual({
    kinds: [9, 40002, 40008],
    "#h": ["c0"],
    "#e": [root.id],
    include_aux: true,
    limit: 200,
  });
  await vi.waitFor(() =>
    expect(h.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({ rootId: root.id, unreadCount: 60 }),
    ),
  );
  // Unread, the 60 advance nothing: the next repair reads them again.
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1010,
    newestId: mine.id,
  });
});

it("a dropped cold read leaves its thread to the next repair and the Inbox partial, with its channel still observed", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  await coldThread(storage, "c0", root, 1010);
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 1005 },
    storage,
    sampled: false,
  });
  const answer = reply("c0", peer, 1100, root);
  h.store.push(
    root,
    reply("c0", viewer, 1010, root),
    answer,
    ...flood("c0", 100, 2000),
  );
  h.failing.add("cold");
  await h.owner.capability.ensure();
  const inbox = () => h.owner.capability.inbox();
  // Tried twice, then dropped: the thread's unread reply is missing, which
  // the Inbox says with the soft notice rather than the failure banner; the
  // thread's time is unchanged and the channel's window is still observed.
  expect(coldReads(h, root)).toHaveLength(2);
  expect(inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
    partial: true,
  });
  expect(inbox().error).toBeUndefined();
  expect(inbox().items.find((item) => item.rootId === root.id)).toBeUndefined();
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1010,
  });
  expect(
    h.owner.capability.snapshot({ kind: "channel", channelId: "c0" }),
  ).toMatchObject({ coverage: "observed", freshness: "observed" });
  h.failing.clear();
  await h.owner.capability.refresh();
  expect(inbox().partial).toBeUndefined();
  await vi.waitFor(() =>
    expect(inbox().items).toContainEqual(
      expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
    ),
  );
});

it("a remembered thread in a channel the roster lacks is kept through a save and read again when the channel returns", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c1", peer, 1000);
  await remember(storage, {
    roots: new Map([[`c1:${root.id}`, { at: 1010 }]]),
    walk: { since: 6000 },
  });
  const channels = ["c0"];
  const h = await setup({
    channels,
    frontiers: { c0: 1005, c1: 1300 },
    storage,
  });
  h.store.push(
    root,
    reply("c1", viewer, 1010, root),
    reply("c1", peer, 1100, root),
  );
  await h.owner.capability.ensure();
  expect(h.filters().some((filter) => filter["#h"]?.[0] === "c1")).toBe(false);
  // Not read, not forgotten: the walk mark has passed the viewer's reply.
  expect((await remembered(storage)).roots).toEqual(
    new Map([[`c1:${root.id}`, { at: 1010 }]]),
  );
  channels.push("c1");
  await h.owner.capability.refresh();
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c1"], "#e": [root.id] }),
  );
  await vi.waitFor(() =>
    expect(h.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({ rootId: root.id, unreadCount: 0 }),
    ),
  );
  expect((await remembered(storage)).roots.get(`c1:${root.id}`)?.at).toBe(1100);
});

it("a thread the walk teaches in a channel the roster lacks is remembered, not read, so the walk mark does not pass it", async () => {
  const storage = memoryUnreadStorage();
  const channels = ["c0"];
  const h = await setup({
    channels,
    frontiers: { c0: 1005, c1: 1300 },
    storage,
  });
  const root = event("c1", peer, 1000);
  const mine = reply("c1", viewer, 1010, root);
  h.store.push(
    root,
    mine,
    reply("c1", peer, 1100, root),
    event("c0", viewer, 2000),
  );
  await h.owner.capability.ensure();
  expect(h.filters().some((filter) => filter["#h"]?.[0] === "c1")).toBe(false);
  expect(await remembered(storage)).toEqual({
    roots: new Map([[`c1:${root.id}`, { at: 1010, newestId: mine.id }]]),
    walk: { since: 2000 },
  });
  channels.push("c1");
  await h.owner.capability.refresh();
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c1"], "#e": [root.id] }),
  );
  await vi.waitFor(() =>
    expect(h.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({ rootId: root.id, unreadCount: 0 }),
    ),
  );
});

it("clearing the owner while a walk page reads retires the walk: no further page, thread read or save", async () => {
  const storage = memoryUnreadStorage();
  const save = vi.spyOn(storage, "save");
  const h = await setup({
    channels: ["a", "b"],
    frontiers: { a: 9600, b: 9600 },
    storage,
  });
  history(h);
  const pages = () =>
    h.filters().filter((filter) => filter.until !== undefined);
  const release = h.hold("walk");
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() => expect(pages()).toHaveLength(1));
    h.owner.clear();
  } finally {
    release();
  }
  await done;
  // The page's result is retired with its epoch: the first request, the
  // roster sample beside it and the page are all that was read.
  expect(h.reader.read).toHaveBeenCalledTimes(3);
  expect(save).not.toHaveBeenCalled();
  expect(h.owner.capability.inbox()).toMatchObject({ freshness: "unknown" });
  expect(await storage.read()).toBeUndefined();
});

it("a lookup that finds the viewer's reply while the windows read puts the thread's read ahead of the remaining windows", async () => {
  const storage = memoryUnreadStorage();
  const wide = Array.from({ length: 256 }, (_, i) => `w${i}`);
  const h = await setup({
    channels: ["c0", ...wide, "hx"],
    frontiers: {
      c0: 1100,
      ...Object.fromEntries(wide.map((id) => [id, 1050])),
    },
    storage,
    // The viewer's reply is older than their newest page reaches: only the
    // membership lookup finds it.
    authoredPage: false,
  });
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  const answer = reply("c0", peer, 1120, root);
  h.store.push(root, mine, answer);
  // A remembered thread in the never-read channel: its read, and that
  // channel's window in the last request, wait on the same hold.
  const hroot = event("hx", peer, 2000);
  await remember(storage, {
    roots: new Map([[`hx:${hroot.id}`, { at: 2000 }]]),
  });
  const save = vi.spyOn(storage, "save");
  // Requests: the viewer's page with 127 windows, the remembered thread,
  // 128 windows, then the last windows. Holding the thread read and a
  // window of the third request leaves the fourth queued when the first
  // lands and its reply's lookup finds the viewer's reply.
  const releaseThread = h.hold("hx");
  const releaseWindow = h.hold("w200");
  const requests = () => h.reader.read.mock.calls.map(([filters]) => filters);
  const threadRead = (request: readonly ReadFilter[]) =>
    request.some(
      (filter) =>
        !filter.authors &&
        filter["#h"]?.[0] === "c0" &&
        !!filter["#e"]?.includes(root.id),
    );
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() =>
      expect(h.owner.capability.attention("c0", answer.id)).toMatchObject({
        category: "thread",
        unread: true,
      }),
    );
    expect(requests().some(threadRead)).toBe(false);
    releaseWindow();
    await vi.waitFor(() => expect(requests().some(threadRead)).toBe(true));
  } finally {
    releaseThread();
    releaseWindow();
  }
  await done;
  const thread = requests().findIndex(threadRead);
  const last = requests().findIndex((request) =>
    request.some((filter) => filter["#h"]?.[0] === "hx" && !filter["#e"]),
  );
  expect(thread).toBeGreaterThan(0);
  expect(last).toBeGreaterThan(thread);
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({ status: "ready", freshness: "observed" });
  expect(inbox.partial).toBeUndefined();
  expect(inbox.items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  // Learned by the repair, saved once with its result: the viewer's reply,
  // since the answer is unread.
  expect(save).toHaveBeenCalledTimes(1);
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1010,
    newestId: mine.id,
  });
});

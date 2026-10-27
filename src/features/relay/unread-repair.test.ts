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
import { memoryThreadParticipation } from "./thread-participation";
import { createUnread } from "./unread";

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

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function setup({
  channels: ids,
  frontiers,
  participation = memoryThreadParticipation(),
  authoredPage = true,
}: {
  channels: readonly string[];
  frontiers: Readonly<Record<string, number>>;
  participation?: ReturnType<typeof memoryThreadParticipation>;
  // Whether the viewer's newest authored page still reaches their old replies.
  authoredPage?: boolean;
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
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      const windows = filters.flatMap((filter) => filter["#h"] ?? []);
      await Promise.all(windows.map((id) => held.get(id)));
      if (windows.some((id) => failing.has(id)))
        throw new Error("Relay read timed out");
      if (windows.some((id) => transient.delete(id)))
        throw new DOMException("Relay read timed out", "TimeoutError");
      return filters.flatMap((filter) => {
        if (filter.authors && !filter["#e"] && !authoredPage) return [];
        return store
          .filter(
            (item) =>
              (!filter.kinds || filter.kinds.includes(item.kind)) &&
              (!filter.ids || filter.ids.includes(item.id)) &&
              (!filter.authors || filter.authors.includes(item.pubkey)) &&
              (filter.since === undefined || item.created_at >= filter.since) &&
              (filter.until === undefined || item.created_at <= filter.until) &&
              (!filter["#h"] || tagged(item, "h", filter["#h"])) &&
              (!filter["#e"] || tagged(item, "e", filter["#e"])),
          )
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit);
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
    participation,
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
  return { owner, store, reader, filters, failing, transient, hold };
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
  // the busy channel holds far more than the former global sample.
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

it("a read reply whose root the windows dropped groups under its fetched root", async () => {
  const h = await setup({ channels: ["c0"], frontiers: { c0: 1100 } });
  const root = event("c0", peer, 1000);
  const mention = reply("c0", peer, 1020, root, [["p", viewer]]);
  h.store.push(root, mention, ...flood("c0", 120, 1100));
  await h.owner.capability.ensure();
  // The mention feed hands the read mention over; its root is not retained.
  h.owner.accept([mention]);
  await vi.waitFor(() =>
    expect(h.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({
        rootId: root.id,
        messageIds: [mention.id],
        unreadCount: 0,
      }),
    ),
  );
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ ids: [root.id] }),
  );
  // A single row names the thread; the mention is not its own row as well.
  expect(
    h.owner.capability.inbox().items.filter((item) => item.channelId === "c0"),
  ).toHaveLength(1);
});

it("a full budget evicts the oldest unpinned evidence and keeps the viewer's thread", async () => {
  const h = await setup({
    channels: ["quiet", "busy"],
    frontiers: { quiet: 1015, busy: 1500 },
  });
  const root = event("quiet", peer, 1000);
  const mine = reply("quiet", viewer, 1010, root);
  const answer = reply("quiet", peer, 1020, root);
  h.store.push(root, mine, answer, ...flood("quiet", 120, 1100));
  const windowed = flood("busy", 10, 2000);
  h.store.push(...windowed);
  await h.owner.capability.ensure();
  const inbox = () => h.owner.capability.inbox();
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id }),
  );
  // Live traffic of large messages passes the 8 MiB budget. Only what goes
  // first is evicted: the quiet channel's window rows, then the oldest of the
  // large messages, never the viewer's thread.
  const large = Array.from({ length: 20 }, (_, i) =>
    event("busy", peer, 3000 + i, [], "x".repeat(450_000)),
  );
  h.owner.accept(large);
  const snapshot = (channelId: string) =>
    h.owner.capability.snapshot({ kind: "channel", channelId });
  expect(inbox().freshness).toBe("observed");
  expect(inbox().error).toBeUndefined();
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  expect(snapshot("quiet").observedCount).toBeLessThan(120);
  const busy = snapshot("busy");
  expect(busy.observedCount).toBeGreaterThan(0);
  expect(busy.observedCount).toBeLessThan(30);
  const newest = large.at(-1);
  assert(newest);
  expect(h.owner.capability.attention("busy", newest.id).unread).toBe(true);
  expect(
    h.owner.capability.attention("busy", windowed[0]?.id ?? "").unread,
  ).toBe(false);
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

it("a window dropped after its retry leaves its channel unknown and the Inbox partial, with the viewer's thread still read", async () => {
  // Windows go most recently read first, so the failing channel's request
  // follows the one carrying the viewer's authored page.
  const h = await setup({
    channels: ["quiet", "busy", "c2", "c3", "c4"],
    frontiers: { quiet: 1015, busy: 900, c2: 1200, c3: 1100 },
  });
  const root = event("quiet", peer, 1000);
  const mine = reply("quiet", viewer, 1010, root);
  const answer = reply("quiet", peer, 1020, root);
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

it("reads the viewer's page first, remembered and newly taught threads next, then windows most recently read first", async () => {
  const participation = memoryThreadParticipation();
  const remembered = "f".repeat(64);
  await participation.write(new Map([[`c1:${remembered}`, 1000]]));
  const h = await setup({
    channels: ["never1", "c1", "c2", "c3", "never2"],
    frontiers: { c1: 1100, c2: 1300, c3: 1200 },
    participation,
  });
  // A thread the viewer replied in before c3's mark: only the authored page
  // reaches it, and its read goes ahead of the never-read windows.
  const root = event("c3", peer, 1000);
  h.store.push(root, reply("c3", viewer, 1010, root));
  await h.owner.capability.ensure();
  const requests = h.reader.read.mock.calls.map(([filters]) => filters);
  expect(requests[0]?.[0]).toMatchObject({ authors: [viewer] });
  expect(requests[0]?.slice(1).map((filter) => filter["#h"]?.[0])).toEqual([
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
    expect.objectContaining({ "#h": ["never1"], since: floor }),
    expect.objectContaining({ "#h": ["never2"], since: floor }),
  ]);
  expect(requests).toHaveLength(4);
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
  expect(
    h.owner.capability.snapshot({ kind: "channel", channelId: "c40" })
      .observedCount,
  ).toBe(74);
});

it("remembers threads the viewer took part in, not every message they wrote", async () => {
  const participation = memoryThreadParticipation();
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 900 },
    participation,
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
  expect(await participation.read()).toEqual(
    new Map([
      [`c0:${asked.id}`, 1020],
      [`c0:${theirs.id}`, 1040],
    ]),
  );
});

it("a followed thread is remembered as of the follow and refetched", async () => {
  const participation = memoryThreadParticipation();
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 1100 },
    participation,
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
  expect(await participation.read()).toEqual(new Map([[`c0:${root.id}`, NOW]]));
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], "#e": [root.id] }),
  );
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 0 }),
  );
});

it("the Inbox leaves loading once the viewer's page and remembered threads land, observing until the windows do", async () => {
  const h = await setup({
    channels: ["c0", "c1", "c2", "c3", "c4"],
    frontiers: { c0: 1400, c1: 1300, c2: 1200, c3: 1100, c4: 1000 },
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
  const h = await setup({ channels: ["c0"], frontiers: { c0: 1100 } });
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
  const participation = memoryThreadParticipation();
  const write = vi.spyOn(participation, "write");
  const frontiers = { c0: 1015 };
  const first = await setup({ channels: ["c0"], frontiers, participation });
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  const answer = reply("c0", peer, 1020, root);
  first.store.push(root, mine, answer, ...flood("c0", 120, 1100));
  await first.owner.capability.ensure();
  expect(first.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  // Remembered with the newest time the thread read saw.
  expect(write).toHaveBeenCalledWith(new Map([[`c0:${root.id}`, 1020]]));
  first.owner.dispose();
  // A later session: the viewer has since written a page of newer messages
  // elsewhere, so their authored page no longer reaches the old reply.
  const second = await setup({
    channels: ["c0"],
    frontiers,
    participation,
    authoredPage: false,
  });
  second.store.push(...first.store);
  await second.owner.capability.ensure();
  expect(second.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  expect(second.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], "#e": [root.id] }),
  );
});

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
  // Channels whose window requests fail.
  const failing = new Set<string>();
  const tagged = (item: RelayEvent, name: string, values: readonly string[]) =>
    item.tags.some(
      ([tag, value]) => tag === name && values.includes(value ?? ""),
    );
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      if (filters.some((filter) => filter["#h"]?.some((id) => failing.has(id))))
        throw new Error("Relay read timed out");
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
  return { owner, store, reader, filters, failing };
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
    expect.objectContaining({ "#h": ["quiet"], since: 1015, limit: 100 }),
    expect.objectContaining({ "#h": ["busy"], since: 1500, limit: 100 }),
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

it("a failed channel window still leaves the viewer's thread to the participation pass", async () => {
  // Five channels: the quiet channel's window and the failing one share a
  // request; the viewer's authored page rides the next.
  const h = await setup({
    channels: ["quiet", "busy", "c2", "c3", "c4"],
    frontiers: { quiet: 1015, busy: 1500 },
  });
  const root = event("quiet", peer, 1000);
  const mine = reply("quiet", viewer, 1010, root);
  const answer = reply("quiet", peer, 1020, root);
  h.store.push(root, mine, answer, ...flood("quiet", 120, 1100));
  h.failing.add("busy");
  await h.owner.capability.ensure();
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({
    freshness: "stale",
    error: "Relay read timed out",
  });
  expect(inbox.items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["quiet"], "#e": [root.id] }),
  );
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
  // Remembered with the newest time seen as the roots were learned; the
  // next repair sees the fetched replies and advances it.
  expect(write).toHaveBeenCalledWith(new Map([[`c0:${root.id}`, 1010]]));
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

import { verifiedSymbol } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries } from "./contracts";
import { eventVisibility } from "./event-access";
import type { ReadFilter, RelayEvent } from "./events";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import { createUnread } from "./unread";

// Conversation lookups with thousands of events. Unread receives events the
// transport already verified, so this fixture marks them verified instead of
// signing them; signing takes seconds. Session-level tests in
// unread-startup.test.ts keep real signatures.
let next = 0;
function event(
  pubkey: string,
  kind: number,
  created_at: number,
  tags: string[][],
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind,
    created_at,
    content: "",
    tags: [["h", "c0"], ...tags],
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const reply = (pubkey: string, time: number, parent: RelayEvent) =>
  event(pubkey, 9, time, [["e", parent.id, "", "reply"]]);
const viewer = "a".repeat(64),
  peer = "b".repeat(64);
const flood = (count: number, from: number) =>
  Array.from({ length: count }, (_, i) => event(peer, 9, from + i, []));

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function setup(initial?: ReadJournal) {
  // A relay whose channel sample holds only the 500 newest rows, so older
  // conversation membership is reachable only by parent lookup.
  const store: RelayEvent[] = [];
  const asked: string[] = [];
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) =>
      filters.flatMap((filter) => {
        if (filter.authors && filter["#e"]?.length === 1)
          asked.push(filter["#e"][0] ?? "");
        // The viewer's newest authored page (repair's participation pass)
        // holds none of these older replies; membership is the lookups' job.
        if (filter.authors && !filter["#e"]) return [];
        return store
          .filter(
            (item) =>
              (!filter.kinds || filter.kinds.includes(item.kind)) &&
              (!filter.ids || filter.ids.includes(item.id)) &&
              (!filter.authors || filter.authors.includes(item.pubkey)) &&
              (filter.until === undefined || item.created_at <= filter.until) &&
              (!filter["#e"] ||
                item.tags.some(
                  ([name, value]) =>
                    name === "e" && filter["#e"]?.includes(value ?? ""),
                )),
          )
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit);
      }),
    ),
  };
  let journal: ReadJournal | undefined = initial;
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
      channels: [{ id: "c0", name: "Channel", members: [viewer] }],
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
  const owner = createUnread({ reads, channels, reader, viewer });
  owners.push(owner);
  const lookups = () =>
    reader.read.mock.calls.filter(
      ([[filter]]) => filter?.ids || (filter?.authors && filter["#e"]),
    ).length;
  return { owner, store, asked, reader, lookups };
}

it("a lookup batch larger than the witness bound keeps every membership deletable", async () => {
  const { owner, store, asked, reader } = await setup();
  // Ten parents, each with 500 old replies of the viewer: one batch returns
  // 5,000 of the viewer's replies, more than the 4,096 witnesses unread keeps.
  const parents = Array.from({ length: 10 }, (_, i) =>
    event(peer, 9, 10 + i, []),
  );
  const mine = parents.map((parent) =>
    Array.from({ length: 500 }, (_, j) => reply(viewer, 20 + j, parent)),
  );
  const siblings = parents.map((parent, i) => reply(peer, 700 + i, parent));
  store.push(...parents, ...mine.flat());
  owner.accept(siblings);
  const attention = (i: number) => {
    const sibling = siblings[i];
    assert(sibling);
    return owner.capability.attention("c0", sibling.id);
  };
  // Ask for every parent in one turn, so they share one lookup batch.
  await vi.waitFor(() => {
    const states = parents.map((_, i) => attention(i));
    for (const state of states)
      expect(state).toMatchObject({ category: "thread", unread: true });
  });
  expect(
    reader.read.mock.calls.filter(([[filter]]) => filter?.ids),
  ).toHaveLength(1);
  // Witnessing every reply would evict the first-answered parent's replies
  // before the batch ends. Another client deletes all of them; like the
  // session, admit only deletions whose target unread can still show.
  const first = parents.findIndex((parent) => parent.id === asked[0]);
  const deleted = mine[first];
  assert(deleted);
  for (const item of deleted) store.splice(store.indexOf(item), 1);
  const visible = eventVisibility(
    () => true,
    (id) => owner.event(id),
  );
  owner.accept(
    deleted
      .map((item, i) => event(viewer, 5, 800 + i, [["e", item.id]]))
      .filter(visible),
  );
  await vi.waitFor(() => {
    expect(attention(first).pending).toBeUndefined();
    expect(attention(first)).toMatchObject({ unread: false });
  });
  expect(attention(first).category).toBeUndefined();
  for (const i of parents.keys())
    if (i !== first)
      expect(attention(i)).toMatchObject({ category: "thread", unread: true });
});

it("a later reply of the viewer outlives a negative lookup and its eviction", async () => {
  const { owner, store, lookups } = await setup();
  const root = event(peer, 9, 10, []);
  const answer = reply(peer, 700, root);
  store.push(root, answer, ...flood(499, 100));
  await owner.capability.ensure();
  const attention = (id: string) => owner.capability.attention("c0", id);
  await vi.waitFor(() => {
    expect(attention(answer.id).pending).toBeUndefined();
    expect(lookups()).toBeGreaterThan(0);
  });
  expect(attention(answer.id).unread).toBe(false);
  // The viewer joins the conversation live, after the lookup said no.
  owner.accept([reply(viewer, 800, root)]);
  expect(attention(answer.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
  const count = lookups();
  // Newer traffic evicts the live reply and the answer; the witness keeps the
  // membership, so the next reply in the conversation is the viewer's thread
  // without asking again.
  owner.accept(flood(4096, 900));
  expect(attention(answer.id).status).toBe("unknown");
  const later = reply(peer, 5000, root);
  owner.accept([later]);
  expect(attention(later.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
  expect(lookups()).toBe(count);
});

it("eviction keeps the newest evidence observed and lookup results survive a refresh without asking again", async () => {
  const { owner, store, lookups } = await setup();
  const mine = event(viewer, 9, 10, []);
  const answer = reply(peer, 700, mine);
  store.push(mine, answer, ...flood(499, 100));
  await owner.capability.ensure();
  const attention = (id: string) => owner.capability.attention("c0", id);
  await vi.waitFor(() => expect(attention(answer.id).unread).toBe(true));
  expect(lookups()).toBeGreaterThan(0);
  const count = lookups();
  const snapshot = () =>
    owner.capability.snapshot({ kind: "channel", channelId: "c0" });
  // Overflow the 4,096-event budget: the oldest evidence goes, the newest
  // stays, and nothing is reported as failed.
  const newer = flood(4096, 800);
  owner.accept(newer);
  expect(snapshot()).toMatchObject({
    observedCount: 4096,
    freshness: "observed",
  });
  expect(snapshot().error).toBeUndefined();
  expect(attention(answer.id).status).toBe("unknown");
  expect(attention(newer[0]?.id ?? "").unread).toBe(true);
  // An event older than everything retained cannot displace it.
  owner.accept([reply(peer, 701, mine)]);
  expect(snapshot().observedCount).toBe(4096);
  await owner.capability.refresh();
  expect(snapshot()).toMatchObject({
    observedCount: 4096,
    freshness: "observed",
  });
  const later = reply(peer, 5000, mine);
  owner.accept([later]);
  expect(attention(later.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
  expect(lookups()).toBe(count);
});

it("Inbox-only demand resolves direct conversation participation without counting lookup witnesses", async () => {
  const { owner, store, reader, lookups } = await setup();
  const parent = event(peer, 9, 10, []);
  const mine = reply(viewer, 11, parent);
  const sibling = reply(peer, 20, parent);
  const nestedParent = reply(peer, 21, parent);
  const nested = reply(peer, 22, nestedParent);
  store.push(parent, mine, nestedParent);
  owner.accept([sibling, nested]);
  const published: string[][] = [];
  const stop = owner.capability.subscribeInbox(() => {
    published.push(
      owner.capability.inbox().items.flatMap((item) => item.messageIds),
    );
  });
  try {
    expect(owner.capability.inbox().items).toEqual([]);
    await vi.waitFor(() => {
      const items = owner.capability.inbox().items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: `c0:${parent.id}`,
        messageId: sibling.id,
        messageIds: [sibling.id],
        rootId: parent.id,
        thread: true,
        unreadCount: 1,
        target: { kind: "message", channelId: "c0", messageId: sibling.id },
      });
    });
    expect(published).toContainEqual([sibling.id]);
    expect(lookups()).toBeGreaterThan(0);
    expect(
      reader.read.mock.calls.some(([[filter]]) =>
        filter?.authors?.includes(viewer),
      ),
    ).toBe(true);
    // A fetched parent is structural, not a counted message eligible for a
    // root-scoped manual action. The existing message fallback is actionable.
    const item = owner.capability.inbox().items[0];
    assert(item);
    expect(item.readThrough).toEqual([
      {
        target: { kind: "thread", channelId: "c0", rootId: parent.id },
        messageId: sibling.id,
      },
    ]);
    await owner.capability.markUnreadLocal(item.target);
    expect(owner.capability.inbox().items[0]?.manual).toBe(true);
    await owner.capability.clearUnreadLocal(item.target);
    expect(owner.capability.inbox().items[0]).toMatchObject({
      unreadCount: 1,
      manual: false,
    });
    // Fresh counted root evidence can safely promote the context-menu target.
    owner.accept([parent]);
    expect(owner.capability.inbox().items[0]?.target).toEqual({
      kind: "thread",
      channelId: "c0",
      rootId: parent.id,
    });
  } finally {
    stop();
  }
});

it("Inbox retains a relevant direct reply as thread activity when the root cannot be fetched", async () => {
  const { owner, store } = await setup();
  const root = event(peer, 9, 10, []);
  const parent = reply(viewer, 11, root);
  const response = event(peer, 9, 20, [
    ["e", root.id, "", "root"],
    ["e", parent.id, "", "reply"],
  ]);
  store.push(parent); // Root genuinely unavailable, not another counted row.
  owner.accept([response]);
  const stop = owner.capability.subscribeInbox(() => {});
  try {
    await vi.waitFor(() =>
      expect(owner.capability.inbox().items).toHaveLength(1),
    );
    const item = owner.capability.inbox().items[0];
    assert(item);
    expect(item).toMatchObject({
      id: `c0:${response.id}`,
      messageIds: [response.id],
      thread: true,
      unreadCount: 1,
    });
    expect(item.rootId).toBeUndefined();
    expect(item.target).toEqual({
      kind: "message",
      channelId: "c0",
      messageId: response.id,
    });
  } finally {
    stop();
  }
});

it("Activity recovers the root of a joined thread the window dropped", async () => {
  const { owner, store } = await setup();
  const root = event(viewer, 9, 10, []);
  const thread = (pubkey: string, time: number) =>
    event(pubkey, 9, time, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ]);
  const mine = thread(viewer, 20);
  const answer = thread(peer, 30);
  store.push(root);
  // The sampled window kept the thread's replies but not its root.
  owner.accept([mine, answer]);
  const stop = owner.capability.subscribeActivity("c0", () => {});
  try {
    expect(owner.capability.attention("c0", answer.id)).toMatchObject({
      category: "thread",
      unread: true,
    });
    await vi.waitFor(() =>
      expect(owner.capability.activity("c0").items).toEqual([
        expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
      ]),
    );
  } finally {
    stop();
  }
});

it("Activity recovers the dropped root of a read reply marked unread", async () => {
  const root = event(viewer, 9, 10, []);
  const thread = (pubkey: string, time: number) =>
    event(pubkey, 9, time, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ]);
  const mine = thread(viewer, 20);
  const answer = thread(peer, 30);
  const prior = newReadJournal();
  const { owner, store } = await setup({
    ...prior,
    state: { ...prior.state, frontiers: { [`msg:${answer.id}`]: 30 } },
  });
  store.push(root);
  owner.accept([mine, answer]);
  await owner.capability.markUnreadLocal({
    kind: "message",
    channelId: "c0",
    messageId: answer.id,
  });
  const stop = owner.capability.subscribeActivity("c0", () => {});
  try {
    expect(owner.capability.attention("c0", answer.id)).toMatchObject({
      category: "thread",
      unread: true,
    });
    await vi.waitFor(() =>
      expect(owner.capability.activity("c0").items).toEqual([
        expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
      ]),
    );
  } finally {
    stop();
  }
});

import { verifiedSymbol } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import {
  THREAD_FOLLOW_LIMIT,
  memoryThreadFollows,
  type ThreadFollowStorage,
} from "./thread-follows";
import { createUnread } from "./unread";

// Explicit follow choices against the real unread engine. Events are marked
// verified, as the transport delivers them; signatures are not under test.
let next = 0;
function event(
  pubkey: string,
  created_at: number,
  tags: string[][],
  channel = "c0",
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind: 9,
    created_at,
    content: "",
    tags: [["h", channel], ...tags],
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const reply = (
  pubkey: string,
  time: number,
  root: RelayEvent,
  parent = root,
  extra: string[][] = [],
) =>
  event(
    pubkey,
    time,
    [["e", root.id, "", "root"], ["e", parent.id, "", "reply"], ...extra],
    root.tags[0]?.[1],
  );
const viewer = "a".repeat(64),
  peer = "b".repeat(64);

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function setup(
  follows: ThreadFollowStorage = memoryThreadFollows(),
  initial?: ReadJournal,
) {
  let journal: ReadJournal | undefined = initial;
  // Nothing beyond the retained window: every parent lookup answers "not yours".
  const reader = {
    read: vi.fn(
      async (
        _filters: readonly { ids?: readonly string[] }[],
      ): Promise<RelayEvent[]> => [],
    ),
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
      channels: [
        { id: "c0", name: "Zero", members: [viewer] },
        { id: "c1", name: "One", members: [viewer] },
        { id: "dm", name: "Peer", members: [viewer, peer], channelType: "dm" },
      ],
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
  const owner = createUnread({ reads, channels, reader, viewer, follows });
  owners.push(owner);
  const unread = owner.capability;
  /** Settles the parent lookups that undecided replies queue. */
  const settled = async (...replies: RelayEvent[]) => {
    for (const item of replies)
      unread.attention(item.tags[0]?.[1] ?? "", item.id);
    await vi.waitFor(() => {
      for (const item of replies)
        expect(
          unread.attention(item.tags[0]?.[1] ?? "", item.id).pending,
        ).toBeUndefined();
    });
  };
  return { owner, unread, reader, settled, journal: () => journal };
}

it("follows a thread without replying, including nested replies under its root", async () => {
  const { owner, unread, settled } = await setup();
  const root = event(peer, 10, []);
  const direct = reply(peer, 20, root);
  const nested = reply(peer, 30, root, direct);
  owner.accept([root, direct, nested]);
  await settled(direct, nested);
  const channel = { kind: "channel", channelId: "c0" } as const;
  expect(unread.following("c0", root.id)).toBe(false);
  expect(unread.attention("c0", nested.id)).toMatchObject({
    status: "ineligible",
    unread: false,
  });
  expect(unread.snapshot(channel)).toMatchObject({
    observedCount: 1,
    attentionCount: 0,
  });
  const woken = vi.fn();
  const stop = unread.subscribeSync(woken);

  unread.follow("c0", root.id, true);

  expect(woken).toHaveBeenCalled();
  expect(unread.following("c0", root.id)).toBe(true);
  for (const item of [direct, nested])
    expect(unread.attention("c0", item.id)).toMatchObject({
      status: "eligible",
      category: "thread",
      rootId: root.id,
      unread: true,
    });
  expect(unread.snapshot(channel)).toMatchObject({
    observedCount: 3,
    attentionCount: 2,
  });
  expect(unread.activity("c0").items).toEqual([
    expect.objectContaining({ rootId: root.id, unreadCount: 2 }),
  ]);
  expect(unread.inbox().items).toEqual([
    expect.objectContaining({ rootId: root.id, thread: true }),
  ]);
  stop();
});

it("unfollows a participated thread until the viewer explicitly follows it again", async () => {
  const { owner, unread } = await setup();
  const authored = event(viewer, 10, []);
  const answer = reply(peer, 20, authored);
  const other = event(peer, 11, []);
  const mine = reply(viewer, 21, other);
  const sibling = reply(peer, 22, other);
  const nestedMine = reply(viewer, 23, other, sibling);
  owner.accept([authored, answer, other, mine, sibling, nestedMine]);
  expect(unread.following("c0", authored.id)).toBe(true);
  expect(unread.following("c0", other.id)).toBe(true);
  expect(unread.attention("c0", answer.id).category).toBe("thread");

  unread.follow("c0", authored.id, false);
  unread.follow("c0", other.id, false);

  expect(unread.following("c0", authored.id)).toBe(false);
  expect(unread.attention("c0", answer.id)).toMatchObject({
    status: "ineligible",
    unread: false,
  });
  expect(unread.attention("c0", sibling.id).category).toBeUndefined();
  expect(unread.activity("c0").items).toEqual([]);
  // Replying again does not undo an explicit unfollow; mentions still reach the viewer.
  const later = reply(viewer, 30, authored);
  const peerLater = reply(peer, 31, authored, later);
  const mention = reply(peer, 32, authored, authored, [["p", viewer]]);
  owner.accept([later, peerLater, mention]);
  expect(unread.following("c0", authored.id)).toBe(false);
  expect(unread.attention("c0", peerLater.id).category).toBeUndefined();
  expect(unread.attention("c0", mention.id)).toMatchObject({
    category: "mention",
    unread: true,
  });

  unread.follow("c0", authored.id, true);
  expect(unread.attention("c0", peerLater.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
});

it("alerts on every reply under a root the label shows as followed", async () => {
  const { owner, unread, settled } = await setup();
  // Replied only under a peer's nested reply.
  const root = event(peer, 10, []);
  const branch = reply(peer, 11, root);
  const mine = reply(viewer, 12, root, branch);
  // Wrote the root; peers then talk to each other under it.
  const authored = event(viewer, 13, []);
  const peerParent = reply(peer, 14, authored);
  // Mentioned once; the mention alone is not a follow.
  const mentionedRoot = event(peer, 15, []);
  const mention = reply(peer, 16, mentionedRoot, mentionedRoot, [
    ["p", viewer],
  ]);
  owner.accept([
    root,
    branch,
    mine,
    authored,
    peerParent,
    mentionedRoot,
    mention,
  ]);
  const direct = reply(peer, 20, root);
  const sibling = reply(peer, 21, root, direct);
  const peerToPeer = reply(peer, 22, authored, peerParent);
  const afterMention = reply(peer, 23, mentionedRoot);
  owner.accept([direct, sibling, peerToPeer, afterMention]);
  await settled(afterMention);
  const label = (rootId: string) => unread.following("c0", rootId);
  const category = (item: RelayEvent) =>
    unread.attention("c0", item.id).category;

  expect(label(root.id)).toBe(true);
  expect(category(direct)).toBe("thread");
  expect(category(sibling)).toBe("thread");
  expect(label(authored.id)).toBe(true);
  expect(category(peerToPeer)).toBe("thread");
  expect(label(mentionedRoot.id)).toBe(false);
  expect(unread.attention("c0", afterMention.id)).toMatchObject({
    status: "ineligible",
    unread: false,
  });
  expect(category(mention)).toBe("mention");

  unread.follow("c0", root.id, false);
  const again = reply(viewer, 30, root, direct);
  const later = reply(peer, 31, root, branch);
  owner.accept([again, later]);
  expect(label(root.id)).toBe(false);
  expect(category(sibling)).toBeUndefined();
  expect(category(later)).toBeUndefined();
});

it("follows a thread where a lookup found the viewer's older reply", async () => {
  const root = event(peer, 10, []);
  const branch = reply(peer, 11, root);
  const question = reply(peer, 12, root, branch);
  // The viewer's reply to the branch is outside the retained window.
  const older = reply(viewer, 5, root, branch);
  const { owner, unread, reader, settled } = await setup();
  reader.read.mockImplementation(async (filters) =>
    filters[0]?.ids ? [] : [older],
  );
  owner.accept([root, branch, question]);
  await settled(question);
  expect(unread.attention("c0", question.id).category).toBe("thread");
  expect(unread.following("c0", root.id)).toBe(true);
  const elsewhere = reply(peer, 20, root);
  owner.accept([elsewhere]);
  expect(unread.attention("c0", elsewhere.id).category).toBe("thread");
});

/** A relay holding older history: answers ID reads and the viewer's `#e`
 * reply lookups, as the transport filters would. */
function relayOf(...history: RelayEvent[]) {
  return async (filters: readonly { ids?: readonly string[] }[]) => {
    const filter = filters[0] as {
      ids?: readonly string[];
      authors?: readonly string[];
      "#e"?: readonly string[];
    };
    return history.filter((item) =>
      filter.ids
        ? filter.ids.includes(item.id)
        : filter.authors?.includes(item.pubkey) &&
          item.tags.some(
            ([name, id]) => name === "e" && !!id && filter["#e"]?.includes(id),
          ),
    );
  };
}

it("follows a revived thread whose root the viewer wrote outside the window", async () => {
  const root = event(viewer, 5, []);
  const answer = reply(peer, 6, root);
  const nested = reply(peer, 21, root, answer);
  const { owner, unread, reader, settled } = await setup();
  reader.read.mockImplementation(relayOf(root, answer));
  // Only the nested reply is retained; its parent is a peer's.
  owner.accept([nested]);
  await settled(nested);
  expect(unread.following("c0", root.id)).toBe(true);
  expect(unread.attention("c0", nested.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
});

it("follows a revived thread where the viewer replied on another branch", async () => {
  const root = event(peer, 5, []);
  const branch = reply(peer, 6, root);
  const mine = reply(viewer, 7, root, branch);
  const sibling = reply(peer, 20, root);
  const nested = reply(peer, 21, root, sibling);
  const { owner, unread, reader, settled } = await setup();
  reader.read.mockImplementation(relayOf(root, branch, mine));
  owner.accept([sibling, nested]);
  await settled(sibling, nested);
  expect(unread.following("c0", root.id)).toBe(true);
  expect(unread.attention("c0", nested.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
});

it("decides each reply by its own root when replies to one parent disagree", async () => {
  const mine = event(viewer, 1, []);
  const root = event(peer, 2, []);
  const parent = reply(peer, 3, root);
  // Queued first, this reply claims the viewer's unrelated root.
  const conflicting = reply(peer, 10, mine, parent);
  const honest = reply(peer, 11, root, parent);
  const { owner, unread, reader, settled } = await setup();
  reader.read.mockImplementation(relayOf(mine, root, parent));
  owner.accept([conflicting, honest]);
  await settled(conflicting, honest);
  expect(unread.following("c0", root.id)).toBe(false);
  expect(unread.attention("c0", honest.id).category).toBeUndefined();
  expect(unread.following("c0", mine.id)).toBe(true);
  expect(unread.attention("c0", conflicting.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
});

it("drains the lookups of many distinct revived threads once and stays idle", async () => {
  const history: RelayEvent[] = [];
  const nested = Array.from({ length: 2100 }, (_, i) => {
    const root = event(peer, 1, []);
    const parent = reply(peer, 2, root);
    history.push(root, parent);
    return reply(peer, 3 + i, root, parent);
  });
  const { owner, unread, reader, settled } = await setup();
  const asked = new Map<string, number>();
  const sizes: number[] = [];
  const relay = relayOf(...history);
  reader.read.mockImplementation(async (filters) => {
    for (const filter of filters as { ids?: string[]; "#e"?: string[] }[]) {
      if (filter.ids) sizes.push(filter.ids.length);
      for (const id of filter.ids ?? [])
        asked.set(`ids:${id}`, (asked.get(`ids:${id}`) ?? 0) + 1);
      for (const id of filter["#e"] ?? [])
        asked.set(`#e:${id}`, (asked.get(`#e:${id}`) ?? 0) + 1);
    }
    return relay(filters);
  });
  owner.accept(nested);
  // An active projection republishes after every batch.
  const stop = unread.subscribe({ kind: "channel", channelId: "c0" }, () => {});
  await settled(...nested);
  const reads = reader.read.mock.calls.length;
  for (let tick = 0; tick < 5; tick++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  unread.snapshot({ kind: "channel", channelId: "c0" });
  await settled(...nested);
  stop();
  expect(reader.read.mock.calls.length).toBe(reads);
  expect([...asked.values()].filter((count) => count > 1)).toEqual([]);
  // Each parent and root fetched once, and asked about once, 50 IDs a
  // filter at most: the relay plans 100 as a scan.
  expect(asked.size).toBe(2 * history.length);
  expect(Math.max(...sizes)).toBe(50);
}, 30000);

it("keys choices by channel and canonical root and keeps them across reload", async () => {
  const follows = memoryThreadFollows();
  const first = await setup(follows);
  const root = event(peer, 10, []);
  const answer = reply(peer, 20, root);
  // Another channel's reply that claims the same root is its own thread.
  const elsewhere = event(
    peer,
    21,
    [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ],
    "c1",
  );
  first.owner.accept([root, answer, elsewhere]);
  await first.settled(elsewhere);
  first.unread.follow("c0", root.id.toUpperCase(), true);
  expect(first.unread.following("c0", root.id)).toBe(true);
  expect(first.unread.following("c1", root.id)).toBe(false);
  expect(first.unread.attention("c1", elsewhere.id).category).toBeUndefined();
  first.owner.dispose();

  const second = await setup(follows);
  second.owner.accept([root, answer]);
  expect(second.unread.following("c0", root.id)).toBe(true);
  expect(second.unread.attention("c0", answer.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
  // A decided choice needs no conversation lookup.
  expect(second.reader.read).not.toHaveBeenCalled();
  expect(() => second.unread.follow("missing", root.id, true)).toThrow();
  expect(() => second.unread.follow("c0", "not-an-event", true)).toThrow();
});

it("leaves the saved choice and every projection unchanged when saving fails", async () => {
  const saved = memoryThreadFollows();
  const follows: ThreadFollowStorage = {
    ...saved,
    write() {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  };
  const { owner, unread, settled } = await setup(follows);
  const root = event(peer, 10, []);
  const answer = reply(peer, 20, root);
  owner.accept([root, answer]);
  await settled(answer);
  const woken = vi.fn();
  const stop = unread.subscribeSync(woken);
  expect(() => unread.follow("c0", root.id, true)).toThrow("Quota exceeded");
  expect(woken).not.toHaveBeenCalled();
  expect(unread.following("c0", root.id)).toBe(false);
  expect(unread.attention("c0", answer.id).category).toBeUndefined();
  expect(saved.read().size).toBe(0);
  stop();
});

it("applies another window's saved choice", async () => {
  let changed = () => {};
  let choices = new Map<string, boolean>();
  const follows: ThreadFollowStorage = {
    read: () => choices,
    write(next) {
      choices = new Map(next);
    },
    subscribe(listener) {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
  };
  const { owner, unread, settled } = await setup(follows);
  const root = event(peer, 10, []);
  const answer = reply(peer, 20, root);
  owner.accept([root, answer]);
  await settled(answer);
  const listener = vi.fn();
  const stop = unread.subscribe({ kind: "channel", channelId: "c0" }, listener);
  choices = new Map([[`c0:${root.id}`, true]]);
  changed();
  expect(unread.following("c0", root.id)).toBe(true);
  expect(listener).toHaveBeenCalled();
  expect(unread.attention("c0", answer.id).category).toBe("thread");
  stop();
});

it("recovers the same-channel root of a saved follow after restart without membership reads", async () => {
  const follows = memoryThreadFollows();
  const first = await setup(follows);
  const root = event(peer, 10, []);
  const parent = reply(peer, 11, root);
  const readBeforeRestart = reply(peer, 20, root, parent);
  const recent = reply(peer, 30, root, parent);
  first.unread.follow("c0", root.id, true);
  first.owner.dispose();
  const prior = first.journal() ?? newReadJournal();
  const second = await setup(follows, {
    ...prior,
    state: {
      ...prior.state,
      frontiers: {
        [`thread:${root.id}`]: 25,
        [`thread-activity:${root.id}`]: 25,
      },
    },
  });
  second.reader.read.mockImplementation(relayOf(root, parent));
  second.owner.accept([readBeforeRestart, recent]);
  const thread = { kind: "thread", channelId: "c0", rootId: root.id } as const;
  const channel = { kind: "channel", channelId: "c0" } as const;
  const stop = second.unread.subscribe(channel, () => {});
  const stopActivity = second.unread.subscribeActivity("c0", () => {});
  await vi.waitFor(() =>
    expect(second.unread.activity("c0").items).toEqual([
      expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
    ]),
  );
  expect(second.unread.snapshot(thread).observedCount).toBe(1);
  expect(second.unread.snapshot(channel).attentionCount).toBe(1);
  expect(second.reader.read).toHaveBeenCalled();
  expect(
    second.reader.read.mock.calls.every(([filters]) => !!filters[0]?.ids),
  ).toBe(true);
  expect(second.unread.attention("c0", readBeforeRestart.id).unread).toBe(
    false,
  );
  expect(second.unread.attention("c0", recent.id).unread).toBe(true);
  stopActivity();
  stop();
});

it("invalidates the evicted channel and Activity at the shared choice limit", async () => {
  const follows = memoryThreadFollows();
  const { owner, unread } = await setup(follows);
  const root = event(peer, 10, []);
  const answer = reply(peer, 20, root);
  owner.accept([root, answer]);
  unread.follow("c0", root.id, true);
  const channel = { kind: "channel", channelId: "c0" } as const;
  const notified = vi.fn();
  const activityNotified = vi.fn();
  const stop = unread.subscribe(channel, notified);
  const stopActivity = unread.subscribeActivity("c0", activityNotified);
  expect(unread.snapshot(channel).attentionCount).toBe(1);
  expect(unread.activity("c0").items).toHaveLength(1);
  for (let i = 0; i < THREAD_FOLLOW_LIMIT - 1; i++)
    unread.follow("c1", (10000 + i).toString(16).padStart(64, "0"), true);
  notified.mockClear();
  activityNotified.mockClear();
  unread.follow("c1", "f".repeat(64), true);
  expect(follows.read().has(`c0:${root.id}`)).toBe(false);
  expect(unread.snapshot(channel).attentionCount).toBe(0);
  expect(unread.activity("c0").items).toEqual([]);
  expect(notified).toHaveBeenCalled();
  expect(activityNotified).toHaveBeenCalled();
  stopActivity();
  stop();
});

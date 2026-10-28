import { verifiedSymbol } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { createRelaySession, UNREAD_BACKSTOP_INTERVAL } from "./session";
import { readJournal, type ReadJournal } from "./read-state-storage";
import { keypair, message, metadata, roster, signed } from "./testing";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function setup(count = 1) {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  let journal: ReadJournal | undefined;
  let receive: (events: readonly RelayEvent[]) => void = () => {};
  let live: LiveCallbacks | undefined;
  const marker = deferred(),
    profile = deferred();
  let holdMarker = false,
    holdProfile = false;
  const row = message(peer, "other", "unread evidence", 11);
  const trace: { kind: number | undefined; ms: number }[] = [];
  const started = performance.now();
  const profileSignals: (AbortSignal | undefined)[] = [];
  const query = vi.fn(
    async (filters: readonly ReadFilter[], signal?: AbortSignal) => {
      const kind = filters[0]?.kinds?.includes(9) ? 9 : filters[0]?.kinds?.[0];
      trace.push({ kind, ms: performance.now() - started });
      if (kind === 0) profileSignals.push(signal);
      const wait =
        kind === 0 && holdProfile
          ? profile.promise
          : kind === 30078 && holdMarker
            ? marker.promise
            : undefined;
      if (wait)
        await Promise.race([
          wait,
          new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      return kind === 9 ? [row] : [];
    },
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      readState: { decode: async () => [] },
      subscribe(callbacks) {
        live = callbacks;
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateStorage: {
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
    },
  );
  owners.push(owner);
  const ids = Array.from({ length: count }, (_, i) =>
    i === 0 ? "other" : `room-${i}`,
  );
  receive(
    ids.flatMap((id) => [
      roster(relay, id, [viewer.pubkey], 10),
      metadata(relay, id, id, 10),
    ]),
  );
  return {
    ...owner,
    viewer,
    relay,
    peer,
    row,
    query,
    trace,
    profileSignals,
    ids,
    receive,
    reconnect() {
      assert(live);
      live.state({ status: "connected", routes: [] });
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
      live.established();
    },
    /** A reconnect whose membership replay was continuous. */
    reconnectCovered() {
      assert(live);
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
      live.established(undefined, { route: "membership", continuous: true });
    },
    /** The live recovery tick, once a minute on a healthy connection. */
    recover() {
      assert(live);
      live.recover?.();
    },
    holdProfile() {
      holdProfile = true;
      return profile.release;
    },
    holdMarker() {
      holdMarker = true;
      return marker.release;
    },
    snapshot: () =>
      owner.session.unread.snapshot({ kind: "channel", channelId: "other" }),
  };
}

it("initial unread markers and evidence bypass held optional profiles without cancelling them", async () => {
  const h = setup();
  const release = h.holdProfile();
  let profileFinished = false;
  const profiles = h.session.profiles
    .ensure([h.peer.pubkey], "background")
    .finally(() => {
      profileFinished = true;
    });
  try {
    await h.session.unread.ensure();
    expect(h.trace.map(({ kind }) => kind)).toEqual([0, 30078, 9]);
    expect(profileFinished).toBe(false);
    expect(h.profileSignals).toHaveLength(1);
    expect(h.profileSignals[0]?.aborted).toBe(false);
    expect(h.snapshot().observedCount).toBe(1);
  } finally {
    release();
    await profiles;
  }
}, 15000);

it("evidence gets its own deadline after a failed marker read; marker errors stay visible", async () => {
  const h = setup();
  // Control the caller deadline directly instead of coupling this test to
  // Node's native timeout clock or the reader's separate job timer.
  const deadlines: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const release = h.holdMarker();
  try {
    const done = h.session.unread.ensure();
    await vi.waitFor(() =>
      expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
    );
    expect(deadlines).toHaveLength(1);
    const marker = deadlines[0];
    assert(marker);
    marker.abort(new DOMException("Marker deadline expired", "TimeoutError"));
    await done;
    expect(deadlines).toHaveLength(2);
    expect(deadlines[1]?.signal.aborted).toBe(false);
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9]);
    expect(h.snapshot()).toMatchObject({
      observedCount: 1,
      freshness: "observed",
    });
    expect(h.session.unread.sync()).toMatchObject({
      status: "error",
      completeness: "unknown",
    });
  } finally {
    timeout.mockRestore();
    release();
  }
  await h.session.unread.refresh();
  expect(h.session.unread.sync().status).toBe("reconciled");
});

it("queries all 278 membership IDs in 128-filter requests and publishes each landed request", async () => {
  const h = setup(278);
  const batches: string[][] = [];
  const first = message(h.peer, "other", "first", 11);
  const second = message(h.peer, "room-128", "second", 12);
  const last = message(h.peer, "room-277", "last", 13);
  const observed: (number | null)[] = [];
  h.session.unread.subscribe({ kind: "channel", channelId: "other" }, () => {
    observed.push(h.snapshot().observedCount);
  });
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9)) return [];
    if (!filters.some((filter) => filter["#h"])) return [];
    expect(filters.length).toBeLessThanOrEqual(128);
    // The viewer's authored page rides the first request. Windows are sized
    // so a roster this large stays within the budget: the least, 20 each.
    const ids = filters.flatMap((filter) => {
      if (filter.authors) return [];
      expect(filter["#h"]).toHaveLength(1);
      expect(filter).toMatchObject({
        include_aux: true,
        limit: 20,
        since: expect.any(Number),
      });
      return [filter["#h"]?.[0] ?? ""];
    });
    batches.push(ids);
    // Two requests run at once; the first has landed before a third starts.
    if (batches.length > 2) expect(h.snapshot().observedCount).toBe(1);
    return [first, second, last].filter((event) =>
      ids.includes(event.tags[0]?.[1] ?? ""),
    );
  });
  await h.session.unread.ensure();
  expect(batches).toHaveLength(3);
  expect(batches.flat().sort()).toEqual([...h.ids].sort());
  expect(observed).toContain(1);
  expect(
    h.session.unread.snapshot({ kind: "channel", channelId: "room-277" })
      .observedCount,
  ).toBe(1);
  expect(h.session.channels.window("room-277").rows).toEqual([]);
});

it("a full channel window does not starve later channels, and a dropped request leaves its channels unknown until explicit refresh", async () => {
  const h = setup(129);
  const rows = Array.from({ length: 100 }, (_, i) =>
    message(h.peer, "other", `busy ${i}`, 11 + i),
  );
  let fail = true;
  const batches: string[][] = [];
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9) || !filters.some((f) => f["#h"]))
      return [];
    const ids = filters.flatMap((filter) => filter["#h"] ?? []);
    batches.push(ids);
    if (ids.includes("other")) return rows;
    if (fail) throw new Error("Later chunk unavailable");
    return ids.map((id) => message(h.peer, id, "quiet", 11));
  });
  await h.session.unread.ensure();
  // The second request, the two windows beyond the first's 128 filters, is
  // read once more, then dropped; the busy channel's request landed, so the
  // Inbox is observed but partial.
  const attempted = batches.length;
  expect(attempted).toBe(1 + 2);
  expect(h.snapshot()).toMatchObject({
    observedCount: 100,
    freshness: "observed",
  });
  expect(h.session.unread.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
    partial: true,
  });
  expect(h.session.unread.inbox().error).toBeUndefined();
  const quiet = batches[1]?.[0];
  assert(quiet);
  const snapshot = () =>
    h.session.unread.snapshot({ kind: "channel", channelId: quiet });
  expect(snapshot().coverage).toBe("unknown");
  await h.session.unread.ensure();
  expect(batches).toHaveLength(attempted); // No automatic retry loop.
  fail = false;
  await h.session.unread.refresh();
  expect(batches).toHaveLength(attempted + 2);
  expect(h.snapshot()).toMatchObject({
    observedCount: 100,
    freshness: "observed",
  });
  expect(h.session.unread.inbox().partial).toBeUndefined();
  expect(snapshot()).toMatchObject({ observedCount: 1, freshness: "observed" });
});

function conversationRelay(h: ReturnType<typeof setup>) {
  // A relay whose channel window holds only the 100 newest rows and whose
  // page of the viewer's own messages holds none of these older replies, so
  // older conversation membership is reachable only by parent lookup.
  const store: RelayEvent[] = [];
  const lookups: ReadFilter[][] = [];
  let fail = false;
  const tagged = (event: RelayEvent, ids: readonly string[]) =>
    event.tags.some(
      ([name, value]) => name === "e" && ids.includes(value ?? ""),
    );
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9)) return [];
    if (filters[0].ids || (filters[0].authors && filters[0]["#e"])) {
      lookups.push([...filters]);
      if (fail) throw new Error("lookup failed");
    }
    return filters.flatMap((filter) =>
      filter.authors && !filter["#e"]
        ? []
        : [...store]
            .filter(
              (event) =>
                (!filter["#h"] ||
                  event.tags.some(
                    ([name, value]) =>
                      name === "h" && filter["#h"]?.includes(value ?? ""),
                  )) &&
                (!filter.ids || filter.ids.includes(event.id)) &&
                (!filter.authors || filter.authors.includes(event.pubkey)) &&
                (filter.until === undefined ||
                  event.created_at <= filter.until) &&
                (!filter["#e"] || tagged(event, filter["#e"])),
            )
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit),
    );
  });
  const asked = () =>
    lookups.flatMap((filters) =>
      filters.flatMap((filter) => (filter.authors ? (filter["#e"] ?? []) : [])),
    );
  const fetched = () =>
    lookups.flatMap((filters) => filters.flatMap((filter) => filter.ids ?? []));
  return {
    store,
    lookups,
    asked,
    fetched,
    fail(value: boolean) {
      fail = value;
    },
  };
}
const reply = (
  author: ReturnType<typeof keypair>,
  content: string,
  time: number,
  root: RelayEvent,
  parent: RelayEvent,
  channel = "other",
) =>
  message(author, channel, content, time, [
    ...(root === parent ? [] : [["e", root.id, "", "root"]]),
    ["e", parent.id, "", "reply"],
  ]);
const busy = (h: ReturnType<typeof setup>, count: number) =>
  Array.from({ length: count }, (_, i) =>
    message(h.peer, "other", `busy ${i}`, 100 + i),
  );

it("looks up conversation membership that falls outside the sampled window", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "other", "my old post", 10);
  const agentRoot = message(h.peer, "other", "agent post", 11);
  const myOldReply = reply(h.viewer, "my old reply", 12, agentRoot, agentRoot);
  const answer = reply(h.peer, "answer to me", 700, mine, mine);
  const sibling = reply(h.peer, "same level as me", 701, agentRoot, agentRoot);
  const nested = reply(h.peer, "nested, not mine", 702, agentRoot, sibling);
  const underAnswer = reply(
    h.peer,
    "nested under the answer",
    703,
    mine,
    answer,
  );
  // 100 newer rows fill the channel window and push out every older message.
  relay.store.push(
    mine,
    agentRoot,
    myOldReply,
    answer,
    sibling,
    nested,
    underAnswer,
    ...busy(h, 96),
  );
  await h.session.unread.ensure();
  const attention = (id: string) => h.session.unread.attention("other", id);
  // Before membership arrives, undecided replies stay quiet and pending.
  expect(attention(answer.id)).toMatchObject({
    status: "unknown",
    pending: true,
    unread: false,
  });
  expect(h.snapshot().observedCount).toBe(96);
  await vi.waitFor(() =>
    expect(attention(answer.id)).toMatchObject({
      status: "eligible",
      category: "thread",
      rootId: mine.id,
      unread: true,
    }),
  );
  await vi.waitFor(() =>
    expect(attention(sibling.id)).toMatchObject({
      category: "thread",
      unread: true,
    }),
  );
  // The viewer's thread membership covers every reply under its root.
  for (const item of [nested, underAnswer])
    await vi.waitFor(() =>
      expect(attention(item.id)).toMatchObject({
        category: "thread",
        unread: true,
      }),
    );
  // Fetched parents are structure only: the badge gains the four replies in
  // the viewer's threads, not the fetched old posts.
  expect(h.snapshot()).toMatchObject({ observedCount: 100, attentionCount: 4 });
  // Each undecided parent is asked once, scoped to its channel: by ID when
  // missing, and for the viewer's replies to it.
  expect(relay.asked().sort()).toEqual(
    [mine.id, agentRoot.id, sibling.id, answer.id].sort(),
  );
  expect(relay.fetched().sort()).toEqual([mine.id, agentRoot.id].sort());
  for (const filters of relay.lookups)
    for (const filter of filters)
      expect(filter).toMatchObject(
        filter.ids
          ? { include_aux: true, limit: filter.ids.length }
          : {
              authors: [h.viewer.pubkey],
              "#h": ["other"],
              include_aux: true,
              limit: 500,
            },
      );
  const count = relay.lookups.length;
  // Decided parents are not asked again; fetched parents start no lookup.
  h.session.unread.snapshot({ kind: "channel", channelId: "other" });
  h.session.unread.activity("other");
  await Promise.resolve();
  expect(relay.lookups).toHaveLength(count);
});

it("a reply whose parent and root are both outside the window still groups as the viewer's thread", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const root = message(h.peer, "other", "old root", 10);
  const mine = reply(h.viewer, "my old nested reply", 11, root, root);
  const answer = reply(h.peer, "agent answers me", 700, root, mine);
  relay.store.push(root, mine, answer, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  const attention = () => h.session.unread.attention("other", answer.id);
  await vi.waitFor(() =>
    expect(attention()).toMatchObject({
      status: "eligible",
      category: "thread",
      rootId: root.id,
      unread: true,
    }),
  );
  // The parent and the root are fetched together; neither recurses.
  expect(relay.fetched().sort()).toEqual([mine.id, root.id].sort());
  expect(h.snapshot()).toMatchObject({ observedCount: 100, attentionCount: 1 });
  expect(
    h.session.unread.snapshot({
      kind: "thread",
      channelId: "other",
      rootId: root.id,
    }).observedCount,
  ).toBe(1);
  expect(h.session.unread.activity("other").items).toMatchObject([
    { rootId: root.id, latestMessageId: answer.id },
  ]);
});

it("a full page of replies under one parent cannot hide the viewer's reply to another", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const busyRoot = message(h.peer, "other", "busy root", 10);
  const quietRoot = message(h.peer, "other", "quiet root", 11);
  const mineQuiet = reply(h.viewer, "my one reply", 12, quietRoot, quietRoot);
  const busyParent = reply(h.peer, "busy parent", 13, busyRoot, busyRoot);
  // 500 newer replies of the viewer deep under busyRoot match `#e` by root tag.
  const deep = Array.from({ length: 500 }, (_, i) =>
    reply(h.viewer, `deep ${i}`, 20 + i, busyRoot, busyParent),
  );
  const answer = reply(h.peer, "same level as me", 700, quietRoot, quietRoot);
  const peerUnderBusy = reply(
    h.peer,
    "under busy root",
    701,
    busyRoot,
    busyRoot,
  );
  relay.store.push(busyRoot, quietRoot, mineQuiet, busyParent, ...deep);
  relay.store.push(answer, peerUnderBusy, ...busy(h, 98));
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() =>
    expect(h.session.unread.attention("other", answer.id)).toMatchObject({
      category: "thread",
      unread: true,
    }),
  );
  // The viewer's deep replies make busyRoot's whole thread the viewer's.
  expect(h.session.unread.attention("other", peerUnderBusy.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
  expect(h.session.unread.attention("other", peerUnderBusy.id).pending).toBe(
    undefined,
  );
});

it("a busy root's deep replies of the viewer decide its thread in one page", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const root = message(h.peer, "other", "busy root", 10);
  const mine = reply(h.viewer, "my direct reply", 12, root, root);
  const nestedParent = reply(h.peer, "nested parent", 13, root, root);
  // 500 newer replies of the viewer, nested deeper, match `#e` by root tag.
  const deep = Array.from({ length: 500 }, (_, i) =>
    reply(h.viewer, `deep ${i}`, 20 + i, root, nestedParent),
  );
  const answer = reply(h.peer, "same level as me", 2000, root, root);
  relay.store.push(root, mine, nestedParent, ...deep, answer);
  relay.store.push(
    ...Array.from({ length: 99 }, (_, i) =>
      message(h.peer, "other", `busy ${i}`, 1000 + i),
    ),
  );
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() =>
    expect(h.session.unread.attention("other", answer.id)).toMatchObject({
      category: "thread",
      unread: true,
    }),
  );
  const pages = relay.lookups
    .flat()
    .filter((filter) => filter.authors && filter["#e"]?.includes(root.id));
  // Any reply of the viewer under the root makes the whole thread the
  // viewer's, so the first full page already decides it.
  expect(pages.map((filter) => filter.until)).toEqual([undefined]);
});

it("a reply to the viewer's message in another channel is not the viewer's conversation", async () => {
  const h = setup(2);
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "room-1", "my post elsewhere", 10);
  const forged = reply(h.peer, "claims my parent", 700, mine, mine);
  relay.store.push(mine, forged, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() =>
    expect(
      h.session.unread.attention("other", forged.id).pending,
    ).toBeUndefined(),
  );
  const forgedAttention = h.session.unread.attention("other", forged.id);
  expect(forgedAttention).toMatchObject({ unread: false });
  expect(forgedAttention.category).toBeUndefined();
});

it("a deleted reply of the viewer does not join its parent", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const agentRoot = message(h.peer, "other", "agent post", 10);
  const mine = reply(h.viewer, "my old reply", 11, agentRoot, agentRoot);
  const removal = signed(h.viewer, {
    kind: 5,
    content: "",
    created_at: 12,
    tags: [
      ["e", mine.id],
      ["h", "other"],
    ],
  });
  const sibling = reply(h.peer, "same level", 700, agentRoot, agentRoot);
  relay.store.push(agentRoot, mine, removal, sibling, ...busy(h, 99));
  // The fixture relay returns the deletion with include_aux lookups.
  const base = h.query.getMockImplementation();
  h.query.mockImplementation(async (filters, signal) => {
    const rows = (await base?.(filters, signal)) ?? [];
    return filters[0]?.authors && filters[0].include_aux
      ? [...rows, removal]
      : rows;
  });
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() =>
    expect(
      h.session.unread.attention("other", sibling.id).pending,
    ).toBeUndefined(),
  );
  expect(h.session.unread.attention("other", sibling.id).unread).toBe(false);
});

it("deleting the viewer's reply after a completed lookup ends the membership", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const agentRoot = message(h.peer, "other", "agent post", 10);
  const mine = reply(h.viewer, "my old reply", 11, agentRoot, agentRoot);
  const sibling = reply(h.peer, "same level", 700, agentRoot, agentRoot);
  relay.store.push(agentRoot, mine, sibling, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  const attention = () => h.session.unread.attention("other", sibling.id);
  await vi.waitFor(() =>
    expect(attention()).toMatchObject({ category: "thread", unread: true }),
  );
  const count = relay.lookups.length;
  // Another client deletes the old reply. This client never loaded it, so
  // the deletion must still pass the session's target-visibility check.
  expect(h.session.channels.window("other").rows).toEqual([]);
  h.receive([
    signed(h.viewer, {
      kind: 5,
      content: "",
      created_at: 800,
      tags: [
        ["h", "other"],
        ["e", mine.id],
      ],
    }),
  ]);
  expect(attention()).toMatchObject({ status: "ineligible", unread: false });
  expect(attention().category).toBeUndefined();
  const later = reply(h.peer, "another sibling", 801, agentRoot, agentRoot);
  h.receive([later]);
  expect(h.session.unread.attention("other", later.id).unread).toBe(false);
  expect(relay.lookups).toHaveLength(count);
});

it("deleting one of the viewer's replies keeps the membership its other replies hold", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const agentRoot = message(h.peer, "other", "agent post", 10);
  const older = reply(h.viewer, "my older reply", 11, agentRoot, agentRoot);
  const newer = reply(h.viewer, "my newer reply", 12, agentRoot, agentRoot);
  const sibling = reply(h.peer, "same level", 700, agentRoot, agentRoot);
  relay.store.push(agentRoot, older, newer, sibling, ...busy(h, 99));
  // The thread's page, read once the lookup finds the viewer in it, reaches
  // neither of their replies: membership rests on the lookup alone.
  const answer = h.query.getMockImplementation();
  assert(answer);
  h.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter["#e"] && !filter.authors)
      ? []
      : answer(filters),
  );
  await h.session.unread.ensure();
  h.snapshot();
  const attention = () => h.session.unread.attention("other", sibling.id);
  await vi.waitFor(() =>
    expect(attention()).toMatchObject({ category: "thread", unread: true }),
  );
  const asked = relay.lookups.length;
  relay.store.splice(relay.store.indexOf(newer), 1);
  h.receive([
    signed(h.viewer, {
      kind: 5,
      content: "",
      created_at: 800,
      tags: [
        ["h", "other"],
        ["e", newer.id],
      ],
    }),
  ]);
  // The deleted reply was the lookup's witness; the parent is asked again.
  await vi.waitFor(() => {
    expect(attention()).toMatchObject({ category: "thread", unread: true });
    expect(relay.lookups.length).toBeGreaterThan(asked);
  });
});

it("deleting the viewer's parent and then their reply ends the membership", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "other", "my old post", 10);
  const myReply = reply(h.viewer, "my reply to it", 11, mine, mine);
  const answer = reply(h.peer, "answer", 700, mine, mine);
  relay.store.push(mine, myReply, answer, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  const attention = () => h.session.unread.attention("other", answer.id);
  await vi.waitFor(() =>
    expect(attention()).toMatchObject({ category: "thread", unread: true }),
  );
  const remove = (target: RelayEvent, time: number) => {
    relay.store.splice(relay.store.indexOf(target), 1);
    h.receive([
      signed(h.viewer, {
        kind: 5,
        content: "",
        created_at: time,
        tags: [
          ["h", "other"],
          ["e", target.id],
        ],
      }),
    ]);
  };
  // Another client deletes the parent, then the reply; this client loaded
  // neither into its window.
  expect(h.session.channels.window("other").rows).toEqual([]);
  remove(mine, 800);
  await vi.waitFor(() => {
    expect(attention().pending).toBeUndefined();
    expect(attention()).toMatchObject({ category: "thread", unread: true });
  });
  remove(myReply, 801);
  await vi.waitFor(() => {
    expect(attention().pending).toBeUndefined();
    expect(attention()).toMatchObject({ unread: false });
  });
  expect(attention().category).toBeUndefined();
});

it("lookups for the same parent ID in two channels do not share a result", async () => {
  const h = setup(2);
  const relay = conversationRelay(h);
  const root = message(h.peer, "other", "peer post", 10);
  const mine = reply(h.viewer, "my old reply", 11, root, root);
  // A reply in another channel that deliberately tags the same parent.
  const elsewhere = reply(h.peer, "cross-channel", 700, root, root, "room-1");
  const sibling = reply(h.peer, "same level as me", 701, root, root);
  relay.store.push(root, mine, elsewhere, sibling, ...busy(h, 98));
  await h.session.unread.ensure();
  // The other channel asks first, in the same turn.
  h.session.unread.attention("room-1", elsewhere.id);
  h.session.unread.attention("other", sibling.id);
  await vi.waitFor(() =>
    expect(h.session.unread.attention("other", sibling.id)).toMatchObject({
      category: "thread",
      unread: true,
    }),
  );
  await vi.waitFor(() =>
    expect(
      h.session.unread.attention("room-1", elsewhere.id).pending,
    ).toBeUndefined(),
  );
  const elsewhereAttention = h.session.unread.attention("room-1", elsewhere.id);
  expect(elsewhereAttention).toMatchObject({ unread: false });
  expect(elsewhereAttention.category).toBeUndefined();
});

it("a lookup in flight during a cache clear cannot restore its result", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "other", "my old post", 10);
  const answer = reply(h.peer, "answer to me", 700, mine, mine);
  relay.store.push(mine, answer, ...busy(h, 99));
  const base = h.query.getMockImplementation();
  const held = deferred();
  let hold = true;
  h.query.mockImplementation(async (filters, signal) => {
    // Evaluate against the relay now; answer after the clear.
    const rows = (await base?.(filters, signal)) ?? [];
    const lookup =
      filters[0]?.kinds?.includes(9) &&
      (filters[0].ids || (filters[0].authors && filters[0]["#e"]));
    if (hold && lookup) await held.promise;
    return rows;
  });
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() => expect(relay.lookups.length).toBeGreaterThan(0));
  await h.clearCache();
  // After the clear, the viewer's post is gone from the relay.
  relay.store.splice(relay.store.indexOf(mine), 1);
  hold = false;
  held.release();
  const asked = relay.lookups.length;
  h.receive([
    roster(h.relay, "other", [h.viewer.pubkey], 11),
    metadata(h.relay, "other", "other", 11),
  ]);
  await h.session.unread.refresh();
  h.snapshot();
  await vi.waitFor(() => expect(relay.lookups.length).toBeGreaterThan(asked));
  await vi.waitFor(() =>
    expect(
      h.session.unread.attention("other", answer.id).pending,
    ).toBeUndefined(),
  );
  expect(h.session.unread.attention("other", answer.id).unread).toBe(false);
});

it("a failed membership lookup stays pending and retries with backoff", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "other", "my old post", 10);
  const answer = reply(h.peer, "answer to me", 700, mine, mine);
  relay.store.push(mine, answer, ...busy(h, 99));
  relay.fail(true);
  await h.session.unread.ensure();
  const attention = () => h.session.unread.attention("other", answer.id);
  h.snapshot();
  await vi.waitFor(() => expect(relay.lookups.length).toBeGreaterThan(0));
  const failed = relay.lookups.length;
  expect(attention()).toMatchObject({ pending: true, unread: false });
  relay.fail(false);
  // New evidence does not retry at once: the parent stays pending in backoff.
  h.receive([message(h.peer, "other", "new top-level", 800)]);
  h.snapshot();
  await Promise.resolve();
  expect(relay.lookups).toHaveLength(failed);
  await vi.waitFor(
    () =>
      expect(attention()).toMatchObject({ category: "thread", unread: true }),
    { timeout: 3000 },
  );
});

it.each(["clear", "dispose", "revoke", "join"])(
  "late chunk cannot publish or dispatch another after %s",
  async (boundary) => {
    const h = setup(129);
    const held = deferred(),
      fresh = deferred();
    const batches: string[][] = [];
    const windows = () => batches.filter((ids) => ids.length);
    h.query.mockImplementation(async (filters) => {
      if (!filters[0]?.kinds?.includes(9)) return [];
      const ids = filters.flatMap((filter) => filter["#h"] ?? []);
      batches.push(ids);
      // The two window requests in flight are held across the boundary.
      await (ids.length && windows().length <= 2
        ? held.promise
        : fresh.promise);
      return [h.row];
    });
    const repair = h.session.unread.ensure();
    await vi.waitFor(() => expect(windows()).toHaveLength(2));
    if (boundary === "dispose") h.dispose();
    else if (boundary === "clear") await h.clearCache();
    else if (boundary === "join")
      h.receive([roster(h.relay, "new-room", [h.viewer.pubkey], 20)]);
    else h.receive([roster(h.relay, "other", [], 20)]);
    held.release();
    await repair;
    if (boundary === "clear" || boundary === "dispose") {
      expect(windows()).toHaveLength(2);
      expect(h.snapshot().observedCount).toBeNull();
      return;
    }
    // The abandoned read starts over against the current membership.
    await vi.waitFor(() => expect(windows()).toHaveLength(4));
    expect(h.snapshot().observedCount).toBeNull();
    fresh.release();
    await h.session.unread.ensure();
    const reread = windows().slice(2).flat();
    if (boundary === "join") {
      expect(reread).toContain("new-room");
      expect(h.snapshot().observedCount).toBe(1);
    } else {
      expect(reread).toHaveLength(128);
      expect(reread).not.toContain("other");
      expect(h.snapshot().observedCount).toBeNull();
    }
  },
);

it("concurrent ensure callers share the active marker/evidence work", async () => {
  const h = setup();
  const release = h.holdMarker();
  const first = h.session.unread.ensure();
  await vi.waitFor(() =>
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
  );
  let finished = false;
  const second = h.session.unread.ensure().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(finished).toBe(false);
  release();
  await Promise.all([first, second]);
  expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9]);
  expect(h.snapshot().observedCount).toBe(1);
});

it("transient startup failure recovers on live reconnect without an automatic retry loop", async () => {
  const h = setup();
  let fail = true;
  h.query.mockImplementation(async (filters) => {
    if (filters[0]?.kinds?.includes(39002))
      return [
        roster(h.relay, "other", [h.viewer.pubkey], 10),
        metadata(h.relay, "other", "other", 10),
      ];
    if (!filters[0]?.kinds?.includes(9)) return [];
    if (fail) throw new Error("Transient evidence failure");
    return [h.row];
  });
  await h.session.unread.ensure();
  // Dropped after its one retry, and nothing else landed: the channel stays
  // unknown and the repair failed rather than claiming a partial observation.
  expect(h.snapshot().coverage).toBe("unknown");
  expect(h.session.unread.inbox()).toMatchObject({
    status: "error",
    freshness: "stale",
    error: "Transient evidence failure",
  });
  expect(h.session.unread.inbox().partial).toBeUndefined();
  const count = h.query.mock.calls.length;
  await h.session.unread.ensure();
  expect(h.query).toHaveBeenCalledTimes(count);
  fail = false;
  h.reconnect();
  await vi.waitFor(() =>
    expect(h.snapshot()).toMatchObject({
      observedCount: 1,
      freshness: "observed",
    }),
  );
  expect(h.session.unread.inbox().partial).toBeUndefined();
});

it("the recovery tick repairs unread only as a slow backstop after a connection's own repair", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
  try {
    const h = setup();
    const answer = h.query.getMockImplementation();
    assert(answer);
    // The reconnect's roster read keeps the joined channel.
    h.query.mockImplementation(async (filters, signal) =>
      filters[0]?.kinds?.includes(39002)
        ? [
            roster(h.relay, "other", [h.viewer.pubkey], 10),
            metadata(h.relay, "other", "other", 10),
          ]
        : answer(filters, signal),
    );
    await h.session.unread.ensure();
    const evidence = () => h.trace.filter(({ kind }) => kind === 9).length;
    const before = evidence();
    h.reconnect();
    await vi.waitFor(() => expect(evidence()).toBe(before + 1));
    // The fake clock still runs; the repair was asked at or before this.
    const repaired = Date.now();
    // A healthy minute: the live stream carried every unread change.
    for (let minute = 1; minute < 15; minute++) {
      vi.setSystemTime(repaired + minute * 60_000 - 1000);
      h.recover();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(evidence()).toBe(before + 1);
    vi.setSystemTime(repaired + UNREAD_BACKSTOP_INTERVAL);
    h.recover();
    await vi.waitFor(() => expect(evidence()).toBe(before + 2));
    h.recover();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(evidence()).toBe(before + 2);
  } finally {
    vi.useRealTimers();
  }
});

it("the recovery tick retries a failed unread repair at once, not after the backstop interval", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
  try {
    const h = setup();
    let fail = false;
    h.query.mockImplementation(async (filters) => {
      if (filters[0]?.kinds?.includes(39002))
        return [
          roster(h.relay, "other", [h.viewer.pubkey], 10),
          metadata(h.relay, "other", "other", 10),
        ];
      if (!filters[0]?.kinds?.includes(9)) return [];
      if (fail) throw new Error("Transient evidence failure");
      return [h.row];
    });
    await h.session.unread.ensure();
    fail = true;
    h.reconnect();
    await vi.waitFor(() =>
      expect(h.snapshot()).toMatchObject({
        freshness: "stale",
        error: "Transient evidence failure",
      }),
    );
    fail = false;
    vi.setSystemTime(Date.now() + 60_000);
    h.recover();
    await vi.waitFor(() =>
      expect(h.snapshot()).toMatchObject({
        observedCount: 1,
        freshness: "observed",
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("a live message after a failed unread repair does not cancel its retry", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
  try {
    const h = setup();
    let fail = false;
    h.query.mockImplementation(async (filters) => {
      if (filters[0]?.kinds?.includes(39002))
        return [
          roster(h.relay, "other", [h.viewer.pubkey], 10),
          metadata(h.relay, "other", "other", 10),
        ];
      if (!filters[0]?.kinds?.includes(9)) return [];
      if (fail) throw new Error("Transient evidence failure");
      return [h.row];
    });
    // The repair's read, not a lookup for one message.
    const evidence = () =>
      h.query.mock.calls.filter(
        ([filters]) =>
          filters[0]?.include_aux && filters[0]?.kinds?.includes(40002),
      ).length;
    await h.session.unread.ensure();
    fail = true;
    h.reconnect();
    await vi.waitFor(() =>
      expect(h.snapshot()).toMatchObject({
        freshness: "stale",
        error: "Transient evidence failure",
      }),
    );
    fail = false;
    // Live traffic marks the evidence observed, but other channels may still
    // miss what the failed repair would have read.
    h.receive([message(h.peer, "other", "live", 12)]);
    expect(h.snapshot()).toMatchObject({ freshness: "observed" });
    const before = evidence();
    vi.setSystemTime(Date.now() + 60_000);
    h.recover();
    await vi.waitFor(() => expect(evidence()).toBe(before + 1));
  } finally {
    vi.useRealTimers();
  }
});

it("a failed read-state snapshot is retried at once even when the evidence repair succeeds", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
  try {
    const h = setup();
    let fail = false;
    h.query.mockImplementation(async (filters) => {
      if (filters[0]?.kinds?.includes(39002))
        return [
          roster(h.relay, "other", [h.viewer.pubkey], 10),
          metadata(h.relay, "other", "other", 10),
        ];
      if (filters[0]?.kinds?.includes(30078) && fail)
        throw new Error("Transient snapshot failure");
      return filters[0]?.kinds?.includes(9) ? [h.row] : [];
    });
    const snapshots = () =>
      h.query.mock.calls.filter(([filters]) =>
        filters[0]?.kinds?.includes(30078),
      ).length;
    await h.session.unread.ensure();
    fail = true;
    const before = snapshots();
    // The backstop's snapshot read fails; its evidence read succeeds.
    vi.setSystemTime(Date.now() + UNREAD_BACKSTOP_INTERVAL);
    h.recover();
    await vi.waitFor(() => expect(snapshots()).toBe(before + 1));
    await vi.waitFor(() =>
      expect(h.session.unread.sync()).toMatchObject({ status: "error" }),
    );
    await vi.waitFor(() =>
      expect(h.snapshot()).toMatchObject({ freshness: "observed" }),
    );
    fail = false;
    vi.setSystemTime(Date.now() + 60_000);
    h.recover();
    await vi.waitFor(() => expect(snapshots()).toBe(before + 2));
  } finally {
    vi.useRealTimers();
  }
});

/** The recovery tick's own reads: unread evidence repairs and marker snapshots. */
function tickReads(h: ReturnType<typeof setup>) {
  const count = (match: (filter: ReadFilter) => boolean) =>
    h.query.mock.calls.filter(([filters]) => filters[0] && match(filters[0]))
      .length;
  return {
    evidence: count(
      (filter) => !!filter.include_aux && !!filter.kinds?.includes(40002),
    ),
    snapshots: count((filter) => !!filter.kinds?.includes(30078)),
  };
}

it("a covered reconnect pays the drop's debt: the next recovery tick reads nothing", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
  try {
    const h = setup();
    const answer = h.query.getMockImplementation();
    assert(answer);
    h.query.mockImplementation(async (filters, signal) =>
      filters[0]?.kinds?.includes(39002)
        ? [
            roster(h.relay, "other", [h.viewer.pubkey], 10),
            metadata(h.relay, "other", "other", 10),
          ]
        : answer(filters, signal),
    );
    await h.session.unread.ensure();
    h.reconnect();
    await vi.waitFor(() =>
      expect(tickReads(h)).toEqual({ evidence: 2, snapshots: 2 }),
    );
    h.reconnectCovered();
    // It resumes the markers and repairs the evidence.
    await vi.waitFor(() =>
      expect(tickReads(h)).toEqual({ evidence: 3, snapshots: 2 }),
    );
    await vi.waitFor(() =>
      expect(h.session.unread.sync().status).toBe("reconciled"),
    );
    const before = tickReads(h);
    vi.setSystemTime(Date.now() + 60_000);
    h.recover();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tickReads(h)).toEqual(before);
  } finally {
    vi.useRealTimers();
  }
});

it("a covered reconnect does not postpone the recovery tick's full unread repair", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
  try {
    const h = setup();
    const answer = h.query.getMockImplementation();
    assert(answer);
    h.query.mockImplementation(async (filters, signal) =>
      filters[0]?.kinds?.includes(39002)
        ? [
            roster(h.relay, "other", [h.viewer.pubkey], 10),
            metadata(h.relay, "other", "other", 10),
          ]
        : answer(filters, signal),
    );
    await h.session.unread.ensure();
    // A full repair reads the read-state snapshot; a covered one resumes it.
    const snapshots = () => h.trace.filter(({ kind }) => kind === 30078).length;
    const evidence = () => h.trace.filter(({ kind }) => kind === 9).length;
    h.reconnect();
    await vi.waitFor(() => expect(snapshots()).toBe(2));
    const repaired = Date.now();
    vi.setSystemTime(repaired + 10 * 60_000);
    const before = evidence();
    h.reconnectCovered();
    await vi.waitFor(() => expect(evidence()).toBe(before + 1));
    expect(snapshots()).toBe(2);
    vi.setSystemTime(repaired + UNREAD_BACKSTOP_INTERVAL);
    h.recover();
    await vi.waitFor(() => expect(snapshots()).toBe(3));
  } finally {
    vi.useRealTimers();
  }
});

it("a reconnect repair in which nothing lands keeps the observation stale instead of claiming it observed", async () => {
  const h = setup();
  await h.session.unread.ensure();
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    freshness: "observed",
  });
  h.query.mockImplementation(async (filters) => {
    if (filters[0]?.kinds?.includes(39002))
      return [
        roster(h.relay, "other", [h.viewer.pubkey], 10),
        metadata(h.relay, "other", "other", 10),
      ];
    if (filters[0]?.kinds?.includes(9)) throw new Error("Relay read timed out");
    return [];
  });
  const count = h.query.mock.calls.length;
  h.reconnect();
  // The one request is read twice, then dropped; nothing was observed.
  await vi.waitFor(() =>
    expect(
      h.query.mock.calls
        .slice(count)
        .filter(([filters]) => filters[0]?.kinds?.includes(9)),
    ).toHaveLength(2),
  );
  await vi.waitFor(() =>
    expect(h.session.unread.inbox()).toMatchObject({
      status: "error",
      freshness: "stale",
      error: "Relay read timed out",
    }),
  );
  expect(h.snapshot()).toMatchObject({ observedCount: 1, freshness: "stale" });
  expect(h.session.unread.inbox().partial).toBeUndefined();
});

it("a relay that accepts reads but answers none costs one read per request after the first drop", async () => {
  const h = setup(300);
  const batches: string[][] = [];
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9) || !filters.some((f) => f["#h"]))
      return [];
    batches.push(filters.flatMap((filter) => filter["#h"] ?? []));
    throw new Error("Relay read timed out");
  });
  await h.session.unread.ensure();
  // Three requests (the authored page and 299 windows, then 128, then 45):
  // the first is read twice, the last once; the second, in flight beside
  // the first, at most twice. Six reads would mean a retry per request.
  const sizes = batches.map((batch) => batch.length);
  expect(sizes.filter((size) => size === 127)).toHaveLength(2);
  expect(sizes.filter((size) => size === 45)).toHaveLength(1);
  expect(batches.length).toBeLessThanOrEqual(5);
  expect(h.session.unread.inbox()).toMatchObject({
    status: "error",
    freshness: "stale",
  });
  expect(h.snapshot().coverage).toBe("unknown");
});

it("a full budget evicts the oldest evidence and the observation still completes", async () => {
  const h = setup(129);
  const oldest = message(h.peer, "other", "x".repeat(450000), 11);
  h.receive([
    oldest,
    ...Array.from({ length: 17 }, (_, i) =>
      message(h.peer, "other", "x".repeat(450000), i + 12),
    ),
  ]);
  expect(h.snapshot().observedCount).toBe(18);
  expect(h.session.unread.attention("other", oldest.id).unread).toBe(true);
  const overflow = message(h.peer, "other", "x".repeat(450000), 40);
  let batches = 0;
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9)) return [];
    batches++;
    return [overflow];
  });
  await h.session.unread.ensure();
  // Every window request still runs.
  expect(batches).toBe(2);
  expect(h.snapshot()).toMatchObject({
    observedCount: 18,
    freshness: "observed",
  });
  expect(h.snapshot().error).toBeUndefined();
  expect(h.session.unread.attention("other", overflow.id).unread).toBe(true);
  expect(h.session.unread.attention("other", oldest.id).unread).toBe(false);
});

it("a response over the reader's byte budget splits the request and the repair completes", async () => {
  const h = setup(40);
  // 40 channels of 76 messages of 3,000 bytes: the roster's windows ride one
  // request, whose response is ~10 MB, over the 8 MiB the real reader admits.
  // Events are marked verified, as the transport would have, and recent, so
  // the never-read channels' week-long windows reach them.
  let sequence = 0;
  const recent = Math.floor(Date.now() / 1000) - 3600;
  const rows = new Map(
    h.ids.map((id) => [
      id,
      Array.from(
        { length: 76 },
        (_, i): RelayEvent => ({
          id: (sequence++).toString(16).padStart(64, "0"),
          pubkey: h.peer.pubkey,
          kind: 9,
          created_at: recent + i,
          content: "x".repeat(3000),
          tags: [["h", id]],
          sig: "0".repeat(128),
          [verifiedSymbol]: true,
        }),
      ),
    ]),
  );
  h.query.mockImplementation(async (filters) =>
    filters.flatMap((filter) => {
      const channel = filter["#h"]?.[0];
      const since = filter.since;
      if (!filter.kinds?.includes(9) || !channel || since === undefined)
        return [];
      return (rows.get(channel) ?? [])
        .filter((event) => event.created_at >= since)
        .slice(-filter.limit);
    }),
  );
  await h.session.unread.ensure();
  // The 41-filter request is split in two, each within the budget.
  const windowed = h.query.mock.calls
    .map(([filters]) => filters)
    .filter((filters) => filters.some((filter) => filter.kinds?.includes(9)));
  expect(windowed.map((filters) => filters.length)).toEqual([41, 21, 20]);
  // The evidence lands, trimmed to the 8 MiB retained budget channel by
  // channel, rather than failing the repair with nothing observed.
  for (const id of h.ids) {
    const snapshot = h.session.unread.snapshot({
      kind: "channel",
      channelId: id,
    });
    expect(snapshot).toMatchObject({
      coverage: "observed",
      freshness: "observed",
    });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.observedCount).toBeGreaterThanOrEqual(50);
    expect(snapshot.observedCount).toBeLessThanOrEqual(76);
  }
  expect(h.session.unread.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
  });
  expect(h.session.unread.inbox().partial).toBeUndefined();
});

it("a response the native host rejects as too large splits the request the same way", async () => {
  const h = setup(40);
  // Native reads at most 16 MiB (`read_response`) and rejects before the
  // reader can measure, with the plain string its IPC carries.
  const recent = Math.floor(Date.now() / 1000) - 3600;
  h.query.mockImplementation(async (filters) => {
    // The whole roster's windows in one request are over the cap; either half fits.
    if (filters.length > 30) throw "Relay response is too large";
    return filters.flatMap((filter) => {
      const channel = filter["#h"]?.[0];
      if (!filter.kinds?.includes(9) || !channel || filter.since === undefined)
        return [];
      return [
        {
          ...message(h.peer, channel, "recent", recent),
          [verifiedSymbol]: true,
        },
      ];
    });
  });
  await h.session.unread.ensure();
  const windowed = h.query.mock.calls
    .map(([filters]) => filters)
    .filter((filters) => filters.some((filter) => filter.kinds?.includes(9)));
  expect(windowed.map((filters) => filters.length)).toEqual([41, 21, 20]);
  for (const id of h.ids)
    expect(
      h.session.unread.snapshot({ kind: "channel", channelId: id }),
    ).toMatchObject({
      coverage: "observed",
      freshness: "observed",
      observedCount: 1,
    });
  expect(h.session.unread.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
  });
  expect(h.session.unread.inbox().partial).toBeUndefined();
});

it.each(["clear", "dispose", "revoke"])(
  "no evidence dispatch after %s while markers are pending",
  async (boundary) => {
    const h = setup(129);
    const release = h.holdMarker();
    const repair = h.session.unread.ensure();
    await vi.waitFor(() =>
      expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
    );
    if (boundary === "dispose") h.dispose();
    else if (boundary === "clear") await h.clearCache();
    else h.receive([roster(h.relay, "other", [], 20)]);
    release();
    await repair;
    if (boundary !== "revoke") {
      expect(h.trace.map(({ kind }) => kind)).toEqual([30078]);
      return;
    }
    // Only a fresh observation without the revoked channel is dispatched.
    await h.session.unread.ensure();
    const evidence = h.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(9) && filter["#h"]);
    expect(evidence).toHaveLength(128);
    expect(evidence.flatMap((filter) => filter["#h"] ?? [])).not.toContain(
      "other",
    );
  },
);

it("a subscriber clearing cache during progressive publication stops later chunks", async () => {
  const h = setup(129);
  let cleared: Promise<void> | undefined;
  h.session.unread.subscribe({ kind: "channel", channelId: "other" }, () => {
    if (h.snapshot().observedCount === 1) cleared = h.clearCache();
  });
  await h.session.unread.ensure();
  await cleared;
  // The two requests in flight land; nothing further is dispatched.
  expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9, 9]);
  expect(h.snapshot().observedCount).toBeNull();
});

it("explicit refresh bypasses optional profiles for both markers and evidence", async () => {
  const h = setup();
  await h.session.unread.ensure();
  const release = h.holdProfile();
  const profiles = h.session.profiles.ensure([h.peer.pubkey], "background");
  try {
    await h.session.unread.refresh();
    expect(h.profileSignals[0]?.aborted).toBe(false);
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9, 0, 30078, 9]);
  } finally {
    release();
    await profiles;
  }
}, 15000);

it("observes a channel again when the viewer regains access to it", async () => {
  const h = setup();
  await h.session.unread.ensure();
  expect(h.snapshot().observedCount).toBe(1);
  h.receive([roster(h.relay, "other", [], 20)]);
  expect(h.snapshot().observedCount).toBeNull();
  h.receive([roster(h.relay, "other", [h.viewer.pubkey], 30)]);
  await vi.waitFor(() => expect(h.snapshot().observedCount).toBe(1));
});

// Repair reads of one batch, in dispatch order. Lookups carry ids or authors.
const evidenceReads = (h: ReturnType<typeof setup>) =>
  h.query.mock.calls
    .map(([filters]) => filters[0])
    .filter((f) => f?.kinds?.includes(9) && f["#h"] && !f.authors && !f.ids);
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** The name a relay read gives channels, unlike the name the live roster gave. */
const DISCOVERED = "discovered";
/** Serves one fixed answer to repair reads and the roster to the reconnect's roster read. */
function serve(h: ReturnType<typeof setup>, rows: () => readonly RelayEvent[]) {
  h.query.mockImplementation(async (filters) => {
    if (filters[0]?.kinds?.includes(39002))
      return [
        roster(h.relay, "other", [h.viewer.pubkey], 10),
        metadata(h.relay, "other", DISCOVERED, 20),
      ];
    if (filters[0]?.kinds?.includes(39000))
      return [metadata(h.relay, "other", DISCOVERED, 20)];
    return filters[0]?.kinds?.includes(9) ? [...rows()] : [];
  });
}

/** The first roster read after a live-only roster is a discovery that bumps the
 * access epoch once and so forgets every mark. Take it before observing. Names
 * are read after the roster is applied and its access change has been purged,
 * so a channel named by the read means that discovery is over. */
async function discovered(h: ReturnType<typeof setup>) {
  expect(
    h.session.channels.list().channels.map(({ name }) => name),
  ).not.toContain(DISCOVERED);
  h.reconnect();
  await vi.waitFor(() =>
    expect(
      h.session.channels.list().channels.map(({ name }) => name),
    ).toContain(DISCOVERED),
  );
}

it("a repair after a complete observation reads only near the newest event it returned", async () => {
  const h = setup();
  const newest = nowSeconds() - 1000;
  const row = message(h.peer, "other", "recent", newest);
  serve(h, () => [row]);
  await discovered(h);
  await h.session.unread.ensure();
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  const [first, second] = evidenceReads(h);
  expect(first?.since).toBeUndefined();
  expect(second).toMatchObject({ since: newest - 960, limit: 500 });
  expect(second?.["#h"]).toEqual(first?.["#h"]);
});

it("a batch that returned nothing is read unbounded again", async () => {
  const h = setup();
  serve(h, () => []);
  await discovered(h);
  await h.session.unread.ensure();
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  expect(evidenceReads(h)[1]?.since).toBeUndefined();
});

it("a future-dated event cannot move the next repair past the present", async () => {
  const h = setup();
  const before = nowSeconds();
  const row = message(h.peer, "other", "skewed", before + 100_000);
  serve(h, () => [row]);
  await discovered(h);
  await h.session.unread.ensure();
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  const since = evidenceReads(h)[1]?.since;
  expect(since).toBeGreaterThanOrEqual(before - 960);
  expect(since).toBeLessThanOrEqual(nowSeconds() - 960);
});

it("a repair never reads from before the newest event it already returned", async () => {
  const h = setup();
  const newest = nowSeconds() - 1000;
  let rows = [message(h.peer, "other", "recent", newest)];
  serve(h, () => rows);
  await discovered(h);
  await h.session.unread.ensure();
  // The overlap returns only an older row: the mark must not move back to it.
  rows = [message(h.peer, "other", "older", newest - 200)];
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(3));
  expect(evidenceReads(h)[2]?.since).toBe(newest - 960);
});

it("regaining access reads the batch unbounded, not from the old mark", async () => {
  const h = setup();
  const row = message(h.peer, "other", "recent", nowSeconds() - 1000);
  serve(h, () => [row]);
  await h.session.unread.ensure();
  h.receive([roster(h.relay, "other", [], 20)]);
  h.receive([roster(h.relay, "other", [h.viewer.pubkey], 30)]);
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  expect(evidenceReads(h)[1]?.since).toBeUndefined();
});

it("an explicit refresh re-observes unbounded", async () => {
  const h = setup();
  const row = message(h.peer, "other", "recent", nowSeconds() - 1000);
  serve(h, () => [row]);
  await discovered(h);
  await h.session.unread.ensure();
  await h.session.unread.refresh();
  expect(evidenceReads(h)).toHaveLength(2);
  expect(evidenceReads(h)[1]?.since).toBeUndefined();
});

it("clearing the cache re-observes unbounded", async () => {
  const h = setup();
  const row = message(h.peer, "other", "recent", nowSeconds() - 1000);
  serve(h, () => [row]);
  await discovered(h);
  await h.session.unread.ensure();
  await h.clearCache();
  h.receive([
    roster(h.relay, "other", [h.viewer.pubkey], 20),
    metadata(h.relay, "other", "other", 20),
  ]);
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  expect(evidenceReads(h)[1]?.since).toBeUndefined();
});

it("capacity overflow discards the mark with the evidence it described", async () => {
  const h = setup();
  const recent = nowSeconds() - 1000;
  const row = message(h.peer, "other", "recent", recent);
  let rows: readonly RelayEvent[] = [row];
  serve(h, () => rows);
  await discovered(h);
  await h.session.unread.ensure();
  h.receive(
    Array.from({ length: 18 }, (_, i) =>
      message(h.peer, "other", "x".repeat(450000), i + 11),
    ),
  );
  rows = [message(h.peer, "other", "x".repeat(450000), recent + 1)];
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  await vi.waitFor(() =>
    expect(h.snapshot().error).toBe(
      "Unread observation capacity reached; refresh available",
    ),
  );
  rows = [row];
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(3));
  expect(evidenceReads(h)[1]?.since).toBe(recent - 960);
  expect(evidenceReads(h)[2]?.since).toBeUndefined();
});

/** A relay that honors `limit` (newest first) and `since` on evidence reads, and
 * answers every roster read with all the viewer's channels. */
function serveWindow(
  h: ReturnType<typeof setup>,
  rows: () => readonly RelayEvent[],
) {
  h.query.mockImplementation(async (filters) => {
    const filter = filters[0];
    if (filter?.kinds?.includes(39002))
      return h.ids.flatMap((id) => [
        roster(h.relay, id, [h.viewer.pubkey], 10),
        metadata(h.relay, id, DISCOVERED, 20),
      ]);
    if (filter?.kinds?.includes(39000))
      return h.ids.map((id) => metadata(h.relay, id, DISCOVERED, 20));
    if (!filter?.kinds?.includes(9) || filter.ids || filter.authors) return [];
    return rows()
      .filter((event) => event.created_at >= (filter.since ?? 0))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, filter.limit ?? Infinity);
  });
}

it("a read cut off at its limit installs no bound, so a freed slot still shows an older unread message", async () => {
  const h = setup(2);
  const t = nowSeconds();
  const busy = Array.from({ length: 500 }, (_, i) =>
    message(h.peer, "other", `busy ${i}`, t - 100 - i),
  );
  // Older than the newest busy message by more than the repair overlap.
  const quiet = message(h.peer, "room-1", "quiet", t - 5000);
  let rows: readonly RelayEvent[] = [...busy, quiet];
  serveWindow(h, () => rows);
  const quietCount = () =>
    h.session.unread.snapshot({ kind: "channel", channelId: "room-1" })
      .observedCount;
  await discovered(h);
  await h.session.unread.ensure();
  // The busy channel filled the sample; the quiet message was cut off.
  expect(evidenceReads(h)[0]).toMatchObject({ limit: 500 });
  expect(quietCount()).not.toBe(1);
  // One recent message is deleted; its slot is free for the quiet one.
  rows = rows.filter((event) => event !== busy[0]);
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  expect(evidenceReads(h)[1]?.since).toBeUndefined();
  await vi.waitFor(() => expect(quietCount()).toBe(1));
});

it("a bounded read that comes back at its limit drops the bound for the next read", async () => {
  const h = setup();
  const t = nowSeconds();
  let rows: readonly RelayEvent[] = [
    message(h.peer, "other", "first", t - 100),
    message(h.peer, "other", "second", t - 101),
  ];
  serveWindow(h, () => rows);
  await discovered(h);
  await h.session.unread.ensure();
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  // The first read was short, so the second one is bounded.
  expect(evidenceReads(h)[1]?.since).toBe(t - 100 - 960);
  // A burst fills the bounded read to its limit: it may have cut rows off.
  rows = Array.from({ length: 500 }, (_, i) =>
    message(h.peer, "other", `burst ${i}`, t - 50 - i),
  );
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(3));
  expect(evidenceReads(h)[2]?.since).toBeDefined();
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(4));
  expect(evidenceReads(h)[3]?.since).toBeUndefined();
});

/** Holds the next repair read until released; later reads answer at once. */
function holdNextRepair(h: ReturnType<typeof setup>) {
  const gate = deferred();
  const answer = h.query.getMockImplementation();
  assert(answer);
  let held = false;
  h.query.mockImplementation(async (filters, signal) => {
    const filter = filters[0];
    if (
      !held &&
      filter?.kinds?.includes(9) &&
      filter["#h"] &&
      !filter.authors &&
      !filter.ids
    ) {
      held = true;
      await gate.promise;
    }
    return answer(filters, signal);
  });
  return gate.release;
}

it("a bounded repair answered after a live overflow restores no mark and keeps the overflow error", async () => {
  const h = setup();
  const recent = nowSeconds() - 1000;
  const row = message(h.peer, "other", "recent", recent);
  serve(h, () => [row]);
  await discovered(h);
  await h.session.unread.ensure();
  const release = holdNextRepair(h);
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  expect(evidenceReads(h)[1]?.since).toBe(recent - 960);
  const running = h.session.unread.ensure();
  // Live traffic overflows the evidence while the bounded read is out.
  h.receive(
    Array.from({ length: 19 }, (_, i) =>
      message(h.peer, "other", "x".repeat(450000), i + 11),
    ),
  );
  const overflowed = {
    observedCount: null,
    freshness: "stale",
    error: "Unread observation capacity reached; refresh available",
  };
  expect(h.snapshot()).toMatchObject(overflowed);
  release();
  await running;
  expect(h.snapshot()).toMatchObject(overflowed);
  // The next repair reads in full: the late answer did not restore its mark.
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(3));
  expect(evidenceReads(h)[2]?.since).toBeUndefined();
});

it("an explicit refresh during a bounded repair waits for it, then reads in full", async () => {
  const h = setup();
  const recent = nowSeconds() - 1000;
  const row = message(h.peer, "other", "recent", recent);
  serve(h, () => [row]);
  let markers = 0;
  const answer = h.query.getMockImplementation();
  assert(answer);
  h.query.mockImplementation(async (filters, signal) => {
    const result = await answer(filters, signal);
    if (filters[0]?.kinds?.includes(30078)) markers++;
    return result;
  });
  await discovered(h);
  await h.session.unread.ensure();
  const release = holdNextRepair(h);
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(2));
  expect(evidenceReads(h)[1]?.since).toBe(recent - 960);
  const answered = markers;
  const refreshed = h.session.unread.refresh();
  // The refresh has synced markers and reached the running repair, still held.
  await vi.waitFor(() => expect(markers).toBe(answered + 1));
  release();
  await refreshed;
  expect(evidenceReads(h)).toHaveLength(3);
  expect(evidenceReads(h)[2]?.since).toBeUndefined();
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    freshness: "observed",
  });
});

it("a refresh asked while a repair's answer is being accepted still reads in full", async () => {
  const h = setup();
  const recent = nowSeconds() - 1000;
  let rows = [message(h.peer, "other", "recent", recent)];
  serve(h, () => rows);
  await discovered(h);
  await h.session.unread.ensure();
  rows = [...rows, message(h.peer, "other", "newer", recent + 10)];
  let refreshed: Promise<void> | undefined;
  // Accepting the repair's answer notifies subscribers synchronously.
  const stop = h.session.unread.subscribe(
    { kind: "channel", channelId: "other" },
    () => {
      if (!refreshed && h.snapshot().observedCount === 2)
        refreshed = h.session.unread.refresh();
    },
  );
  try {
    h.reconnect();
    await vi.waitFor(() => expect(refreshed).toBeDefined());
    await refreshed;
  } finally {
    stop();
  }
  expect(evidenceReads(h)).toHaveLength(3);
  expect(evidenceReads(h)[1]?.since).toBe(recent - 960);
  expect(evidenceReads(h)[2]?.since).toBeUndefined();
});

it("renaming a channel does not move the batches, so they keep their bounds", async () => {
  const h = setup(130);
  const recent = nowSeconds() - 1000;
  const names = new Map(h.ids.map((id) => [id, `n-${id}`]));
  const rows = new Map(
    h.ids.map((id) => [id, message(h.peer, id, "recent", recent)]),
  );
  h.query.mockImplementation(async (filters) => {
    const filter = filters[0];
    if (filter?.kinds?.includes(39002))
      return h.ids.flatMap((id) => [
        roster(h.relay, id, [h.viewer.pubkey], 10),
        metadata(h.relay, id, names.get(id) ?? id, 20),
      ]);
    if (filter?.kinds?.includes(39000))
      return h.ids.map((id) => metadata(h.relay, id, names.get(id) ?? id, 20));
    if (!filter?.kinds?.includes(9) || filter.authors || filter.ids) return [];
    return (filter["#h"] ?? []).flatMap((id) => rows.get(id) ?? []);
  });
  h.reconnect();
  await vi.waitFor(() =>
    expect(
      h.session.channels.list().channels.map(({ name }) => name),
    ).toContain("n-other"),
  );
  await h.session.unread.ensure();
  expect(evidenceReads(h).map((read) => read?.since)).toEqual([
    undefined,
    undefined,
  ]);
  // Sorted by name, "other" moves from the first batch to the last.
  names.set("other", "zzz");
  h.receive([metadata(h.relay, "other", "zzz", 30)]);
  await vi.waitFor(() =>
    expect(
      h.session.channels.list().channels.map(({ name }) => name),
    ).toContain("zzz"),
  );
  h.reconnect();
  await vi.waitFor(() => expect(evidenceReads(h)).toHaveLength(4));
  expect(evidenceReads(h).map((read) => read?.since)).toEqual([
    undefined,
    undefined,
    recent - 960,
    recent - 960,
  ]);
});

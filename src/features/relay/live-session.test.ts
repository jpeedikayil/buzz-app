import { ReadError } from "./errors";
import { assert, expect, it, vi, afterEach } from "vitest";
import { createRelaySession } from "./session";
import type { ChannelStoreOptions } from "./store";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { headRecovering } from "./live-recovery";
import { EMOJI_SET } from "./emoji";
import { readJournal, type ReadJournal } from "./read-state-storage";
// The real host codec, as read-state.test.ts uses it.
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Node-only host module
} from "../../../browser-host/read-state.mjs";
import { matchesEvent } from "./projection";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
  type Scripted,
} from "./testing";

it("clears retained repository homes on live recovery, cache clearing, and disposal", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const seed = async () => {
    const pending = owner.session.repositories.home(
      "repo-channel",
      new AbortController().signal,
    );
    wire.next().respond([]);
    await pending;
    expect(owner.session.repositories.peekHome("repo-channel")).toEqual({
      status: "none",
    });
  };
  try {
    await seed();
    live.state({ status: "connected", routes: [] });
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
    await seed();
    await owner.clearCache();
    expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
    await seed();
  } finally {
    owner.dispose();
  }
  expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
});

it("establishing a large roster reads only retained windows, not every channel head", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    const ids = Array.from({ length: 128 }, (_, i) => `channel-${i}`);
    const first = ids[0];
    assert.exists(first);
    live.receive(ids.map((id) => roster(relay, id, [viewer.pubkey])));
    owner.session.channels.ensure(first);
    const initial = wire.next();
    initial.respond([
      bounds(relay, first, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    live.state({ status: "connected", routes: [] });
    for (const id of ids) live.established(id);
    await flush();
    const catchup = wire.next();
    expect(catchup.filters[0]?.["#h"]).toEqual([ids[0]]);
    catchup.respond([
      bounds(relay, first, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(
      owner.session.live.snapshot().heads.filter((h) => h.state === "verified"),
    ).toHaveLength(1);
    expect(
      owner.session.live.snapshot().heads.filter((h) => h.state === "deferred"),
    ).toHaveLength(127);
  } finally {
    owner.dispose();
  }
});

it("a skipped warm head cannot hide the stream gap behind its freshness lease", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { prepared: true },
  );
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    owner.session.channels.prepare?.("a");
    const warm = wire.next();
    warm.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(owner.retainedChannels()).toEqual([]);
    expect(owner.diagnostics().heads.entries).toBe(1);
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(owner.session.live.snapshot().heads[0]?.state).toBe("deferred");
    // Same wall-clock: freshness lease has not expired, but post-gap read is still required.
    owner.session.channels.ensure("a");
    await flush();
    const demand = wire.next();
    expect(demand.filters[0]?.["#h"]).toEqual(["a"]);
    demand.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(owner.session.channels.window("a").freshness).toBe("verified");
    expect(
      owner.session.live.snapshot().heads.find((h) => h.channelId === "a")
        ?.state,
    ).toBe("verified");
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.channels.window("a").freshness).toBe("cached");
  } finally {
    owner.dispose();
  }
});

it("keeps a failed head recovery-owned from a dropped stream until the re-established head settles", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const route = (status: "pending" | "live") => ({
    id: "channel:a",
    channelId: "a",
    status,
    replay: "unknown" as const,
  });
  const owned = () => headRecovering(owner.session.live.snapshot(), "a");
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    owner.session.channels.ensure("a");
    wire
      .next()
      .respond([
        bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    live.state({ status: "connected", routes: [route("live")] });
    live.established("a");
    await flush();
    wire.next().fail(new ReadError("unavailable", "Bad gateway", 502));
    await flush();
    expect(owned()).toBe(true);
    // The drop clears catch-up entries; reconnecting re-reads the head.
    live.state({ status: "retrying", routes: [route("pending")] });
    expect(owner.session.live.snapshot().heads).toEqual([]);
    expect(owned()).toBe(true);
    // Authenticated before the channel's EOSE: no entry yet, route pending.
    live.state({ status: "connected", routes: [route("pending")] });
    expect(owner.session.live.snapshot().heads).toEqual([]);
    expect(owned()).toBe(true);
    live.state({ status: "connected", routes: [route("live")] });
    live.established("a");
    await flush();
    expect(owned()).toBe(true);
    wire
      .next()
      .respond([
        bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    expect(
      owner.session.live.snapshot().heads.find((h) => h.channelId === "a")
        ?.state,
    ).toBe("verified");
    expect(owned()).toBe(false);
  } finally {
    owner.dispose();
  }
});

afterEach(() => vi.useRealTimers());
it("post-subscribe demand supersedes a pre-stream head and prioritizes the current retained reader", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const priority = vi.fn();
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, prioritize: priority, retry() {}, dispose() {} };
    },
  });
  try {
    live.receive(["a", "z"].map((id) => roster(relay, id, [viewer.pubkey])));
    owner.session.channels.ensure("a");
    const oldA = wire.next();
    oldA.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    owner.session.channels.ensure("z");
    const oldZ = wire.next();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    live.established("z");
    await flush();
    const current = wire.next();
    expect(current.filters[0]?.["#h"]).toEqual(["z"]);
    expect(oldZ.signal?.aborted).toBe(true);
    expect(priority.mock.lastCall?.[0][0]).toBe("z");
    current.respond([
      bounds(relay, "z", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    const other = wire.next();
    expect(other.filters[0]?.["#h"]).toEqual(["a"]);
    other.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "verified"),
    ).toBe(true);
  } finally {
    owner.dispose();
  }
});
it("long API pause keeps lightweight catch-up obligations; retry does not drain or bypass cooldown", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    live.receive(["a", "b"].map((id) => roster(relay, id, [viewer.pubkey])));
    for (const id of ["a", "b"]) {
      owner.session.channels.ensure(id);
      wire
        .next()
        .respond([
          bounds(relay, id, "head", { has_more: false, next_cursor: null }),
        ]);
      await flush();
    }
    live.state({ status: "connected", routes: [] });
    live.established("a");
    live.established("b");
    await flush();
    wire
      .next()
      .fail(new ReadError("unavailable", "Relay requests paused", 429, 60000));
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "error"),
    ).toBe(true);
    owner.session.live.retry();
    owner.session.channels.ensure("a");
    await flush();
    expect(wire.pending).toHaveLength(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValue(performance.now() + 61000);
    owner.session.live.retry();
    await flush();
    const retry = wire.next();
    retry.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    const second = wire.next();
    second.respond([
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    clock.mockRestore();
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "verified"),
    ).toBe(true);
  } finally {
    vi.restoreAllMocks();
    owner.dispose();
  }
});

it.each([1, 2, 130])(
  "catch-up preserves unread evidence for a %s-channel roster",
  async (count) => {
    const relay = keypair(),
      viewer = keypair(),
      peer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      const ids = Array.from(
        { length: count },
        (_, i) => `room-${i.toString().padStart(3, "0")}`,
      );
      const first = ids[0];
      assert.exists(first);
      live.receive(ids.map((id) => roster(relay, id, [viewer.pubkey])));
      owner.session.channels.ensure(first);
      const oldHead = wire.next();
      const repair = owner.session.unread.ensure();
      await flush();
      // Per-channel windows ride up to four single-channel filters per
      // request, two requests in flight beside the head; the viewer's
      // newest messages ride the first request, for the participation pass.
      await vi.waitFor(() =>
        expect(wire.pending[0]?.filters[1]?.since).toEqual(expect.any(Number)),
      );
      const evidence = wire.next();
      // One page per channel, sized so the roster's windows fit the budget.
      expect(evidence.filters[1]).toMatchObject({
        "#h": [first],
        include_aux: true,
        limit: Math.max(20, Math.min(100, Math.floor(3072 / count))),
        since: expect.any(Number),
      });
      // Force the production race: both the old head and unread batch are still
      // in flight when the live route establishes. Only the old head is obsolete.
      live.state({ status: "connected", routes: [] });
      live.established(first);
      await flush();
      expect(oldHead.signal?.aborted).toBe(true);
      expect(evidence.signal?.aborted).toBe(false);
      const answered: string[] = [];
      const sampled: string[] = [];
      let authored = 0;
      const answer = (batch: Scripted) => {
        expect(batch.filters.length).toBeLessThanOrEqual(128);
        const batchIds = batch.filters.flatMap((filter) => {
          if (filter.authors) {
            authored++;
            expect(filter).toMatchObject({
              authors: [viewer.pubkey],
              include_aux: true,
              limit: 100,
            });
            return [];
          }
          // The roster sample: up to 128 channels a request, with no start.
          if (filter.since === undefined) {
            expect(filter).toMatchObject({ include_aux: true, limit: 500 });
            expect(filter["#h"]?.length).toBeLessThanOrEqual(128);
            sampled.push(...(filter["#h"] ?? []));
            return filter["#h"] ?? [];
          }
          expect(filter["#h"]).toHaveLength(1);
          answered.push(filter["#h"]?.[0] ?? "");
          return [filter["#h"]?.[0] ?? ""];
        });
        batch.respond(
          batchIds.map((id) =>
            message(peer, id, "unread evidence", 1700000900),
          ),
        );
      };
      answer(evidence);
      let heads = 0;
      while (
        answered.length < ids.length ||
        sampled.length < ids.length ||
        heads === 0
      ) {
        await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
        const batch = wire.next();
        if (batch.filters[0]?.top_level) {
          heads++;
          expect(batch.filters[0]).toMatchObject({ "#h": [first] });
          batch.respond([
            bounds(relay, first, "head", {
              has_more: false,
              next_cursor: null,
            }),
          ]);
        } else answer(batch);
      }
      expect(heads).toBe(1);
      expect([...answered].sort()).toEqual([...ids].sort());
      expect([...sampled].sort()).toEqual([...ids].sort());
      while (!authored) {
        await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
        answer(wire.next());
      }
      expect(authored).toBe(1);
      await flush();
      await repair;
      expect(wire.pending).toHaveLength(0);
      for (const channelId of ids) {
        const snapshot = owner.session.unread.snapshot({
          kind: "channel",
          channelId,
        });
        expect(snapshot).toMatchObject({
          observedCount: 1,
          freshness: "observed",
        });
        expect(snapshot.error).toBeUndefined();
      }
      // Evidence repair must not populate timeline windows or undo catch-up.
      expect(owner.session.channels.window(first).rows).toEqual([]);
      expect(
        owner.session.live.snapshot().heads.find((h) => h.channelId === first)
          ?.state,
      ).toBe("verified");
    } finally {
      owner.dispose();
    }
  },
);

function reconnectHarness(options: ChannelStoreOptions = {}) {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { prepared: true, ...options },
  );
  const window = () => owner.session.channels.window("c");
  const rows = () => window().rows.map((row) => row.id);
  /** Outstanding channel window reads; merged rows also queue profile reads.
   * A read the reader cancelled stays on the wire, aborted. */
  const reads = () =>
    wire.pending.filter(
      (entry) => !entry.signal?.aborted && entry.filters[0]?.top_level === true,
    );
  /** The one outstanding window read, after answering profile reads empty. */
  const read = (channelId = "c") => {
    for (const entry of wire.pending.splice(0)) {
      if (entry.signal?.aborted) continue;
      if (entry.filters[0]?.kinds?.includes(0)) entry.respond([]);
      else wire.pending.push(entry);
    }
    expect(wire.pending.map((entry) => entry.filters)).toMatchObject([
      [{ "#h": [channelId], top_level: true }],
    ]);
    return wire.next();
  };
  const page = (
    suffix: string,
    events: readonly ReturnType<typeof message>[],
    next: ReturnType<typeof message> | null,
    channelId = "c",
  ) => [
    ...events,
    bounds(relay, channelId, suffix, {
      has_more: next !== null,
      next_cursor: next ? { created_at: next.created_at, id: next.id } : null,
    }),
  ];
  /** Read the roster: channel c and `others`, with no window open yet. */
  const list = async (others: readonly string[] = []) => {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond(
        ["c", ...others].flatMap((id) => [
          roster(relay, id, [viewer.pubkey]),
          metadata(relay, id, id.toUpperCase()),
        ]),
      );
    await flush();
  };
  /** Open channel c with `seen` loaded and more history behind it. */
  const open = async (seen: ReturnType<typeof message>) => {
    owner.session.channels.ensure("c");
    await flush();
    read().respond(page("head", [seen], seen));
    await flush();
    expect(rows()).toEqual([seen.id]);
  };
  /** Open channel c with `seen` loaded and more history behind it, then reconnect. */
  const reconnect = async (
    seen: ReturnType<typeof message>,
    others: readonly string[] = [],
  ) => {
    await list(others);
    await open(seen);
    live.state({ status: "connected", routes: [] });
    live.established("c");
    await flush();
  };
  /** Drop the stream, with no reconnect yet. */
  const drop = async () => {
    live.state({ status: "retrying", routes: [] });
    await flush();
  };
  const cursor = (event: ReturnType<typeof message>) =>
    `${event.created_at}:${event.id}`;
  /** Connect; the establishment replays `replayed` before EOSE. */
  const connectAndReplay = async (replayed: readonly RelayEvent[]) => {
    live.state({ status: "connected", routes: [] });
    live.receive(replayed);
    await flush();
    live.established("c");
    await flush();
  };
  /** Drop the stream; the later re-establishment replays `replayed` before EOSE. */
  const dropAndReplay = async (replayed: readonly RelayEvent[]) => {
    await drop();
    await connectAndReplay(replayed);
  };
  return {
    owner,
    alice,
    wire,
    get live() {
      return live;
    },
    window,
    rows,
    reads,
    read,
    page,
    list,
    open,
    reconnect,
    drop,
    connectAndReplay,
    dropAndReplay,
    cursor,
  };
}
type ReconnectHarness = ReturnType<typeof reconnectHarness>;

it("a reconnect catch-up head newer than every loaded row pages back until it reaches one", async () => {
  // Live replay covers minutes. The head alone would leave the loaded rows on
  // screen with a silent gap before it; each page merges as it lands.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      old = message(h.alice, "c", "old", 5);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [missed], missed));
    await flush();
    expect(h.rows()).toEqual([seen.id, missed.id]);
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: 30,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      error: undefined,
    });
    expect(h.reads()).toHaveLength(0);
    // Reads older than any loaded page still wait for paging to reach them.
    const read = h.owner.session.read([{ ids: [old.id], limit: 1 }]);
    const entry = h.wire.pending.find((entry) => entry.filters[0]?.ids);
    assert(entry);
    entry.respond([old]);
    await read;
    expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
  } finally {
    h.owner.dispose();
  }
});

it("a reconnect catch-up that never reaches a loaded row drops it and continues from its last page", async () => {
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10);
    // Newest first: the head returns the first, then one row per page.
    const missed = [6, 5, 4, 3, 2, 1].map((n) =>
      message(h.alice, "c", `missed ${n}`, 10 + n * 10),
    );
    // The re-established stream delivers a row while the fill is in flight.
    const arrived = message(h.alice, "c", "arrived", 100);
    await h.reconnect(seen);
    let previous: (typeof missed)[number] | undefined;
    for (const [index, row] of missed.entries()) {
      const read = h.read();
      if (previous)
        expect(read.filters[0]).toMatchObject({
          until: previous.created_at,
          before_id: previous.id,
        });
      read.respond(h.page(previous ? h.cursor(previous) : "head", [row], row));
      await flush();
      if (index === 2) {
        h.live.receive([arrived]);
        await flush();
      }
      previous = row;
    }
    // Five pages past the head never reached `seen`: it goes rather than
    // sitting below a gap, and older history continues from the last page.
    // The row the stream delivered meanwhile stays.
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([
      ...missed.map((row) => row.id).reverse(),
      arrived.id,
    ]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      historyLimited: false,
      error: undefined,
    });
    h.owner.session.channels.loadOlder("c");
    expect(h.read().filters[0]).toMatchObject({
      until: previous?.created_at,
      before_id: previous?.id,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a reconnect catch-up whose head reaches a loaded row verifies the window with that one read", async () => {
  // The path every renewal takes: a healthy window costs one head read. This
  // is also the cold start: `reconnect` opens the window before any stream is
  // up, so the rows read over HTTP then are the first catch-up's snapshot.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      missed = message(h.alice, "c", "missed", 30);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [missed, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, missed.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it.each<
  [
    string,
    (h: ReconnectHarness) => void,
    (h: ReconnectHarness) => void,
    string | undefined,
  ]
>([
  ["fails", (h) => h.read().fail(new Error("offline")), () => {}, "offline"],
  [
    "is cancelled by the stream dropping",
    (h) => {
      h.read();
      h.live.state({ status: "retrying", routes: [] });
    },
    (h) => h.live.state({ status: "connected", routes: [] }),
    undefined,
  ],
])(
  "a catch-up fill whose page %s settles the window on the pages merged, and a retry pages on from there",
  async (_, interrupt, recover, error) => {
    // Were the loaded rows kept below the hole, the retry's head would overlap
    // the rows above it and certify the window with the hole still in it.
    const h = reconnectHarness();
    try {
      const seen = message(h.alice, "c", "seen", 10),
        between = message(h.alice, "c", "between", 20),
        missed = message(h.alice, "c", "missed", 30);
      await h.reconnect(seen);
      h.read().respond(h.page("head", [missed], missed));
      await flush();
      h.read().respond(h.page(h.cursor(missed), [between], between));
      await flush();
      expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
      interrupt(h);
      await flush();
      expect(h.rows()).toEqual([between.id, missed.id]);
      expect(h.window()).toMatchObject({
        status: "ready",
        freshness: "cached",
        hasMore: true,
        error,
      });
      recover(h);
      h.live.established("c");
      await flush();
      h.read().respond(h.page("head", [missed], missed));
      await flush();
      expect(h.reads()).toHaveLength(0);
      expect(h.rows()).toEqual([between.id, missed.id]);
      expect(h.window()).toMatchObject({
        status: "ready",
        freshness: "verified",
        hasMore: true,
        error: undefined,
      });
      // A verified head owns the cursor; the rows below it stay, and older
      // history pages on through them to the rows the fill never reached.
      h.owner.session.channels.loadOlder("c");
      const older = h.read();
      expect(older.filters[0]).toMatchObject({
        until: missed.created_at,
        before_id: missed.id,
      });
      older.respond(h.page(h.cursor(missed), [between, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
    } finally {
      h.owner.dispose();
    }
  },
);

it("a catch-up fill page denied after its head purges the channel as a denied head would", async () => {
  // Settling on the pages read would keep the head just fetched on screen
  // after the relay refused the reader.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      fresh = message(h.alice, "c", "fresh", 30);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [fresh], fresh));
    await flush();
    expect(h.rows()).toEqual([seen.id, fresh.id]);
    h.read().fail(new ReadError("denied", "restricted: not a member", 403));
    await flush();
    expect(h.rows()).toEqual([]);
    expect(h.window().status).toBe("error");
    expect(
      h.owner.session.channels.list().channels.map((channel) => channel.id),
    ).not.toContain("c");
  } finally {
    h.owner.dispose();
  }
});

it("rows the re-established stream replays before catch-up are not overlap with the rows kept across the drop", async () => {
  // Replay covers the five minutes before reconnect, so the head always
  // overlaps it. The rows kept across the drop are what the fill must reach.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    expect(h.window().freshness).toBe("verified");
    await h.dropAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.rows()).toEqual([seen.id, missed.id, recent.id]);
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("an interrupted fill drops the rows kept across the drop and retains the replayed ones", async () => {
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.dropAndReplay([recent]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    h.read().fail(new Error("offline"));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "cached",
      hasMore: true,
      error: "offline",
    });
  } finally {
    h.owner.dispose();
  }
});

it("a fill the stream drop interrupts settles on rows the next catch-up must reach in turn", async () => {
  // The drop is seen before the cancelled page is; the settled window, not
  // the rows replayed after this second drop, is what its catch-up must reach.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40),
      later = message(h.alice, "c", "later", 50);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.dropAndReplay([recent]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    h.read();
    await h.dropAndReplay([later]);
    expect(h.rows()).toEqual([missed.id, recent.id, later.id]);
    h.read().respond(h.page("head", [later], later));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: later.created_at,
      before_id: later.id,
    });
    older.respond(h.page(h.cursor(later), [recent, missed], missed));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([missed.id, recent.id, later.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a second drop before any catch-up completes keeps the rows kept across the first", async () => {
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40),
      later = message(h.alice, "c", "later", 50);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.dropAndReplay([recent]);
    // The first catch-up's head is still outstanding when the stream drops again.
    h.read();
    await h.dropAndReplay([later]);
    expect(h.rows()).toEqual([seen.id, recent.id, later.id]);
    h.read().respond(h.page("head", [later, recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([
      seen.id,
      between.id,
      missed.id,
      recent.id,
      later.id,
    ]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a channel opened while the stream is down keeps the head it read for its catch-up to reach", async () => {
  // Its window has no drop-time snapshot. Were the rows at catch-up time the
  // snapshot, the replay among them would be the head's overlap, and the gap
  // between that head read and the replay would never be paged.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.list();
    h.live.state({ status: "connected", routes: [] });
    await h.drop();
    await h.open(seen);
    await h.dropAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a window evicted and re-created while the stream is down snapshots the head it re-reads, not the stale cached one", async () => {
  // The cached head it adopts is replaced by a fresh read before the stream
  // is back. Were the cached rows the snapshot, the catch-up would page after
  // rows no longer in the window until the bound, then drop the fresh ones.
  const h = reconnectHarness({ maxWindows: 1 });
  try {
    const old = message(h.alice, "c", "old", 5),
      seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.reconnect(old, ["d"]);
    await h.drop();
    // Opening d evicts c's window; c's head stays cached.
    h.owner.session.channels.ensure("d");
    await flush();
    h.read("d").respond(h.page("head", [], null, "d"));
    await flush();
    expect(h.rows()).toEqual([]);
    h.owner.session.channels.ensure("c");
    await flush();
    expect(h.rows()).toEqual([old.id]);
    // The cached head is stale, so the window revalidates it while still down.
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    expect(h.rows()).toEqual([seen.id]);
    await h.dropAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a window with no rows at the drop snapshots the head it reads while the stream is down", async () => {
  // An empty drop-time snapshot means contiguous. Were it kept past the head
  // read while down, that head's rows would never be reached and the gap
  // between them and the replay would be certified.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.list();
    h.owner.session.channels.ensure("c");
    await flush();
    h.read().respond(h.page("head", [], null));
    await flush();
    expect(h.rows()).toEqual([]);
    await h.connectAndReplay([]);
    h.read().respond(h.page("head", [], null));
    await flush();
    expect(h.window().freshness).toBe("verified");
    await h.drop();
    // Revisiting while down revalidates the stale cached head.
    h.owner.session.channels.ensure("c");
    await flush();
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    expect(h.rows()).toEqual([seen.id]);
    await h.dropAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("rows read before the first connection are the first catch-up's snapshot, not the rows after replay", async () => {
  // A first connect that takes longer than the replay covers (the socket
  // down while HTTP is up) leaves the same gap as a reconnect.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.list();
    await h.open(seen);
    await h.connectAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a fill whose last page lands in the tick the stream drops reports the window cached", async () => {
  // The fill reached the rows kept across the drop, but the stream is
  // retrying: the window is not verified until the next catch-up is.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40),
      later = message(h.alice, "c", "later", 50);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.dropAndReplay([recent]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    const older = h.read();
    // The stream drops as the page that reaches `seen` is being merged: the
    // drop is seen before the fill completes, after the page it would cancel.
    const unsubscribe = h.owner.session.channels.subscribeWindow("c", () => {
      unsubscribe();
      h.live.state({ status: "retrying", routes: [] });
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "cached",
      error: undefined,
    });
    // The rows the fill settled are what the next catch-up must reach.
    await h.dropAndReplay([later]);
    h.read().respond(h.page("head", [later, recent], recent));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([
      seen.id,
      between.id,
      missed.id,
      recent.id,
      later.id,
    ]);
    expect(h.window().freshness).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});

it("an older page read while the stream is down waits below a settled fill until paging reaches it", async () => {
  // Those rows are not in the drop-time snapshot, so a fill that gives up on
  // the snapshot does not drop them; the settle's cursor hides them below the
  // window's floor until an older read from the last page reaches them.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      old = message(h.alice, "c", "old", 5);
    const missed = [6, 5, 4, 3, 2, 1].map((n) =>
      message(h.alice, "c", `missed ${n}`, 10 + n * 10),
    );
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.drop();
    h.owner.session.channels.loadOlder("c");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: seen.created_at,
      before_id: seen.id,
    });
    older.respond(h.page(h.cursor(seen), [old], old));
    await flush();
    expect(h.rows()).toEqual([old.id, seen.id]);
    await h.dropAndReplay([]);
    let previous: (typeof missed)[number] | undefined;
    for (const row of missed) {
      h.read().respond(
        h.page(previous ? h.cursor(previous) : "head", [row], row),
      );
      await flush();
      previous = row;
    }
    assert(previous);
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual(missed.map((row) => row.id).reverse());
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
    });
    h.owner.session.channels.loadOlder("c");
    const next = h.read();
    expect(next.filters[0]).toMatchObject({
      until: previous.created_at,
      before_id: previous.id,
    });
    next.respond(h.page(h.cursor(previous), [seen, old], old));
    await flush();
    expect(h.rows()).toEqual([
      old.id,
      seen.id,
      ...missed.map((row) => row.id).reverse(),
    ]);
  } finally {
    h.owner.dispose();
  }
});

it("an older page still in flight when a catch-up fill settles is discarded, and paging continues from the settled fill", async () => {
  // It continues from the cursor the settle replaced: merged, its rows would
  // sit directly below the hole and move the floor past it as verified.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      old = message(h.alice, "c", "old", 5);
    const missed = [6, 5, 4, 3, 2, 1].map((n) =>
      message(h.alice, "c", `missed ${n}`, 10 + n * 10),
    );
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.drop();
    h.owner.session.channels.loadOlder("c");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: seen.created_at,
      before_id: seen.id,
    });
    await h.connectAndReplay([]);
    let previous: (typeof missed)[number] | undefined;
    for (const row of missed) {
      h.read().respond(
        h.page(previous ? h.cursor(previous) : "head", [row], row),
      );
      await flush();
      previous = row;
    }
    assert(previous);
    older.respond(h.page(h.cursor(seen), [old], old));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual(missed.map((row) => row.id).reverse());
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      loadingOlder: false,
    });
    h.owner.session.channels.loadOlder("c");
    const next = h.read();
    expect(next.filters[0]).toMatchObject({
      until: previous.created_at,
      before_id: previous.id,
    });
  } finally {
    h.owner.dispose();
  }
});

it("re-reads held profiles and the roster on reconnect only when their replay was cut, had no cursor, failed or went unreported, or an earlier read failed", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  let profile = signed(alice, {
    kind: 0,
    content: '{"name":"Alice"}',
    tags: [],
  });
  // Every roster read finds the same channel, so no read revokes access.
  const channel = [
    roster(relay, "c", [viewer.pubkey]),
    metadata(relay, "c", "C"),
  ];
  let refuseProfiles = false;
  /** Answers every read until the wire is quiet; returns what was read. */
  const drain = async () => {
    const reads: (readonly ReadFilter[])[] = [];
    for (let quiet = 0; quiet < 3; ) {
      await flush();
      if (!wire.pending.length) quiet++;
      else quiet = 0;
      for (const entry of wire.pending.splice(0)) {
        reads.push(entry.filters);
        const kinds = entry.filters.flatMap((f) => f.kinds ?? []);
        if (refuseProfiles && kinds.includes(0)) {
          entry.fail(new Error("refused"));
          continue;
        }
        entry.respond(
          kinds.includes(0)
            ? [profile]
            : kinds.includes(39002) || kinds.includes(39000)
              ? channel
              : [],
        );
      }
    }
    return reads;
  };
  const profileReads = (reads: (readonly ReadFilter[])[]) =>
    reads.filter((filters) =>
      filters.some(
        (f) => f.kinds?.includes(0) && f.authors?.includes(alice.pubkey),
      ),
    );
  const rosterReads = (reads: (readonly ReadFilter[])[]) =>
    reads.filter((filters) => filters.some((f) => f.kinds?.includes(39002)));
  /** Drop the stream, reconnect, and establish both globals. */
  const reconnect = async (profiles?: boolean, membership = true) => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    if (profiles === undefined) {
      // A host that reports no route: both globals establish plainly.
      live.established();
      live.established();
    } else {
      live.established(undefined, { route: "profiles", continuous: profiles });
      live.established(undefined, {
        route: "membership",
        continuous: membership,
      });
    }
    return drain();
  };
  try {
    owner.session.channels.ensureList();
    await drain();
    const held = owner.session.profiles.ensure([alice.pubkey]);
    await drain();
    await held;
    expect(owner.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice",
    );
    // The first connection has no cursor: every held profile is read again.
    live.state({ status: "connected", routes: [] });
    live.established(undefined, { route: "profiles", continuous: false });
    live.established(undefined, { route: "membership", continuous: false });
    expect(profileReads(await drain())).toHaveLength(1);
    // A continuous replay already delivered every change: no full read.
    const quiet = await reconnect(true);
    expect(profileReads(quiet)).toEqual([]);
    expect(rosterReads(quiet)).toEqual([]);
    // A cut replay may have left changes out: read what that route covers.
    const cut = await reconnect(false);
    expect(profileReads(cut)).toHaveLength(1);
    expect(rosterReads(cut)).toEqual([]);
    const cutRoster = await reconnect(true, false);
    expect(profileReads(cutRoster)).toEqual([]);
    expect(rosterReads(cutRoster)).toHaveLength(1);
    // A read that fails stays owed: the next continuous reconnect reads again.
    refuseProfiles = true;
    expect(profileReads(await reconnect(false))).toHaveLength(1);
    refuseProfiles = false;
    expect(profileReads(await reconnect(true))).toHaveLength(1);
    expect(profileReads(await reconnect(true))).toEqual([]);
    // An older host reports no route: once per connection, as before.
    expect(profileReads(await reconnect(undefined))).toHaveLength(1);
    expect(owner.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice",
    );
    /** Drop the stream and reconnect without establishing anything yet. */
    const drop = () => {
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
    };
    // Membership reports its route but profiles report nothing, in either
    // order: the missing report still reads every held profile again, once.
    drop();
    live.established(undefined, { route: "membership", continuous: true });
    live.established();
    expect(profileReads(await drain())).toHaveLength(1);
    drop();
    live.established();
    live.established(undefined, { route: "membership", continuous: true });
    expect(profileReads(await drain())).toHaveLength(1);
    // The profiles route fails before it establishes while membership
    // establishes: the finite reads replace its replay, once per connection.
    profile = signed(alice, {
      kind: 0,
      content: '{"name":"Alice Two"}',
      tags: [],
      created_at: 1_700_000_100,
    });
    drop();
    live.established(undefined, { route: "membership", continuous: true });
    const failed = {
      status: "connected",
      routes: [
        {
          id: "profiles",
          status: "error",
          replay: "unknown",
          error: "Live subscription setup timed out; retry available",
        },
      ],
    } as const;
    live.state(failed);
    live.state(failed);
    expect(profileReads(await drain())).toHaveLength(1);
    expect(owner.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice Two",
    );
    // Its later continuous establishment on the same connection reads nothing.
    live.established(undefined, { route: "profiles", continuous: true });
    expect(profileReads(await drain())).toEqual([]);
  } finally {
    owner.dispose();
  }
});

it("skips the reads a continuous global replay covers, and keeps them after a cut, no cursor, a failed route or an unreported one", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let journal: ReadJournal | undefined;
  const decodeMarkers = vi.fn(async (events: readonly RelayEvent[]) =>
    decodeReadState(events, viewer.secret),
  );
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      readState: { decode: decodeMarkers },
      writer: {
        sign: async () => {
          throw new Error("unused");
        },
        publish: async () => {},
      },
      reminders: {
        decode: async (events) =>
          events.map((e) => ({
            eventId: e.id,
            content: JSON.parse(e.content),
          })),
        sign: async () => {
          throw new Error("unused");
        },
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
  const status = (text: string, at: number) =>
    signed(alice, {
      kind: 30315,
      content: text,
      tags: [["d", "general"]],
      created_at: at,
    });
  const emojiSet = (shortcode: string, at: number) =>
    signed(alice, {
      kind: 30030,
      content: "",
      tags: [
        ["d", EMOJI_SET],
        ["emoji", shortcode, `https://example.com/${shortcode}.png`],
      ],
      created_at: at,
    });
  const reminder = (state: string, at: number) =>
    signed(viewer, {
      kind: 30300,
      content: JSON.stringify({ note: "Call Bob", status: state }),
      tags: [["d", "r1"]],
      created_at: at,
    });
  // Another device's read-state marker for channel "c".
  const marker: RelayEvent = signReadState(
    {
      slot: "ab".repeat(16),
      createdAt: 1_700_000_100,
      blob: { v: 1, client_id: "phone", contexts: { c: 1_700_000_050 } },
    },
    viewer.secret,
    1_700_000_100,
  );
  const channel = [
    roster(relay, "c", [viewer.pubkey]),
    metadata(relay, "c", "C"),
  ];
  /** Answers every read until the wire is quiet; returns what was read. */
  const drain = async () => {
    const reads: (readonly ReadFilter[])[] = [];
    for (let quiet = 0; quiet < 3; ) {
      await flush();
      if (!wire.pending.length) quiet++;
      else quiet = 0;
      for (const entry of wire.pending.splice(0)) {
        reads.push(entry.filters);
        const kinds = entry.filters.flatMap((f) => f.kinds ?? []);
        entry.respond(
          kinds.includes(39002) || kinds.includes(39000)
            ? channel
            : kinds.includes(30315)
              ? [status("At lunch", 1_700_000_000)]
              : kinds.includes(30030)
                ? [emojiSet("wave", 1_700_000_000)]
                : kinds.includes(30300)
                  ? [reminder("pending", 1_700_000_000)]
                  : [],
        );
      }
    }
    return reads;
  };
  /** The finite reads of each covered hook. */
  const covered = (reads: (readonly ReadFilter[])[]) => {
    const count = (kind: number) =>
      reads.filter((filters) => filters.some((f) => f.kinds?.includes(kind)))
        .length;
    return {
      statuses: count(30315),
      emoji: count(30030),
      markers: count(30078),
      reminders: count(30300),
    };
  };
  const once = { statuses: 1, emoji: 1, markers: 1, reminders: 1 };
  const none = { statuses: 0, emoji: 0, markers: 0, reminders: 0 };
  const drop = () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
  };
  const establish = (profiles: boolean, membership: boolean) => {
    live.established(undefined, { route: "profiles", continuous: profiles });
    live.established(undefined, {
      route: "membership",
      continuous: membership,
    });
  };
  /** Every covered owner is back to its ready state. */
  const ready = () => {
    expect(owner.session.emoji.snapshot().status).toBe("ready");
    expect(owner.session.unread.sync().status).toBe("reconciled");
    expect(owner.session.reminders?.snapshot()).toMatchObject({
      status: "ready",
      hydrated: true,
    });
  };
  try {
    owner.session.channels.ensureList();
    const stop = owner.session.statuses.watch([alice.pubkey]);
    void owner.session.emoji.ensure();
    void owner.session.unread.ensure();
    await drain();
    // The first connection has no cursor: every covered hook reads.
    live.state({ status: "connected", routes: [] });
    establish(false, false);
    expect(covered(await drain())).toEqual(once);
    ready();
    // A quiet outage with a continuous replay: no covered hook reads, and each
    // owner is ready again. Changes made during the outage arrive through it.
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.reminders?.snapshot().status).toBe("loading");
    expect(owner.session.unread.sync().status).toBe("stale");
    live.state({ status: "connected", routes: [] });
    live.receive([
      status("In a meeting", 1_700_000_100),
      emojiSet("party", 1_700_000_100),
      reminder("done", 1_700_000_100),
      marker,
    ]);
    establish(true, true);
    expect(covered(await drain())).toEqual(none);
    ready();
    // The replayed marker went through the same ingest as a snapshot read.
    expect(decodeMarkers.mock.calls.at(-1)?.[0]).toEqual([marker]);
    expect(owner.session.statuses.snapshot().get(alice.pubkey)?.text).toBe(
      "In a meeting",
    );
    expect(
      owner.session.emoji.snapshot().entries.map((e) => e.shortcode),
    ).toContain("party");
    expect(owner.session.reminders?.snapshot().reminders).toMatchObject([
      { id: "r1", status: "done" },
    ]);
    // Each route decides only its own hooks.
    drop();
    establish(true, false);
    expect(covered(await drain())).toEqual({
      ...none,
      markers: 1,
      reminders: 1,
    });
    drop();
    establish(false, true);
    expect(covered(await drain())).toEqual({ ...none, statuses: 1, emoji: 1 });
    ready();
    // A cut replay reads as before.
    drop();
    establish(false, false);
    expect(covered(await drain())).toEqual(once);
    // An older host reports no route: once per connection, as before.
    drop();
    live.established();
    live.established();
    expect(covered(await drain())).toEqual(once);
    ready();
    // Routes that fail before they establish: the finite reads stand in for
    // their replay, once per connection; a later continuous establishment on
    // the same connection reads nothing.
    drop();
    const failed = {
      status: "connected",
      routes: (["profiles", "membership"] as const).map((id) => ({
        id,
        status: "error" as const,
        replay: "unknown" as const,
        error: "Live subscription setup timed out; retry available",
      })),
    } as const;
    live.state(failed);
    live.state(failed);
    expect(covered(await drain())).toEqual(once);
    establish(true, true);
    expect(covered(await drain())).toEqual(none);
    ready();
    // A cut report later on the same connection still reads.
    establish(false, false);
    expect(covered(await drain())).toEqual(once);
    ready();
    stop();
  } finally {
    owner.dispose();
  }
});

/** A session whose unread owner has read the bootstrap of a `count`-channel
 * roster, each channel holding one peer message, and so confirmed a mark at
 * that message's time. `answer` serves every pending read from `store`, as
 * the relay matches it, and `unread` lists the unread evidence reads. */
async function caughtUp(count: number) {
  const relay = keypair(),
    viewer = keypair(),
    peer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const ids = Array.from(
    { length: count },
    (_, i) => `room-${i.toString().padStart(3, "0")}`,
  );
  const at = 1_700_000_900;
  const rosters = ids.map((id) => roster(relay, id, [viewer.pubkey]));
  const store: RelayEvent[] = [
    ...rosters,
    ...ids.map((id) => message(peer, id, "unread evidence", at)),
  ];
  const unread: (readonly ReadFilter[])[] = [];
  const answer = async () => {
    await flush();
    while (wire.pending.length) {
      const batch = wire.next();
      if (batch.filters.some((filter) => filter.kinds?.includes(9)))
        unread.push(batch.filters);
      batch.respond(
        batch.filters.flatMap((filter) =>
          store
            .filter((event) => matchesEvent(event, filter))
            .sort(
              (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
            )
            .slice(0, filter.limit),
        ),
      );
      await flush();
    }
  };
  /** Answers reads until `pass` settles, then those it left pending. */
  const settle = async (pass: Promise<unknown>) => {
    let done = false;
    void pass.finally(() => {
      done = true;
    });
    while (!done) await answer();
    await answer();
  };
  live.receive(rosters);
  await settle(owner.session.unread.ensure());
  return {
    owner,
    live: () => live,
    ids,
    at,
    peer,
    store,
    unread,
    answer,
    settle,
  };
}
const DELTA_KINDS = [9, 40002, 40008, 40003, 5, 9005];

it.each([1, 128])(
  "a tick on a %s-channel roster reads one unread filter: the delta since the mark",
  async (count) => {
    const h = await caughtUp(count);
    try {
      const from = h.unread.length;
      h.live().recover?.();
      // The tick's pass starts once the read state is refreshed.
      await vi.waitFor(async () => {
        await h.answer();
        expect(h.unread.length).toBeGreaterThan(from);
      });
      await h.settle(h.owner.session.unread.ensure());
      expect(h.unread.slice(from)).toEqual([
        [
          {
            kinds: expect.arrayContaining(DELTA_KINDS),
            "#h": h.ids,
            since: h.at - 1865,
            limit: 500,
          },
        ],
      ]);
    } finally {
      h.owner.dispose();
    }
  },
);

it("a reconnect after a 10-minute outage reads one delta from the mark less 1,865 s and nothing else of unread", async () => {
  const h = await caughtUp(2);
  const clock = vi.spyOn(Date, "now");
  try {
    const [first = ""] = h.ids;
    h.live().state({ status: "connected", routes: [] });
    h.live().established();
    await h.settle(h.owner.session.unread.ensure());
    await vi.waitFor(async () => {
      await h.answer();
      expect(h.owner.session.unread.inbox().freshness).toBe("observed");
    });
    h.live().state({ status: "retrying", routes: [] });
    // Ten minutes later, with a message sent meanwhile.
    clock.mockReturnValue(Date.now() + 600_000);
    h.store.push(message(h.peer, first, "sent while away", h.at + 300));
    const from = h.unread.length;
    h.live().state({ status: "connected", routes: [] });
    h.live().established();
    await vi.waitFor(async () => {
      await h.answer();
      expect(h.unread.length).toBeGreaterThan(from);
    });
    await h.settle(h.owner.session.unread.ensure());
    expect(h.unread.slice(from)).toEqual([
      [
        {
          kinds: expect.arrayContaining(DELTA_KINDS),
          "#h": h.ids,
          since: h.at - 1865,
          limit: 500,
        },
      ],
    ]);
    expect(
      h.owner.session.unread.snapshot({ kind: "channel", channelId: first }),
    ).toMatchObject({ observedCount: 2, freshness: "observed" });
  } finally {
    clock.mockRestore();
    h.owner.dispose();
  }
});

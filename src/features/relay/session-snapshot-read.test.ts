import { afterEach, assert, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { keypair, message, metadata, roster } from "./testing";
import { matchesEvent } from "./projection";
import type { Delivery } from "./outbox";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

// The relay clamps a missing limit to 100 and any limit to 1000, so a full
// page must equal the caller's limit. The shared reader caps at 500.
it("refuses snapshot filters without a limit or above the read cap, before any request", async () => {
  const query = vi.fn(async () => [] as RelayEvent[]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
  });
  owners.push(owner);
  const read = owner.session.snapshotRead;
  if (!read) throw new Error("snapshotRead unavailable");
  const signal = new AbortController().signal;
  await expect(read([{ kinds: [45010] } as never], { signal })).rejects.toThrow(
    /limit/,
  );
  await expect(
    read(
      [
        { kinds: [45010], limit: 16 },
        { kinds: [39000], limit: 501 },
      ],
      {
        signal,
      },
    ),
  ).rejects.toThrow(/limit/);
  expect(query).not.toHaveBeenCalled();
  await read([{ kinds: [45010], limit: 500 }], { signal });
  expect(query).toHaveBeenCalledTimes(1);
});

it.each(["failed", "unknown", "sending"] as const)(
  "preserves full remote pages despite restored %s local intent, including public nonmembers",
  async (delivery: Delivery) => {
    const channel = "remote-page";
    const remote = Array.from({ length: 50 }, (_, index) =>
      message(viewer, channel, `remote ${index}`, 1700000100 - index),
    );
    const firstRemote = remote[0];
    const lastRemote = remote[49];
    assert.exists(firstRemote);
    assert.exists(lastRemote);
    const older = message(viewer, channel, "older shared session", 1700000000);
    const pending = message(viewer, channel, "local only", 1700000200);
    const rows = [...remote, older];
    const discovery = [
      metadata(relay, channel, "Public channel", 1700000000, [["public"]]),
      roster(relay, channel, []),
    ];
    const query = vi.fn(async (filters: readonly ReadFilter[]) =>
      filters.flatMap((filter) =>
        [...discovery, ...rows]
          .filter((event) => matchesEvent(event, filter))
          .slice(0, filter.limit),
      ),
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        writer: {
          sign: async (event) =>
            message(viewer, channel, event.content, 1700000300),
          publish: async () => {},
        },
      },
      {
        outboxStorage: {
          load: () => [
            { event: firstRemote, signed: firstRemote, delivery },
            { event: pending, signed: pending, delivery },
          ],
          save() {},
        },
      },
    );
    owners.push(owner);
    await owner.session.read([{ kinds: [39000, 39002], limit: 10 }]);
    await owner.session.outbox?.ready();
    expect(owner.session.outbox?.snapshot()).toHaveLength(2);
    expect(owner.session.channels.get?.(channel)?.members).toEqual([]);
    const page = await owner.session.readRemote([
      { kinds: [9], "#h": [channel], limit: 50 },
    ]);
    expect(page.map((event) => event.id)).toEqual(
      remote.map((event) => event.id),
    );
    expect(page.every((event) => !("delivery" in event))).toBe(true);
    expect(page.some((event) => event.id === pending.id)).toBe(false);
    const next = await owner.session.readRemote([
      {
        kinds: [9],
        "#h": [channel],
        until: lastRemote.created_at - 1,
        limit: 50,
      },
    ]);
    expect(next.map((event) => event.id)).toEqual([older.id]);
  },
);

it.each(["caller", "session", "cache"] as const)(
  "cancels a held remote page when its %s lifetime ends",
  async (lifetime) => {
    const started = deferred<void>();
    const held = deferred<RelayEvent[]>();
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => {
        started.resolve(undefined);
        return held.promise;
      },
    });
    owners.push(owner);
    const caller = new AbortController();
    const read = owner.session.readRemote([{ kinds: [0], limit: 10 }], {
      signal: caller.signal,
    });
    const rejected = expect(read).rejects.toThrow(/cancel|abort|stale/i);
    try {
      await started.promise;
      if (lifetime === "caller") caller.abort();
      else if (lifetime === "session") owner.dispose();
      else await owner.clearCache();
      await rejected;
    } finally {
      held.resolve([]);
    }
  },
);

it("starts remote pages fresh instead of joining an older identical read", async () => {
  const requests: ReturnType<typeof deferred<RelayEvent[]>>[] = [];
  const query = vi.fn(async () => {
    const pending = deferred<RelayEvent[]>();
    requests.push(pending);
    return pending.promise;
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
  });
  owners.push(owner);
  const filters = [{ kinds: [0], limit: 10 }];
  const first = owner.session.readRemote(filters);
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  const second = owner.session.readRemote(filters);
  try {
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  } finally {
    for (const request of requests) request.resolve([]);
  }
  await Promise.all([first, second]);
});

// Catch-up pages by the oldest event of each page: one the session merely
// observed meanwhile must not become that cursor.
it("keeps a remote page to what the relay returned for it, while read() adds what the session observed meanwhile", async () => {
  const channel = "remote-mentions";
  const mentioned = keypair().pubkey;
  const mention = (content: string, created_at: number) =>
    message(viewer, channel, content, created_at, [["p", mentioned]]);
  const newest = mention("newest", 1700001100);
  const newer = mention("newer", 1700001085);
  const observed = mention("observed meanwhile", 1700000750);
  const discovery = [
    metadata(relay, channel, "Public channel", 1700000000, [["public"]]),
    roster(relay, channel, []),
  ];
  const pages: ReturnType<typeof deferred<RelayEvent[]>>[] = [];
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    const [filter] = filters;
    if (filter?.["#p"]) {
      const page = deferred<RelayEvent[]>();
      pages.push(page);
      return page.promise;
    }
    return [...discovery, observed].filter((event) =>
      filters.some((each) => matchesEvent(event, each)),
    );
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
  });
  owners.push(owner);
  await owner.session.read([{ kinds: [39000, 39002], limit: 10 }]);
  const filter = {
    kinds: [9],
    "#p": [mentioned],
    since: 1700000701,
    until: 1700001120,
    limit: 2,
  };
  const merged = owner.session.read([filter], { fresh: true });
  const remote = owner.session.readRemote([filter]);
  await vi.waitFor(() => expect(pages).toHaveLength(2));
  await owner.session.read([{ ids: [observed.id], limit: 1 }]);
  for (const page of pages) page.resolve([newest, newer]);
  expect((await merged).map((event) => event.content)).toContain(
    "observed meanwhile",
  );
  expect((await remote).map((event) => event.content)).toEqual([
    "newest",
    "newer",
  ]);
});

it("refuses remote pages on a cached-only session", async () => {
  const query = vi.fn(async () => [] as RelayEvent[]);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
    },
    { cachedOnly: true },
  );
  owners.push(owner);
  await expect(
    owner.session.readRemote([{ kinds: [9], limit: 50 }]),
  ).rejects.toThrow(/Reconnect/);
  expect(query).not.toHaveBeenCalled();
});

it("does not complete a held remote page across a membership revocation", async () => {
  const channel = "private-page";
  let members = [viewer.pubkey];
  let time = 1700000000;
  const started = deferred<void>();
  const held = deferred<RelayEvent[]>();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async (filters) => {
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        started.resolve(undefined);
        return held.promise;
      }
      return [
        metadata(relay, channel, "Private channel", time, [["private"]]),
        roster(relay, channel, members, time),
      ].filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
  });
  owners.push(owner);
  const discovery = [{ kinds: [39000, 39002], limit: 10 }];
  await owner.session.read(discovery);
  const read = owner.session.readRemote([
    { kinds: [9], "#h": [channel], limit: 50 },
  ]);
  const rejected = expect(read).rejects.toThrow(/cancel|abort|stale/i);
  try {
    await started.promise;
    members = [];
    time++;
    await owner.session.read(discovery);
    held.resolve([message(viewer, channel, "formerly accessible", 1700000000)]);
    await rejected;
  } finally {
    held.resolve([]);
  }
});

it.each([false, true])(
  "applies a returned revoking roster while fencing mixed content (%s)",
  async (mixed) => {
    const channel = "returned-revocation";
    let members = [viewer.pubkey];
    let time = 1700000000;
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async (filters) =>
        [
          metadata(relay, channel, "Private channel", time, [["private"]]),
          roster(relay, channel, members, time),
          message(viewer, channel, "formerly accessible", time),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    });
    owners.push(owner);
    await owner.session.read([{ kinds: [39000, 39002], limit: 10 }]);
    expect(owner.session.channels.get?.(channel)?.members).toContain(
      viewer.pubkey,
    );
    members = [];
    time++;
    const result = owner.session.readRemote([
      { kinds: mixed ? [39000, 39002, 9] : [39000, 39002], limit: 10 },
    ]);
    if (mixed) await expect(result).rejects.toThrow(/cancel|abort|stale/i);
    else await expect(result).resolves.toEqual([]);
    expect(owner.session.channels.get?.(channel)).toBeUndefined();
  },
);

import { verifiedSymbol } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "./events";
import type { ThreadParticipation } from "./thread-participation";
import {
  browserUnreadStorage,
  memoryUnreadStorage,
  purgeUnreadStorage,
  UNREAD_RECORD_BYTES,
  UNREAD_RECORD_EVENTS,
  type UnreadRecord,
} from "./unread-storage";

afterEach(() => vi.unstubAllGlobals());

// An in-memory IndexedDB shared by every connection. Transactions run one at
// a time in the order they were created, as overlapping readwrite
// transactions do, and complete once their last request has succeeded;
// values are structured clones. `blocked` opens are refused first.
function memoryIndexedDB(blocked = 0) {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, readonly string[]>();
  const writes: [string, "put" | "delete", unknown][] = [];
  let upgraded = false;
  let turn = Promise.resolve();
  const table = (name: string) => {
    const rows = stores.get(name) ?? new Map<string, unknown>();
    stores.set(name, rows);
    return rows;
  };
  const scoped = (name: string, range: { only: unknown }) =>
    [...table(name)]
      .filter(
        ([, value]) => (value as { scope?: unknown }).scope === range.only,
      )
      .sort(([a], [b]) => (a < b ? -1 : 1));
  function transaction() {
    const previous = turn;
    let release = () => {};
    turn = new Promise((resolve) => {
      release = resolve;
    });
    let pending = 0;
    let done = false;
    const tx = {
      error: null,
      oncomplete: () => {},
      onabort: () => {},
      onerror: () => {},
      objectStore: (name: string) => ({
        get: (key: unknown) =>
          request(() => structuredClone(table(name).get(JSON.stringify(key)))),
        put: (value: Record<string, unknown>, key?: unknown) =>
          request(() => {
            const at = key ?? keyPaths.get(name)?.map((path) => value[path]);
            writes.push([name, "put", at]);
            table(name).set(JSON.stringify(at), structuredClone(value));
          }),
        delete: (key: unknown) =>
          request(() => {
            writes.push([name, "delete", key]);
            table(name).delete(JSON.stringify(key));
          }),
        index: () => ({
          getAll: (range: { only: unknown }, count = Infinity) =>
            request(() =>
              scoped(name, range)
                .slice(0, count)
                .map(([, value]) => structuredClone(value)),
            ),
          getAllKeys: (range: { only: unknown }) =>
            request(() => scoped(name, range).map(([key]) => JSON.parse(key))),
        }),
      }),
    };
    const finish = () => {
      if (pending || done) return;
      done = true;
      release();
      tx.oncomplete();
    };
    function request(run: () => unknown) {
      const issued = { result: undefined as unknown, onsuccess: () => {} };
      pending++;
      void previous.then(() => {
        issued.result = run();
        issued.onsuccess();
        pending--;
        finish();
      });
      return issued;
    }
    // A transaction that issues no request completes on its turn.
    void previous.then(finish);
    return tx;
  }
  const db = {
    onversionchange: () => {},
    close: vi.fn(),
    createObjectStore(name: string, options?: { keyPath?: string[] }) {
      table(name);
      if (options?.keyPath) keyPaths.set(name, options.keyPath);
      return { createIndex() {} };
    },
    transaction,
  };
  const opens: unknown[] = [];
  vi.stubGlobal("IDBKeyRange", { only: (only: unknown) => ({ only }) });
  vi.stubGlobal("indexedDB", {
    open() {
      const request = {
        result: db,
        error: null,
        onupgradeneeded: () => {},
        onsuccess: () => {},
        onerror: () => {},
        onblocked: () => {},
      };
      opens.push(request);
      queueMicrotask(() => {
        if (blocked-- > 0) return request.onblocked();
        if (!upgraded) request.onupgradeneeded();
        upgraded = true;
        request.onsuccess();
      });
      return request;
    },
  });
  return {
    opens,
    writes,
    /** Writes a stored value as another build or a tampered disk would. */
    seed(name: string, key: unknown, value: unknown) {
      table(name).set(JSON.stringify(key), structuredClone(value));
    },
    keys: (name: string) =>
      [...table(name).keys()].map((key) => JSON.parse(key)),
  };
}

let next = 0;
function event(content = ""): RelayEvent {
  next++;
  return {
    id: next.toString(16).padStart(64, "0"),
    pubkey: "b".repeat(64),
    kind: 9,
    created_at: 1000 + next,
    content,
    tags: [["h", "c0"]],
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
// What storage gives back: the wire fields alone, so the verification mark
// does not survive and the owner must verify again.
const wire = (item: RelayEvent) => JSON.parse(JSON.stringify(item));
const threads: ThreadParticipation = {
  roots: new Map([
    ["c0:root", { at: 1000 }],
    ["c0:other", { at: 1200, newestId: "a".repeat(64) }],
  ]),
  walk: { since: 1500 },
};
const scope = "https://relay.example:viewer";
const meta = (participation: unknown) => ({ version: 1, participation });

it("a record round-trips with its threads, walk mark and events", async () => {
  memoryIndexedDB();
  const events = [event("first"), event("second")];
  await browserUnreadStorage(scope).save({
    participation: threads,
    events,
    complete: true,
  });
  // The next launch reads it through its own connection.
  await expect(browserUnreadStorage(scope).read()).resolves.toEqual({
    participation: threads,
    events: events.map(wire),
    complete: true,
  });
  await browserUnreadStorage(scope).save({
    participation: { roots: new Map() },
    events: [],
    complete: false,
  });
  await expect(browserUnreadStorage(scope).read()).resolves.toEqual({
    participation: { roots: new Map() },
    events: [],
    complete: false,
  });
});

it("malformed meta reads as no record", async () => {
  const idb = memoryIndexedDB();
  const storage = browserUnreadStorage(scope);
  const roots = [["c0:root", 1000]];
  idb.seed("events", [scope, "e"], { scope, id: "e", event: wire(event()) });
  for (const raw of [
    undefined,
    "record",
    { participation: { roots } },
    { version: 2, participation: { roots } },
    meta(undefined),
    meta({ roots: "c0:root" }),
    meta({ roots: [["c0:root", -1]] }),
    meta({ roots: [["c0:root", 1000, 7]] }),
    meta({ roots: [["c0:root", 1000, "a".repeat(65)]] }),
    meta({ roots: [[`c0:${"r".repeat(256)}`, 1000]] }),
    meta({ roots: [...roots, "junk"] }),
    meta({ roots: Array.from({ length: 1001 }, (_, i) => [`c0:${i}`, i]) }),
    meta({ roots, walk: null }),
    meta({ roots, walk: { since: 1.5 } }),
  ]) {
    idb.seed("meta", scope, raw);
    await expect(storage.read()).resolves.toBeUndefined();
  }
  idb.seed("meta", scope, meta({ roots, walk: { since: 1500 } }));
  await expect(storage.read()).resolves.toMatchObject({
    participation: { roots: new Map([["c0:root", { at: 1000 }]]) },
  });
});

it("a field added after the participation reads as incomplete when missing or malformed, keeping the record", async () => {
  const idb = memoryIndexedDB();
  const storage = browserUnreadStorage(scope);
  const participation = { roots: [["c0:root", 1000]] };
  const held = wire(event());
  idb.seed("events", [scope, held.id], { scope, id: held.id, event: held });
  for (const complete of [undefined, "true", 1, null, { complete: true }]) {
    idb.seed("meta", scope, { ...meta(participation), complete });
    await expect(storage.read()).resolves.toEqual({
      participation: { roots: new Map([["c0:root", { at: 1000 }]]) },
      events: [held],
      complete: false,
    });
  }
  idb.seed("meta", scope, { ...meta(participation), complete: true });
  await expect(storage.read()).resolves.toMatchObject({ complete: true });
});

it("an oversized record is refused when saved, keeping the saved one, and reads as no record when stored", async () => {
  const idb = memoryIndexedDB();
  const storage = browserUnreadStorage(scope);
  const saved: UnreadRecord = {
    participation: threads,
    events: [event()],
    complete: true,
  };
  await storage.save(saved);
  const many = Array.from({ length: UNREAD_RECORD_EVENTS + 1 }, () => event());
  const large = [event("x".repeat(UNREAD_RECORD_BYTES))];
  for (const events of [many, large]) {
    await expect(
      storage.save({ participation: threads, events, complete: true }),
    ).rejects.toThrow(RangeError);
    await expect(
      memoryUnreadStorage().save({
        participation: threads,
        events,
        complete: true,
      }),
    ).rejects.toThrow(RangeError);
    await expect(storage.read()).resolves.toEqual({
      ...saved,
      events: saved.events.map(wire),
    });
  }
  // At the bound it still saves and reads.
  const bound = many.slice(0, UNREAD_RECORD_EVENTS);
  await storage.save({ participation: threads, events: bound, complete: true });
  expect((await storage.read())?.events).toHaveLength(UNREAD_RECORD_EVENTS);
  // Beyond it on disk, by count or by bytes, nothing is restored.
  const extra = many.at(-1) as RelayEvent;
  idb.seed("events", [scope, extra.id], {
    scope,
    id: extra.id,
    event: wire(extra),
  });
  await expect(storage.read()).resolves.toBeUndefined();
  await storage.save({ participation: threads, events: [], complete: true });
  const [big] = large as [RelayEvent];
  idb.seed("events", [scope, big.id], { scope, id: big.id, event: wire(big) });
  await expect(storage.read()).resolves.toBeUndefined();
});

it("a blocked open is not held against the next read", async () => {
  const idb = memoryIndexedDB(1);
  const storage = browserUnreadStorage(scope);
  await expect(storage.read()).rejects.toThrow("Close other Buzz windows");
  await storage.save({ participation: threads, events: [], complete: true });
  await expect(storage.read()).resolves.toMatchObject({
    participation: threads,
  });
  expect(idb.opens).toHaveLength(2);
});

it("a save puts only the events the partition lacks and deletes the rest", async () => {
  const idb = memoryIndexedDB();
  const storage = browserUnreadStorage(scope);
  const [a, b, c] = [event(), event(), event()] as [
    RelayEvent,
    RelayEvent,
    RelayEvent,
  ];
  await storage.save({
    participation: threads,
    events: [a, b],
    complete: true,
  });
  idb.writes.splice(0);
  await storage.save({
    participation: threads,
    events: [b, c],
    complete: true,
  });
  // In any order: a transaction commits its writes together.
  expect(idb.writes).toHaveLength(3);
  expect(idb.writes).toEqual(
    expect.arrayContaining([
      ["meta", "put", scope],
      ["events", "delete", [scope, a.id]],
      ["events", "put", [scope, c.id]],
    ]),
  );
});

it("two interleaved saves leave exactly the last writer's events and meta", async () => {
  const idb = memoryIndexedDB();
  // Two windows of the same partition, each with its own connection.
  const first = browserUnreadStorage(scope);
  const second = browserUnreadStorage(scope);
  const [a, b, c] = [event(), event(), event()] as [
    RelayEvent,
    RelayEvent,
    RelayEvent,
  ];
  const later: ThreadParticipation = {
    roots: new Map([["c0:later", { at: 2000 }]]),
  };
  await Promise.all([
    first.save({ participation: threads, events: [a, b], complete: true }),
    second.save({ participation: later, events: [b, c], complete: true }),
  ]);
  await expect(first.read()).resolves.toEqual({
    participation: later,
    events: [b, c].map(wire),
    complete: true,
  });
  // A window's earlier save is no guide to what the partition holds now.
  await first.save({ participation: threads, events: [a], complete: true });
  expect(idb.keys("events")).toEqual([[scope, a.id]]);
  await expect(second.read()).resolves.toEqual({
    participation: threads,
    events: [wire(a)],
    complete: true,
  });
});

it("a purge clears only that partition", async () => {
  const idb = memoryIndexedDB();
  // A scope that merely extends the purged one is a different partition.
  const others = [`${scope}0`, "https://other.example:viewer"];
  const kept = new Map(others.map((other) => [other, event()]));
  for (const [other, item] of kept)
    await browserUnreadStorage(other).save({
      participation: threads,
      events: [item],
      complete: true,
    });
  await browserUnreadStorage(scope).save({
    participation: threads,
    events: [event(), event()],
    complete: true,
  });
  await purgeUnreadStorage(scope);
  await expect(browserUnreadStorage(scope).read()).resolves.toBeUndefined();
  expect(idb.keys("events").map(([partition]) => partition)).toEqual(others);
  for (const [other, item] of kept)
    await expect(browserUnreadStorage(other).read()).resolves.toEqual({
      participation: threads,
      events: [wire(item)],
      complete: true,
    });
});

it("a window that read before a purge cannot save the record back; a session started after it can", async () => {
  const idb = memoryIndexedDB();
  const record = (events: RelayEvent[]): UnreadRecord => ({
    participation: threads,
    events,
    complete: true,
  });
  // Another window's session for the community, live since before the leave.
  const stale = browserUnreadStorage(scope);
  await stale.save(record([event()]));
  await stale.read();
  await purgeUnreadStorage(scope);
  await expect(stale.save(record([event()]))).rejects.toThrow("purged");
  expect(idb.keys("events")).toEqual([]);
  await expect(browserUnreadStorage(scope).read()).resolves.toBeUndefined();
  // Rejoining starts a session that reads the purge and saves over it.
  const rejoined = browserUnreadStorage(scope);
  await expect(rejoined.read()).resolves.toBeUndefined();
  const kept = event();
  await rejoined.save(record([kept]));
  // The stale window stays refused, and the rejoined record stands.
  await expect(stale.save(record([event()]))).rejects.toThrow("purged");
  await expect(stale.read()).resolves.toEqual({
    ...record([kept]),
    events: [wire(kept)],
  });
  await expect(stale.save(record([event()]))).rejects.toThrow("purged");
  // A later purge fences the rejoined session as well.
  await purgeUnreadStorage(scope);
  await expect(rejoined.save(record([kept]))).rejects.toThrow("purged");
});

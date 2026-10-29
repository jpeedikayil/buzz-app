import type { ReadFilter } from "./events";
import { afterEach, expect, it, vi } from "vitest";
import { createRelayReader } from "./reader";
import { flush, scriptedTransport } from "./testing";

const owners: ReturnType<typeof createRelayReader>[] = [];
function setup(options: Parameters<typeof createRelayReader>[1] = {}) {
  const scripted = scriptedTransport("viewer", "relay");
  const owner = createRelayReader(scripted.transport, options);
  owners.push(owner);
  return { ...scripted, ...owner, read: owner.reader.read };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const filter = (id: string) => [{ kinds: [9], "#h": [id], limit: 80 }];

it("shares equivalent concurrent filters but keeps each consumer's cancellation independent", async () => {
  const { read, next, pending } = setup();
  const a = new AbortController(),
    b = new AbortController();
  const first = read([{ kinds: [7, 5], "#e": ["b", "a"], limit: 50 }], {
    signal: a.signal,
  });
  const second = read([{ limit: 50, "#e": ["a", "b", "a"], kinds: [5, 7] }], {
    signal: b.signal,
  });
  expect(pending).toHaveLength(1);
  const wire = next();
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  a.abort();
  await rejected;
  expect(wire.signal?.aborted).toBe(false);
  wire.respond([]);
  expect(await second).toEqual([]);
  const again = read([{ kinds: [5, 7], "#e": ["a", "b"], limit: 50 }]);
  expect(pending).toHaveLength(1); // Settled results are owned by domain models, not cached here.
  next().respond([]);
  await again;
});
it("reserves foreground capacity and promotes an existing queued background read", async () => {
  const { read, pending, next } = setup();
  const a = read(filter("a"), { priority: "background" });
  const b = read(filter("b"), { priority: "background" });
  expect(pending).toHaveLength(1);
  const promoted = read(filter("b"));
  const c = read(filter("c"));
  expect(pending).toHaveLength(3);
  next().respond([]);
  next().respond([]);
  next().respond([]);
  await Promise.all([a, b, c, promoted]);
});
it("removes cancelled queued work and rejects late results after invalidation", async () => {
  const { read, next, pending, invalidate } = setup();
  const old = read(filter("a"), { priority: "background" });
  const wire = next();
  const controller = new AbortController();
  const queued = read(filter("b"), {
    priority: "background",
    signal: controller.signal,
  });
  const stopped = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await stopped;
  const revoked = expect(old).rejects.toMatchObject({ name: "AbortError" });
  invalidate((filters) => filters.some((f) => f["#h"]?.includes("a")));
  await revoked;
  const fresh = read(filter("a"));
  wire.respond([]);
  await flush();
  expect(pending).toHaveLength(1);
  next().respond([]);
  await fresh;
});
it("bounds stalled and queued reads and permits explicit retry", async () => {
  vi.useFakeTimers();
  const { read, next, pending } = setup({ timeoutMs: 100, maxPending: 2 });
  const a = read(filter("a"), { priority: "background" });
  const b = read(filter("b"), { priority: "background" });
  const failures = Promise.all([
    expect(a).rejects.toThrow("timed out"),
    expect(b).rejects.toThrow("timed out"),
  ]);
  await expect(read(filter("c"))).rejects.toThrow("Too many");
  const wire = next();
  await vi.advanceTimersByTimeAsync(101);
  await failures;
  expect(wire.signal?.aborted).toBe(true);
  // A queued job can start at the deadline of an earlier job; it still expires at its own deadline.
  pending.splice(0);
  const retry = read(filter("a"));
  next().respond([]);
  await retry;
});
it("propagates failures, isolates sessions, and settles all work on disposal", async () => {
  const one = setup(),
    two = setup();
  const a = one.read(filter("a")),
    b = two.read(filter("a"));
  one.next().fail(new Error("offline"));
  await expect(a).rejects.toThrow("offline");
  two.next().respond([]);
  await expect(b).resolves.toEqual([]);
  const running = one.read(filter("a"));
  const rejected = expect(running).rejects.toMatchObject({
    name: "AbortError",
  });
  one.dispose();
  await rejected;
  await expect(one.read(filter("a"))).rejects.toMatchObject({
    name: "AbortError",
  });
});
it("supports the desktop's ID, reference, address, and application-data reads without channel state", async () => {
  const { read, next } = setup();
  const filters = [
    { ids: ["event"], limit: 1 },
    {
      kinds: [40002, 9],
      "#e": ["root"],
      depth_limit: 10,
      thread_cursor: 100,
      thread_cursor_id: "reply",
      limit: 80,
    },
    {
      kinds: [9],
      search: "design",
      search_mode: "prefix" as const,
      page: 2,
      limit: 20,
    },
    { kinds: [9], feed_types: ["mentions", "activity"], since: 100, limit: 20 },
    { kinds: [13534], authors: ["relay"], limit: 1 },
    { kinds: [1621], "#a": ["30617:owner:repo"], limit: 200 },
    {
      kinds: [30078],
      authors: ["viewer"],
      "#t": ["read-state"],
      since: 100,
      limit: 500,
    },
    { kinds: [30030], "#d": ["emojis"], limit: 500 },
  ];
  for (const filter of filters) {
    const result = read([filter]);
    const wire = next();
    expect(wire.filters).toEqual([filter]);
    wire.respond([]);
    await expect(result).resolves.toEqual([]);
  }
});

it("preserves ordered bridge extensions and distinguishes their request identity", async () => {
  const { read, next, pending } = setup();
  const first = read([
    { kinds: [9], feed_types: ["mentions", "activity"], limit: 20 },
  ]);
  const second = read([
    { kinds: [9], feed_types: ["activity", "mentions"], limit: 20 },
  ]);
  expect(pending).toHaveLength(2);
  const a = next(),
    b = next();
  expect(a.filters[0]?.feed_types).toEqual(["mentions", "activity"]);
  expect(b.filters[0]?.feed_types).toEqual(["activity", "mentions"]);
  a.respond([]);
  b.respond([]);
  await Promise.all([first, second]);
});

it("fresh reads retain scheduler bounds but never join older or simultaneous equal work", async () => {
  const h = setup();
  const old = h.read(filter("c"));
  const one = h.read(filter("c"), { fresh: true });
  const two = h.read(filter("c"), { fresh: true });
  const three = h.read(filter("c"), { fresh: true });
  expect(h.pending).toHaveLength(3);
  h.next().respond([]);
  await flush();
  expect(h.pending).toHaveLength(3);
  h.next().respond([]);
  h.next().respond([]);
  h.next().respond([]);
  await Promise.all([old, one, two, three]);
});

/** Real owner wiring; tests dispatch lifecycle events, never toggle a private gate. */
function documentLife() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const page = Object.assign(new EventTarget(), {
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.set(++id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  });
  vi.stubGlobal("window", page);
  return {
    frames,
    emit: (name: string) => page.dispatchEvent(new Event(name)),
    render() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
  };
}

it.each(["success", "failure", "cancellation"] as const)(
  "navigation fences %s completion, new reads and promotion until a resumed render",
  async (outcome) => {
    const page = documentLife();
    const h = setup();
    const controller = new AbortController();
    const running = h.read(filter("running"), {
      priority: "background",
      signal: controller.signal,
    });
    const wire = h.next();
    const queued = h.read(filter("queued"), { priority: "background" });
    page.emit("beforeunload");
    const completion =
      outcome === "success"
        ? expect(running).resolves.toEqual([])
        : expect(running).rejects.toThrow();
    if (outcome === "success") wire.respond([]);
    else if (outcome === "failure") wire.fail(new Error("loader stopped"));
    else controller.abort();
    await completion;
    // Consumer continuations and recovery callbacks cannot restart admission.
    const retry = h.read(filter("retry"));
    h.promote(() => true);
    await flush();
    await flush();
    expect(h.pending).toHaveLength(0);
    // A cancelled navigation renders the same document again, without pageshow.
    page.render();
    await vi.waitFor(() => expect(h.pending).toHaveLength(2));
    h.next().respond([]);
    h.next().respond([]);
    await Promise.all([queued, retry]);
  },
);

it("pagehide cancels render resumption and pageshow resumes the same reader", async () => {
  const page = documentLife();
  const h = setup();
  page.emit("beforeunload");
  expect(page.frames.size).toBe(1);
  page.emit("pagehide");
  expect(page.frames.size).toBe(0);
  const reading = h.read(filter("queued"));
  page.render();
  await flush();
  expect(h.pending).toHaveLength(0);
  page.emit("pageshow");
  h.next().respond([]);
  await expect(reading).resolves.toEqual([]);
});

it("paused work retains deadlines and cancellation without dispatching on expiry", async () => {
  vi.useFakeTimers();
  const page = documentLife();
  const h = setup({ timeoutMs: 100 });
  const first = h.read(filter("first"));
  const wire = h.next();
  page.emit("beforeunload");
  page.emit("pagehide");
  const queued = h.read(filter("queued"));
  const expired = Promise.all([
    expect(first).rejects.toThrow("timed out"),
    expect(queued).rejects.toThrow("timed out"),
  ]);
  await vi.advanceTimersByTimeAsync(101);
  await expired;
  expect(wire.signal?.aborted).toBe(true);
  page.emit("pageshow");
  expect(h.pending).toHaveLength(0);
  const retry = h.read(filter("queued"));
  h.next().respond([]);
  await retry;
});

it("disposal settles paused work and removes lifecycle callbacks and pending renders", async () => {
  const page = documentLife();
  const h = setup();
  const running = h.read(filter("running"), { priority: "background" });
  const wire = h.next();
  const queued = h.read(filter("queued"), { priority: "background" });
  page.emit("beforeunload");
  const stopped = Promise.all([
    expect(running).rejects.toThrow(),
    expect(queued).rejects.toThrow(),
  ]);
  h.dispose();
  await stopped;
  expect(wire.signal?.aborted).toBe(true);
  expect(page.frames.size).toBe(0);
  page.emit("beforeunload");
  expect(page.frames.size).toBe(0);
  page.emit("pageshow");
  page.render();
  await flush();
  expect(h.pending).toHaveLength(0);
  await expect(h.read(filter("retry"))).rejects.toThrow();
});

it("admits an unread repair batch of up to 128 content filters, and nothing shaped otherwise", async () => {
  const { read, next, pending } = setup();
  const channel = (i: number) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const kinds = [9, 40002, 40008];
  const root = "a".repeat(64);
  const batch: ReadFilter[] = [
    { kinds, authors: ["b".repeat(64)], include_aux: true, limit: 100 },
    ...Array.from({ length: 125 }, (_, i) => ({
      kinds,
      "#h": [channel(i)],
      since: 1000,
      include_aux: true,
      limit: 24,
    })),
    {
      kinds,
      "#h": [channel(200)],
      "#e": [root],
      include_aux: true,
      limit: 200,
    },
    { kinds, ids: [root], include_aux: true, limit: 1 },
  ];
  const result = read(batch);
  expect(next().filters).toHaveLength(128);
  const window = (f: ReadFilter) => f.since !== undefined;
  for (const invalid of [
    [...batch, { ...batch[1], "#h": [channel(300)] }],
    batch.map((f) => ({ ...f, kinds: [9] })),
    batch.map(({ include_aux: _aux, ...f }) => f),
    batch.map(({ since: _since, ...f }) => f),
    batch.map((f) => (window(f) ? { ...f, "#h": [channel(1)] } : f)),
    batch.map((f) => (window(f) ? { ...f, until: 2000 } : f)),
    [...batch.slice(1), batch[0], batch[0]],
    batch.map((f) => (f.ids ? { ...f, limit: 2 } : f)),
  ] as ReadFilter[][])
    await expect(read(invalid)).rejects.toThrow("1–4 filters");
  expect(pending).toHaveLength(0);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  owners.at(-1)?.dispose();
  await rejected;
});

it("admits an unread repair batch of edits and deletions read by up to 100 event IDs each, from the start or from where a read stopped, within the request budget, and nothing shaped otherwise", async () => {
  const { read, next, pending } = setup();
  const ids = (i: number, length = 100) =>
    Array.from({ length }, (_, j) =>
      (i * 100 + j).toString(16).padStart(64, "0"),
    );
  const filter = (i: number, length?: number): ReadFilter => ({
    kinds: [40003, 5, 9005],
    "#e": ids(i, length),
    since: 1000,
    limit: 500,
  });
  const batch = Array.from({ length: 9 }, (_, i) => filter(i));
  const result = read(batch);
  expect(next().filters).toHaveLength(9);
  const stopped = batch.map((f, i) => ({
    ...f,
    until: 2000 + i,
    before_id: "a".repeat(64),
  }));
  const resumed = read(stopped);
  expect(next().filters).toEqual(stopped);
  for (const invalid of [
    Array.from({ length: 129 }, (_, i) => filter(i, 1)),
    batch.map((f) => ({ ...f, kinds: [5] })),
    batch.map((f) => ({ ...f, "#e": [...(f["#e"] ?? []), "f".repeat(64)] })),
    batch.map(({ since: _since, ...f }) => f),
    batch.map((f) => ({ ...f, include_aux: true })),
    batch.map((f) => ({ ...f, "#h": ["team"] })),
    batch.map((f) => ({ ...f, until: 2000 })),
    batch.map((f) => ({ ...f, before_id: "a".repeat(64) })),
    stopped.map((f) => ({ ...f, before_id: "A".repeat(64) })),
    stopped.map((f) => ({ ...f, until: 2000.5 })),
  ] as ReadFilter[][])
    await expect(read(invalid)).rejects.toThrow("1–4 filters");
  await expect(read([...batch, filter(9)])).rejects.toThrow(
    "Relay filters exceed the request budget",
  );
  expect(pending).toHaveLength(0);
  const rejected = Promise.all(
    [result, resumed].map((read) =>
      expect(read).rejects.toMatchObject({ name: "AbortError" }),
    ),
  );
  owners.at(-1)?.dispose();
  await rejected;
});

it("admits only the bounded workflow batch exception without relaxing other read budgets", async () => {
  const { read, next, pending } = setup();
  const batch = Array.from({ length: 128 }, (_, i) => ({
    kinds: [30620],
    "#h": [`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`],
    limit: 100,
  }));
  const result = read(batch);
  expect(next().filters).toEqual(batch);
  for (const invalid of [
    [...batch, ...batch.slice(0, 1)],
    batch.map((f) => ({ ...f, kinds: [9] })),
    batch.map((f) => ({ ...f, limit: 500 })),
    batch.map((f) => ({ ...f, search: "anything" })),
    batch.map((f) => ({ ...f, "#h": ["invalid"] })),
    Array(5).fill(batch[0]),
    batch.map((f) => ({
      ...f,
      "#h": [...f["#h"], "00000000-0000-4000-8000-000000000999"],
    })),
  ])
    await expect(read(invalid)).rejects.toThrow("1–4 filters");
  expect(pending).toHaveLength(0);
  // Dispose cancels the valid in-flight batch exactly like an ordinary read.
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  owners.at(-1)?.dispose();
  await rejected;
});

it.each(["caller", "deadline", "dispose"] as const)(
  "%s retires a local inventory read queued during navigation",
  async (ending) => {
    vi.useFakeTimers();
    const page = documentLife();
    const scripted = scriptedTransport("viewer", "relay");
    const local = vi.fn(async () => ({ definitions: [], identities: [] }));
    const owner = createRelayReader(
      { ...scripted.transport, readAgentLibrary: local },
      { timeoutMs: 100 },
    );
    owners.push(owner);
    page.emit("beforeunload");
    const caller = new AbortController();
    const reading = owner.readAgentLibrary(caller.signal);
    const rejected =
      ending === "deadline"
        ? expect(reading).rejects.toThrow("timed out")
        : expect(reading).rejects.toMatchObject({ name: "AbortError" });
    if (ending === "caller") caller.abort();
    else if (ending === "deadline") await vi.advanceTimersByTimeAsync(100);
    else owner.dispose();
    await rejected;
    page.emit("pageshow");
    page.render();
    expect(local).not.toHaveBeenCalled();
  },
);

it("keeps local inventory consumers independent and ignores an abandoned read's late result", async () => {
  type Library = import("../agents/library").AgentLibrary;
  const wires: { signal: AbortSignal; respond: (library: Library) => void }[] =
    [];
  const local = vi.fn(
    (signal: AbortSignal) =>
      new Promise<Library>((respond) => {
        wires.push({ signal, respond });
      }),
  );
  const owner = createRelayReader({
    ...scriptedTransport("viewer", "relay").transport,
    readAgentLibrary: local,
  });
  owners.push(owner);
  const caller = new AbortController();
  const old = owner.readAgentLibrary(caller.signal);
  const retired = expect(old).rejects.toMatchObject({ name: "AbortError" });
  caller.abort();
  await retired;
  expect(wires[0]?.signal.aborted).toBe(true);
  const first = new AbortController(),
    second = new AbortController();
  const reading = owner.readAgentLibrary(first.signal);
  const joined = owner.readAgentLibrary(second.signal);
  const cancelled = expect(reading).rejects.toMatchObject({
    name: "AbortError",
  });
  first.abort();
  await cancelled;
  expect(wires[1]?.signal.aborted).toBe(false);
  wires[0]?.respond({ definitions: [], identities: [] });
  await Promise.resolve();
  const current = owner.readAgentLibrary(new AbortController().signal);
  expect(local).toHaveBeenCalledTimes(2);
  const library = {
    definitions: [{ id: "local", name: "Brain" }],
    identities: [],
  };
  wires[1]?.respond(library);
  await expect(joined).resolves.toEqual(library);
  await expect(current).resolves.toEqual(library);
});

it("retains local inventory failure and the existing deadline after dispatch", async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const failure = new Error("Local library unavailable");
  const local = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockImplementation((owned: AbortSignal) => {
      signal = owned;
      return new Promise(() => {});
    });
  const owner = createRelayReader(
    {
      ...scriptedTransport("viewer", "relay").transport,
      readAgentLibrary: local,
    },
    { timeoutMs: 100 },
  );
  owners.push(owner);
  await expect(
    owner.readAgentLibrary(new AbortController().signal),
  ).rejects.toBe(failure);
  const retry = owner.readAgentLibrary(new AbortController().signal);
  const expired = expect(retry).rejects.toThrow("timed out");
  // Recovery admission yields through the existing host boundary, not a new retry policy.
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(local).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(100);
  await expired;
  expect(signal.aborted).toBe(true);
});

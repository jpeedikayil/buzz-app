import { afterEach, expect, it, vi } from "vitest";
import { clientMetrics, createClientMetrics } from "./client-metrics";

afterEach(() => vi.useRealTimers());
function setup(options: Parameters<typeof createClientMetrics>[0] = {}) {
  let time = 0;
  const frames: (() => void)[] = [];
  const metrics = createClientMetrics({
    now: () => time,
    monitor: false,
    afterPaint: (callback) => frames.push(callback),
    ...options,
  });
  return {
    metrics,
    advance(ms: number) {
      time += ms;
    },
    paint() {
      for (const frame of frames.splice(0)) frame();
    },
  };
}
const click = (timeStamp: number, detail = 1) =>
  ({ type: "click", detail, timeStamp }) as unknown as Event;

it("times an open from its input event to the painted frame and classifies its source", () => {
  const h = setup();
  h.advance(100);
  h.metrics.channelIntent("alpha-channel", click(90));
  h.metrics.channelMounted("alpha-channel");
  h.metrics.channelEnsured("alpha-channel", "network");
  h.advance(200);
  h.metrics.channelRendered("alpha-channel");
  h.advance(16);
  h.paint();
  // Keyboard activation. The pane renders rows the store already held before
  // its effect ensures the window.
  h.metrics.channelIntent("beta-channel", click(310, 0));
  h.metrics.channelMounted("beta-channel");
  h.metrics.channelRendered("beta-channel");
  h.metrics.channelEnsured("beta-channel", "memory");
  h.advance(10);
  h.paint();
  // Route switch, disk restore landing while the network read was pending.
  h.metrics.channelMounted("gamma-channel");
  h.metrics.channelEnsured("gamma-channel", "network");
  h.advance(40);
  h.metrics.channelData("gamma-channel", "disk");
  h.metrics.channelRendered("gamma-channel");
  h.paint();
  const { opens } = h.metrics.export();
  expect(opens).toEqual([
    expect.objectContaining({
      channel: "alpha-ch",
      trigger: "click",
      source: "network",
      ms: 226,
    }),
    expect.objectContaining({
      channel: "beta-cha",
      trigger: "keyboard",
      source: "memory",
      ms: 16,
    }),
    expect.objectContaining({
      channel: "gamma-ch",
      trigger: "route",
      source: "disk-late",
      ms: 40,
    }),
  ]);
  const summary = h.metrics.summary();
  expect(summary.opens.cacheHitRate).toBeCloseTo(1 / 3);
  expect(summary.opens.bySource.network.n).toBe(1);
});

it("splits each open into waiting for rows and rendering them", () => {
  const h = setup();
  // A server read: rows reach the store 300 ms after the click.
  h.metrics.channelIntent("alpha", click(0));
  h.metrics.channelMounted("alpha");
  h.metrics.channelEnsured("alpha", "network");
  h.advance(300);
  h.metrics.channelData("alpha", "network");
  h.metrics.channelData("other", "network"); // Not the channel being opened.
  h.advance(20);
  h.metrics.channelRendered("alpha");
  h.metrics.channelData("alpha", "network"); // A later page doesn't move the wait.
  h.advance(10);
  h.paint();
  // Rows were already in the store, so all of it is rendering.
  h.metrics.channelIntent("beta", click(330));
  h.metrics.channelMounted("beta");
  h.metrics.channelEnsured("beta", "memory");
  h.advance(25);
  h.metrics.channelRendered("beta");
  h.paint();
  expect(h.metrics.export().opens).toEqual([
    expect.objectContaining({ channel: "alpha", ms: 330, waitMs: 300 }),
    expect.objectContaining({ channel: "beta", ms: 25, waitMs: 0 }),
  ]);
  const { bySource } = h.metrics.summary().opens;
  expect(bySource.network).toMatchObject({ waitP50: 300, renderP50: 30 });
  expect(bySource.memory).toMatchObject({ waitP50: 0, renderP50: 25 });
});

it("waits for the rows to be visible, ignores reselecting the shown channel and supersedes abandoned opens", () => {
  const h = setup();
  h.metrics.channelMounted("alpha");
  let visible = false;
  h.metrics.channelRendered("alpha", () => visible);
  h.metrics.channelEnsured("alpha", "disk");
  h.advance(16);
  h.paint();
  expect(h.metrics.export().opens).toEqual([]);
  visible = true;
  h.advance(16);
  h.paint();
  expect(h.metrics.export().opens).toEqual([
    expect.objectContaining({ source: "disk", ms: 32 }),
  ]);
  h.metrics.channelIntent("alpha", click(40));
  h.metrics.channelRendered("alpha");
  h.paint();
  h.metrics.channelIntent("beta", click(50));
  h.metrics.channelIntent("gamma", click(60));
  h.metrics.channelMounted("gamma");
  h.metrics.channelRendered("beta");
  h.metrics.channelRendered("gamma");
  h.paint();
  expect(h.metrics.export().opens.map((open) => open.channel)).toEqual([
    "alpha",
    "gamma",
  ]);
});

it("starts a new open when the pane returns to a channel it left", async () => {
  const h = setup();
  // StrictMode's immediate remount keeps the click's open.
  h.metrics.channelIntent("alpha", click(0));
  h.metrics.channelMounted("alpha");
  h.metrics.channelUnmounted("alpha");
  h.metrics.channelMounted("alpha");
  h.metrics.channelEnsured("alpha", "network");
  await Promise.resolve();
  // Loading when the user leaves for Settings; the late paint is not an open.
  h.advance(50);
  h.metrics.channelUnmounted("alpha");
  await Promise.resolve();
  h.advance(60_000);
  h.metrics.channelMounted("alpha");
  h.metrics.channelEnsured("alpha", "network");
  h.advance(40);
  h.metrics.channelData("alpha", "network");
  h.advance(10);
  h.metrics.channelRendered("alpha");
  h.paint();
  // Painted, left, then back: the return is an open too.
  h.metrics.channelUnmounted("alpha");
  await Promise.resolve();
  h.advance(1000);
  h.metrics.channelMounted("alpha");
  h.metrics.channelRendered("alpha");
  h.metrics.channelEnsured("alpha", "memory");
  h.advance(8);
  // A paint queued before leaving is dropped with its open.
  h.metrics.channelUnmounted("alpha");
  h.paint();
  await Promise.resolve();
  h.metrics.channelMounted("alpha");
  h.metrics.channelRendered("alpha");
  h.metrics.channelEnsured("alpha", "memory");
  h.advance(12);
  h.paint();
  expect(h.metrics.export().opens).toEqual([
    expect.objectContaining({ trigger: "route", source: "network", ms: 50 }),
    expect.objectContaining({ trigger: "route", source: "memory", ms: 12 }),
  ]);
  const late = setup();
  late.metrics.channelIntent("beta", click(0));
  late.metrics.channelMounted("beta");
  late.metrics.channelUnmounted("beta");
  late.metrics.channelMounted("beta");
  late.metrics.channelRendered("beta");
  late.metrics.channelEnsured("beta", "memory");
  late.paint();
  expect(late.metrics.export().opens).toEqual([
    expect.objectContaining({ trigger: "click", source: "memory" }),
  ]);
});

it("records live setup and reads for the first relay session only", () => {
  const h = setup();
  const routes = (status: string) => [
    { id: "channel:0", channelId: "0", status },
  ];
  h.metrics.live("a", { status: "connecting", routes: [] });
  h.advance(20);
  h.metrics.live("a", { status: "connected", routes: routes("live") });
  // Another community connects while A stays retained and keeps reporting.
  h.advance(80);
  h.metrics.live("b", { status: "connecting", routes: [] });
  h.metrics.query("b", { ms: 5, bytes: 100, priority: "foreground", ok: true });
  h.advance(5);
  h.metrics.live("a", { status: "connected", routes: routes("live") });
  h.advance(195);
  h.metrics.live("b", { status: "connected", routes: routes("pending") });
  h.advance(200);
  h.metrics.live("b", { status: "connected", routes: routes("live") });
  const { phases } = h.metrics.summary();
  expect(phases).toHaveLength(1);
  expect(phases[0]).toMatchObject({ authMs: 20, coverageMs: 20, queries: 0 });
  expect(h.metrics.export().queries).toEqual([]);
});

it("derives open and reconnect phases, live coverage and per-phase read cost", () => {
  const h = setup();
  const routes = (status: string, count = 3) =>
    Array.from({ length: count }, (_, i) => ({
      id: `channel:${i}`,
      channelId: String(i),
      status,
    }));
  h.advance(5);
  h.metrics.live("a", { status: "connecting", routes: [] });
  h.advance(50);
  h.metrics.live("a", { status: "connected", routes: routes("pending") });
  h.metrics.query("a", {
    ms: 10,
    bytes: 1000,
    priority: "foreground",
    ok: true,
  });
  h.advance(30);
  h.metrics.live("a", {
    status: "connected",
    routes: [
      ...routes("live", 2),
      { id: "channel:2", channelId: "2", status: "pending" },
    ],
  });
  h.advance(20);
  h.metrics.live("a", { status: "connected", routes: routes("live") });
  h.advance(1000);
  h.metrics.live("a", { status: "retrying", routes: routes("pending") });
  h.metrics.query("a", {
    ms: 10,
    bytes: 500,
    priority: "background",
    ok: true,
  });
  h.advance(100);
  h.metrics.live("a", {
    status: "connected",
    routes: [
      ...routes("live", 1),
      // Over the live capacity is settled, but not live.
      { id: "channel:1", channelId: "1", status: "limited" },
      { id: "channel:2", channelId: "2", status: "error" },
    ],
  });
  const [open, reconnect] = h.metrics.summary().phases;
  expect(open).toMatchObject({
    kind: "open",
    start: 5,
    authMs: 50,
    coverageMs: 100,
    routes: 3,
    routeErrors: 0,
    routeMs: { n: 3, p50: 30, max: 50 },
    queries: 1,
    background: 0,
    bytes: 1000,
  });
  expect(reconnect).toMatchObject({
    kind: "reconnect",
    authMs: 100,
    coverageMs: 100,
    routes: 3,
    routeErrors: 2,
    routeMs: { n: 1 },
    queries: 1,
    background: 1,
    bytes: 500,
  });
});

it("keeps a phase's first coverage when routes later resubscribe or are added", () => {
  const h = setup();
  const route = (i: number, status: string) => ({
    id: `channel:${i}`,
    channelId: String(i),
    status,
  });
  h.metrics.live("a", { status: "connecting", routes: [] });
  h.advance(10);
  h.metrics.live("a", { status: "connected", routes: [route(0, "pending")] });
  h.advance(40);
  h.metrics.live("a", { status: "connected", routes: [route(0, "live")] });
  // Minutes later a route resubscribes and a channel is joined.
  h.advance(300_000);
  h.metrics.live("a", {
    status: "connected",
    routes: [route(0, "pending"), route(1, "pending")],
  });
  h.advance(30);
  h.metrics.live("a", {
    status: "connected",
    routes: [route(0, "live"), route(1, "live")],
  });
  // A failed connection that is retried is a new phase.
  h.metrics.live("a", { status: "error", routes: [] });
  h.advance(5);
  h.metrics.live("a", { status: "connecting", routes: [] });
  const [open, retry] = h.metrics.summary().phases;
  expect(open).toMatchObject({
    coverageMs: 50,
    routes: 1,
    routeMs: { n: 1, max: 40 },
  });
  expect(retry).toMatchObject({ kind: "reconnect", start: 300_085 });
});

it("skips opens with nothing to paint, and keeps the shown channel across reset", () => {
  const h = setup();
  // An empty channel, then its first message arriving much later.
  h.metrics.channelIntent("empty", click(0));
  h.metrics.channelMounted("empty");
  h.metrics.channelEmpty("empty");
  h.advance(5000);
  h.metrics.channelRendered("empty");
  h.paint();
  // Rows that never become visible (a saved scroll position, say).
  h.metrics.channelIntent("scrolled", click(5000));
  h.metrics.channelMounted("scrolled");
  h.metrics.channelRendered("scrolled", () => false);
  for (let frame = 0; frame < 40; frame++) h.paint();
  expect(h.metrics.export().opens).toEqual([]);
  expect(h.metrics.summary().opens.skipped).toBe(2);
  h.metrics.reset();
  expect(h.metrics.summary().opens.skipped).toBe(0);
  h.metrics.channelIntent("scrolled", click(6000));
  h.metrics.channelRendered("scrolled");
  h.paint();
  expect(h.metrics.export().opens).toEqual([]);
});

it("ignores timer lag while the page is hidden", () => {
  vi.useFakeTimers();
  const listeners: (() => void)[] = [];
  const page = {
    hidden: false,
    addEventListener: (_: string, listener: () => void) =>
      listeners.push(listener),
  };
  vi.stubGlobal("document", page);
  try {
    let time = 0;
    const metrics = createClientMetrics({ now: () => time, monitor: true });
    metrics.cpu("fold", 1, 1); // Starts the monitor.
    page.hidden = true;
    for (const listener of listeners) listener();
    time += 1000; // Throttled to one tick a second.
    vi.advanceTimersByTime(50);
    time += 1000;
    vi.advanceTimersByTime(50);
    page.hidden = false;
    time += 400; // Visible again before the next tick.
    for (const listener of listeners) listener();
    time += 50;
    vi.advanceTimersByTime(50);
    expect(metrics.summary().mainThread.longTasks).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("records event-loop lag as long tasks and sums CPU per stage", () => {
  vi.useFakeTimers();
  let time = 0;
  const metrics = createClientMetrics({ now: () => time, monitor: true });
  metrics.cpu("verify.read", 12, 24);
  time += 250; // The loop was blocked; the 50 ms sampler fires late.
  vi.advanceTimersByTime(50);
  time += 50;
  vi.advanceTimersByTime(50);
  metrics.cpu("verify.read", 3, 6);
  const { mainThread } = metrics.summary();
  expect(mainThread.longTasks).toBe(1);
  expect(mainThread.longTaskMs).toBe(200);
  expect(mainThread.cpu["verify.read"]).toEqual({ ms: 15, count: 30 });
});

it("keeps the newest 1,000 unread passes in the export until reset", () => {
  const h = setup();
  const pass = (events: number) =>
    ({ route: "delta", fits: true, events, bytes: 2 }) as const;
  h.metrics.unreadPass({ ...pass(0), route: "bootstrap", fits: false });
  h.advance(5);
  for (let i = 1; i <= 1000; i++) h.metrics.unreadPass(pass(i));
  const { unreadPasses } = h.metrics.export();
  expect(unreadPasses).toHaveLength(1000);
  expect(unreadPasses[0]).toEqual({ ...pass(1), at: 5, phase: 0 });
  expect(unreadPasses.at(-1)).toEqual({ ...pass(1000), at: 5, phase: 0 });
  h.metrics.reset();
  expect(h.metrics.export().unreadPasses).toEqual([]);
});

it("records nothing when disabled, and unit tests get the disabled singleton", () => {
  const h = setup({ enabled: false });
  h.metrics.channelMounted("alpha");
  h.metrics.channelRendered("alpha");
  h.metrics.query("a", { ms: 1, bytes: 1, priority: "foreground", ok: true });
  h.metrics.unreadPass({ route: "delta", fits: true, events: 1, bytes: 2 });
  h.paint();
  expect(h.metrics.export()).toMatchObject({
    opens: [],
    queries: [],
    unreadPasses: [],
  });
  expect(clientMetrics.enabled).toBe(false);
});

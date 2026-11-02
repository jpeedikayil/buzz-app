/** Local, bounded client performance metrics for development builds.
 * Nothing here leaves the device: the Developer settings panel reads and
 * exports it. Records are per open, request, batch or long task, never per event. */

export type OpenTrigger = "click" | "keyboard" | "route";
/** Where the first painted rows came from. `disk-late` means the open waited,
 * then a disk restore landed before the network read did. */
export type OpenSource = "memory" | "disk" | "disk-late" | "network";
export type ChannelOpen = Readonly<{
  channel: string;
  trigger: OpenTrigger;
  source: OpenSource;
  /** Input event (or mount) to the frame after first rows were committed. */
  ms: number;
  /** Until the store held rows for the channel: a disk read or relay request.
   * Zero when the rows were already there. The rest of `ms` is rendering. */
  waitMs: number;
  at: number;
  phase: number;
}>;
export type LivePhase = {
  kind: "open" | "reconnect";
  start: number;
  /** First socket authentication in this phase, relative to `start`. */
  authMs?: number;
  /** First moment every channel route had settled (live or failed), relative to `start`. */
  coverageMs?: number;
  routes: number;
  /** Routes that settled without going live: refused, or over live capacity. */
  routeErrors: number;
  /** Pending → live, per channel route. */
  routeMs: number[];
  queries: number;
  background: number;
  bytes: number;
};
type QueryRecord = Readonly<{
  at: number;
  ms: number;
  bytes: number;
  priority: "foreground" | "background";
  ok: boolean;
  phase: number;
}>;
/** One unread repair pass: the reads it took, a catch-up from the saved
 * mark or the full repair, and the evidence its save selected, with whether
 * that fit the saved record's bounds. */
type UnreadPass = Readonly<{
  route: "delta" | "bootstrap";
  fits: boolean;
  events: number;
  bytes: number;
  at: number;
  phase: number;
}>;
type LongTask = Readonly<{
  start: number;
  duration: number;
}>;
type LiveRouteState = Readonly<{
  id: string;
  channelId?: string;
  status: string;
}>;
type LiveState = Readonly<{
  status: string;
  routes: readonly LiveRouteState[];
}>;

const OPEN_LIMIT = 500;
const QUERY_LIMIT = 4000;
const TASK_LIMIT = 2000;
const UNREAD_PASS_LIMIT = 1000;
const LAG_SAMPLE_MS = 50;
const PAINT_FRAMES = 30;

export function percentile(values: readonly number[], p: number) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}
const distribution = (values: readonly number[]) => ({
  n: values.length,
  p50: percentile(values, 50),
  p90: percentile(values, 90),
  max: values.length ? Math.max(...values) : undefined,
});
/** Totals plus medians of the wait/render split. Medians of the parts need
 * not add up to the median total. */
const loads = (list: readonly ChannelOpen[]) => ({
  ...distribution(list.map((open) => open.ms)),
  waitP50: percentile(
    list.map((open) => open.waitMs),
    50,
  ),
  renderP50: percentile(
    list.map((open) => open.ms - open.waitMs),
    50,
  ),
});
const push = <T>(list: T[], value: T, limit: number) => {
  list.push(value);
  if (list.length > limit) list.splice(0, list.length - limit);
};

export function createClientMetrics({
  enabled = true,
  now = () => performance.now(),
  monitor = typeof window !== "undefined" && typeof document !== "undefined",
  afterPaint = (callback: () => void) => {
    if (typeof requestAnimationFrame !== "function") return callback();
    // rAF runs before the frame is painted; a task queued from it runs after.
    requestAnimationFrame(() => setTimeout(callback, 0));
  },
}: {
  enabled?: boolean;
  now?: () => number;
  /** Observe long tasks (or event-loop lag where unsupported, e.g. WebKit). */
  monitor?: boolean;
  afterPaint?: (callback: () => void) => void;
} = {}) {
  const opens: ChannelOpen[] = [];
  const queries: QueryRecord[] = [];
  const unreadPasses: UnreadPass[] = [];
  const longTasks: LongTask[] = [];
  const phases: LivePhase[] = [
    {
      kind: "open",
      start: 0,
      routes: 0,
      routeErrors: 0,
      routeMs: [],
      queries: 0,
      background: 0,
      bytes: 0,
    },
  ];
  const cpu = new Map<string, { ms: number; count: number }>();
  let pending:
    | {
        channel: string;
        trigger: OpenTrigger;
        start: number;
        ensured?: "memory" | "disk" | "network";
        /** The store first held rows for the channel during this open. */
        dataAt?: number;
        dataOrigin?: "disk" | "network";
        rendered?: boolean;
      }
    | undefined;
  let shown: string | undefined;
  let monitoring = false;
  let everConnected = false;
  let skipped = 0;
  const routeSeen = new Map<string, number>();
  const routeDone = new Set<string>();
  let lastStatus: string | undefined;
  /** Live and read metrics follow one relay session: its phases are per
   * connection, and a retained community's socket would read as a reconnect. */
  let owner: string | undefined;
  function owns(session: string) {
    owner ??= session;
    return owner === session;
  }

  const phase = () => phases.length - 1;
  const currentPhase = () => phases[phase()] as LivePhase;
  function startMonitor() {
    if (monitoring || !monitor || !enabled) return;
    monitoring = true;
    const record = (start: number, duration: number) =>
      push(longTasks, Object.freeze({ start, duration }), TASK_LIMIT);
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask")
    ) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          record(entry.startTime, entry.duration);
      }).observe({ type: "longtask", buffered: true });
      return;
    }
    // WebKit has no long-task entries. Timer lag is a coarser equivalent.
    // Hidden pages throttle timers, which is not main-thread work.
    const hidden = () => typeof document !== "undefined" && document.hidden;
    let expected = now() + LAG_SAMPLE_MS;
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", () => {
        expected = now() + LAG_SAMPLE_MS;
      });
    setInterval(() => {
      const current = now();
      const lag = current - expected;
      if (lag >= LAG_SAMPLE_MS && !hidden()) record(expected, lag);
      expected = current + LAG_SAMPLE_MS;
    }, LAG_SAMPLE_MS);
  }
  const active = <A extends unknown[], R>(work: (...args: A) => R) =>
    ((...args: A) => {
      if (!enabled) return undefined;
      startMonitor();
      return work(...args);
    }) as (...args: A) => R | undefined;

  function finishOpen() {
    const open = pending;
    if (!open) return;
    pending = undefined;
    const at = now();
    // Rows the store already held keep their origin; otherwise they arrived
    // during the open.
    const source: OpenSource =
      open.ensured === "memory" || open.ensured === "disk"
        ? open.ensured
        : open.dataOrigin === "disk"
          ? "disk-late"
          : open.dataOrigin || open.ensured
            ? "network"
            : "memory";
    push(
      opens,
      Object.freeze({
        channel: open.channel.slice(0, 8),
        trigger: open.trigger,
        source,
        ms: at - open.start,
        waitMs: Math.max(0, (open.dataAt ?? open.start) - open.start),
        at: open.start,
        phase: phase(),
      }),
      OPEN_LIMIT,
    );
  }

  function summary() {
    const hits = opens.filter(
      (open) => open.source === "memory" || open.source === "disk",
    );
    const bySource = Object.fromEntries(
      (["memory", "disk", "disk-late", "network"] as const).map((source) => [
        source,
        loads(opens.filter((open) => open.source === source)),
      ]),
    ) as Record<OpenSource, ReturnType<typeof loads>>;
    return {
      opens: {
        ...distribution(opens.map((open) => open.ms)),
        cacheHitRate: opens.length ? hits.length / opens.length : undefined,
        /** Opens dropped because nothing painted: empty, failed or scrolled away. */
        skipped,
        bySource,
      },
      mainThread: {
        longTasks: longTasks.length,
        longTaskMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
        cpu: Object.fromEntries(cpu),
      },
      phases: phases.map((entry) => ({
        ...entry,
        routeMs: distribution(entry.routeMs),
      })),
    };
  }

  return Object.freeze({
    enabled,
    /** A user asked to open a channel; timing starts at the input event.
     * Keyboard activation of a button arrives as a click with no pointer detail. */
    channelIntent: active((channel: string, input?: Event) => {
      // Reselecting the channel on screen renders nothing new.
      if (channel === shown) return;
      const keyboard =
        input?.type.startsWith("key") ||
        (input?.type === "click" && (input as MouseEvent).detail === 0);
      pending = {
        channel,
        trigger: !input ? "route" : keyboard ? "keyboard" : "click",
        start: input?.timeStamp ?? now(),
      };
    }),
    /** The conversation pane switched channels. A switch without an intent is a route. */
    channelMounted: active((channel: string) => {
      if (channel === shown) return;
      shown = channel;
      if (pending?.channel !== channel)
        pending = { channel, trigger: "route", start: now() };
    }),
    /** The pane stopped showing a channel (switched, or replaced by another
     * page). Returning to it is a new open, and its unfinished open is dropped
     * unless the pane remounts at once (React StrictMode replays effects). */
    channelUnmounted: active((channel: string) => {
      if (shown !== channel) return;
      shown = undefined;
      const open = pending;
      queueMicrotask(() => {
        if (shown !== channel && pending === open && open?.channel === channel)
          pending = undefined;
      });
    }),
    /** The store's view of the demanded window when it was ensured. The pane
     * may already have rendered rows it held, before its effect ensured it. */
    channelEnsured: active(
      (channel: string, source: "memory" | "disk" | "network") => {
        if (pending?.channel === channel && !pending.ensured)
          pending.ensured = source;
      },
    ),
    /** The store first holds rows for a channel whose window was empty. */
    channelData: active((channel: string, origin: "disk" | "network") => {
      if (pending?.channel !== channel || pending.rendered) return;
      pending.dataAt ??= now();
      pending.dataOrigin ??= origin;
    }),
    /** Message rows were committed for a channel. Records after the first
     * paint in which `visible` holds (a virtualized list may need a frame). */
    channelRendered: active(
      (channel: string, visible: () => boolean = () => true) => {
        const open = pending;
        if (open?.channel !== channel || open.rendered) return;
        open.rendered = true;
        let frames = 0;
        const check = () => {
          if (pending !== open || shown !== channel) return;
          if (visible()) finishOpen();
          else if (++frames < PAINT_FRAMES) afterPaint(check);
          else {
            // Recording now would time the fallback, not the paint.
            pending = undefined;
            skipped++;
          }
        };
        afterPaint(check);
      },
    ),
    /** The channel settled with nothing to paint (empty or failed), so its
     * pending open would otherwise time the first message or a retry. */
    channelEmpty: active((channel: string) => {
      if (pending?.channel !== channel || pending.rendered) return;
      pending = undefined;
      skipped++;
    }),
    /** A finite relay read finished. One call per request, never per event.
     * `session` names the relay session; only the first one seen is recorded. */
    query: active(
      (
        session: string,
        input: {
          ms: number;
          bytes: number;
          priority: "foreground" | "background";
          ok: boolean;
        },
      ) => {
        if (!owns(session)) return;
        const current = currentPhase();
        current.queries++;
        current.bytes += input.bytes;
        if (input.priority === "background") current.background++;
        push(
          queries,
          Object.freeze({ ...input, at: now(), phase: phase() }),
          QUERY_LIMIT,
        );
      },
    ),
    /** An unread repair pass saved its record. One call per pass. */
    unreadPass: active((input: Omit<UnreadPass, "at" | "phase">) => {
      push(
        unreadPasses,
        Object.freeze({ ...input, at: now(), phase: phase() }),
        UNREAD_PASS_LIMIT,
      );
    }),
    /** Synchronous main-thread work measured by its caller, per batch. */
    cpu: active((stage: string, ms: number, count: number) => {
      const entry = cpu.get(stage) ?? { ms: 0, count: 0 };
      entry.ms += ms;
      entry.count += count;
      cpu.set(stage, entry);
    }),
    /** Observe live route state; derives connect/reconnect phases and coverage. */
    live: active((session: string, state: LiveState) => {
      if (!owns(session)) return;
      const at = now();
      const reconnecting =
        everConnected &&
        (state.status === "retrying" || state.status === "connecting") &&
        (lastStatus === "connected" || lastStatus === "error");
      lastStatus = state.status;
      if (reconnecting) {
        phases.push({
          kind: "reconnect",
          start: at,
          routes: 0,
          routeErrors: 0,
          routeMs: [],
          queries: 0,
          background: 0,
          bytes: 0,
        });
        if (phases.length > 64) phases.splice(1, 1);
        routeSeen.clear();
        routeDone.clear();
      }
      const current = currentPhase();
      if (
        current.kind === "open" &&
        !current.start &&
        state.status === "connecting"
      )
        current.start = at;
      if (state.status !== "connected") return;
      everConnected = true;
      current.authMs ??= at - current.start;
      const channels = state.routes.filter((route) => route.channelId);
      for (const route of channels) {
        if (!routeSeen.has(route.id)) {
          // A join or new DM after coverage is not setup cost.
          if (current.coverageMs !== undefined) continue;
          routeSeen.set(route.id, at);
        }
        if (route.status === "live" && !routeDone.has(route.id)) {
          routeDone.add(route.id);
          current.routeMs.push(at - (routeSeen.get(route.id) ?? at));
        }
      }
      // Only the first time every route settles counts; later resubscribes
      // would otherwise overwrite the phase's coverage.
      if (
        current.coverageMs === undefined &&
        channels.length > 0 &&
        channels.every((route) =>
          ["live", "error", "limited"].includes(route.status),
        )
      ) {
        current.coverageMs = at - current.start;
        current.routes = channels.length;
        current.routeErrors = channels.filter(
          (route) => route.status !== "live",
        ).length;
      }
    }),
    summary,
    export(label = "") {
      return {
        version: 1,
        label,
        exportedAt: new Date().toISOString(),
        userAgent:
          typeof navigator === "undefined" ? undefined : navigator.userAgent,
        summary: summary(),
        opens: [...opens],
        queries: [...queries],
        unreadPasses: [...unreadPasses],
        longTasks: [...longTasks],
      };
    },
    reset() {
      opens.length = 0;
      queries.length = 0;
      unreadPasses.length = 0;
      longTasks.length = 0;
      cpu.clear();
      skipped = 0;
      // Keep `shown`: the pane still shows it, and reselecting it opens nothing.
      pending = undefined;
      // Keep the current phase and its coverage; reset only its counters.
      const current = currentPhase();
      phases.splice(0, phases.length, {
        ...current,
        queries: 0,
        background: 0,
        bytes: 0,
      });
    },
  });
}
export type ClientMetrics = ReturnType<typeof createClientMetrics>;

/** Development builds only; production and unit tests get a no-op recorder. */
export const clientMetrics = createClientMetrics({
  enabled: import.meta.env?.DEV === true && import.meta.env?.MODE !== "test",
});
if (clientMetrics.enabled)
  (globalThis as { __buzzClientMetrics?: ClientMetrics }).__buzzClientMetrics =
    clientMetrics;

import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { flush, keypair, scriptedTransport, signed } from "./testing";

const viewer = keypair(),
  relay = keypair(),
  other = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const OPEN = "33333333-3333-4333-8333-333333333333";
const CLOSED = "44444444-4444-4444-8444-444444444444";

function harness() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const update =
    vi.fn<(ids: readonly string[], joined?: readonly string[]) => void>();
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    scope: "https://one.example",
    subscribe(callbacks) {
      live = callbacks;
      return { update, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  /** Connects, and the viewer's roster read finds no channel. */
  const discover = async () => {
    live.state({ status: "connected", routes: [] });
    live.established();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    wire.next().respond([]);
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
  };
  /** Drops and restores the socket, and discovery reads the roster again. */
  const reconnect = async () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    live.established();
    const roster = () =>
      wire.pending.findIndex(
        (entry) =>
          !entry.signal?.aborted &&
          !entry.filters.some((filter) => filter["#d"]),
      );
    await vi.waitFor(() => expect(roster()).not.toBe(-1));
    wire.pending.splice(roster(), 1)[0]?.respond([]);
    await flush();
  };
  return { owner, wire, update, discover, reconnect };
}
/** The relay's signed metadata and roster of a channel only `other` is in. */
const channel = (id: string, visibility: "public" | "private") => [
  signed(relay, {
    kind: 39000,
    content: "",
    created_at: 10,
    tags: [["d", id], ["name", id.slice(0, 4)], [visibility]],
  }),
  signed(relay, {
    kind: 39002,
    content: "",
    created_at: 10,
    tags: [
      ["d", id],
      ["p", other.pubkey],
    ],
  }),
];
const asks = (filters: readonly { "#d"?: readonly string[] }[], id: string) =>
  filters.some((filter) => filter["#d"]?.includes(id));

it("keeps an attended public channel live once its metadata is read, never a private one, and drops it when stopped", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const joined = () => h.update.mock.lastCall?.[1] ?? [];
  const stop = h.owner.session.attend([OPEN, CLOSED, "not a channel id"]);
  // Unknown until the relay's metadata is read, which waits for discovery:
  // a lookup must not stand in for it.
  await flush();
  expect(live()).not.toContain(OPEN);
  expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(false);
  await h.discover();
  await vi.waitFor(() =>
    expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
      true,
    ),
  );
  const read = h.wire.pending.find((entry) => asks(entry.filters, OPEN));
  read?.respond([
    ...channel(OPEN, "public"),
    ...channel(CLOSED, "private"),
  ] as RelayEvent[]);
  await vi.waitFor(() => expect(live()).toContain(OPEN));
  await flush();
  // Live, though not joined or listed; a private channel the viewer is not
  // in is not live.
  expect(joined()).not.toContain(OPEN);
  expect(live()).not.toContain(CLOSED);
  expect(
    h.owner.session.channels.list().channels.map(({ id }) => id),
  ).not.toContain(OPEN);
  stop();
  expect(live()).not.toContain(OPEN);
});

it("says an attended channel is pending until its metadata is read, and reads again what failed", async () => {
  const h = harness();
  const pending = () => h.owner.session.attendPending(OPEN);
  const lookup = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  /** Answers the metadata read in flight, and takes it off the wire. */
  const answer = (
    respond: (entry: NonNullable<ReturnType<typeof lookup>>) => void,
  ) => {
    const entry = lookup();
    if (!entry) throw new Error("No metadata read");
    h.wire.pending.splice(h.wire.pending.indexOf(entry), 1);
    respond(entry);
  };
  expect(pending()).toBe(false);
  h.owner.session.attend([OPEN]);
  expect(pending()).toBe(true);
  await h.discover();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // A failed read leaves it pending, and a reconnect reads it again.
  answer((entry) => entry.fail(new Error("down")));
  await flush();
  expect(pending()).toBe(true);
  expect(lookup()).toBeUndefined();
  await h.reconnect();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // So does a wait, with no reconnect.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    answer((entry) => entry.fail(new Error("down again")));
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  expect(pending()).toBe(true);
  answer((entry) => entry.respond(channel(OPEN, "public") as RelayEvent[]));
  await vi.waitFor(() => expect(pending()).toBe(false));
});

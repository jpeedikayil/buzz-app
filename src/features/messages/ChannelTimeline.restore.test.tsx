// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { ChannelTimeline } from "./ChannelTimeline";
import { createRelaySession } from "../relay/session";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import type { RelayEvent } from "../relay/events";
import type { ReadTarget } from "../relay/read-state-model";
import { keypair, message, scriptedTransport } from "../relay/testing";
import { readView, writeView } from "../../shared/view-state";
import { MessageManagement } from "./MessageManagement";

// Real React lifecycle; only the virtualizer's imperative layout boundary is
// modeled here. Browser journeys retain the actual same-message/4px contract.
const scroll = vi.hoisted(() => ({
  toIndex: vi.fn(),
  toOffset: vi.fn(),
  itemOffset: vi.fn((_index: number) => 0),
  resized: () => {},
}));
vi.mock("virtua", async () => {
  const { Children, forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children, onResize }: { children: ReactNode; onResize?: () => void },
      ref,
    ) {
      scroll.resized = onResize ?? (() => {});
      useImperativeHandle(ref, () => ({
        cache: undefined,
        findItemIndex: () => 0,
        getItemOffset: scroll.itemOffset,
        scrollToIndex: scroll.toIndex,
        scrollTo: scroll.toOffset,
      }));
      return (
        <ol style={{ height: 2000 }}>
          {Children.map(children, (child) => (
            <li>{child}</li>
          ))}
        </ol>
      );
    }),
  };
});
const frames = new Map<number, FrameRequestCallback>();
const resizes = new Set<() => void>();
let nextFrame = 0;
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  scroll.toIndex.mockClear();
  scroll.toOffset.mockClear();
  scroll.itemOffset.mockReset().mockReturnValue(0);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizes.add(this.callback);
      }
      disconnect() {
        resizes.delete(this.callback);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function frame() {
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  });
}
function mount(bottom = false, revealOnMount = false, anchorLoaded = true) {
  const viewer = keypair(),
    relay = keypair();
  const target = message(viewer, "c", "Saved reading anchor", 1);
  const earlier = message(viewer, "c", "Earlier message", 0);
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  owners.push(owner);
  writeView("scope", "scroll:c", {
    offset: 900,
    bottom,
    anchor: { id: target.id, y: 42 },
  });
  const window: ChannelWindow = {
    channelId: "c",
    status: "ready",
    freshness: "cached",
    hasMore: false,
    loadingOlder: false,
    error: undefined,
    rows: [anchorLoaded ? target : earlier].map((event) => ({
      id: event.id,
      channelId: "c",
      authorId: viewer.pubkey,
      content: event.content,
      createdAt: event.created_at,
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
    })),
  };
  const tree = (snapshot: ChannelWindow, revealMessageId?: string) => (
    <StrictMode>
      <ChannelTimeline
        channelId="c"
        scope="scope"
        queries={owner.session}
        window={snapshot}
        revealMessageId={revealMessageId}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  const first = window.rows[0];
  if (!first) throw new Error("Missing fixture row");
  const sent = { ...first, id: "sent", content: "New message" };
  const older = {
    ...first,
    id: "older",
    content: "Older history",
    createdAt: 0,
  };
  const sentWindow = { ...window, rows: [...window.rows, sent] };
  const result = render(
    revealOnMount ? tree(sentWindow, sent.id) : tree(window),
  );
  return {
    saved: { offset: 900, bottom, anchor: { id: target.id, y: 42 } },
    unmount: result.unmount,
    /** A reload never runs unmount cleanup; reopen from what storage holds. */
    reload() {
      const write = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {});
      result.unmount();
      write.mockRestore();
      scroll.toIndex.mockClear();
      render(tree(window));
    },
    reveal() {
      result.rerender(tree(sentWindow, sent.id));
    },
    refreshSent() {
      result.rerender(
        tree({ ...sentWindow, rows: [...sentWindow.rows] }, sent.id),
      );
    },
    awaitReveal() {
      result.rerender(tree(window, sent.id));
    },
    prependOlder() {
      // An older-history page lands while the sent row is still revealing.
      result.rerender(
        tree({ ...sentWindow, rows: [older, ...sentWindow.rows] }, sent.id),
      );
    },
    /** The network head lands after the saved head, with the saved row in it. */
    loadAnchor() {
      result.rerender(
        tree({ ...window, rows: [first, { ...first, id: target.id }] }),
      );
    },
    replaceAnchor() {
      const first = window.rows[0];
      if (!first) throw new Error("Missing fixture row");
      result.rerender(
        tree({ ...window, rows: [{ ...first, id: "replacement" }] }),
      );
    },
    promote() {
      result.rerender(
        tree({ ...window, freshness: "verified", rows: [...window.rows] }),
      );
    },
    append() {
      result.rerender(tree(sentWindow));
    },
    pageAroundAnchor() {
      result.rerender(
        tree({ ...sentWindow, rows: [older, ...sentWindow.rows] }),
      );
    },
    async measured() {
      await act(async () => {
        screen.getByRole("list").style.height = "2120px";
        await Promise.resolve(); // deliver the real MutationObserver before rAF
      });
    },
  };
}

function boundaryFixture() {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  owners.push(owner);
  const unreadIds = new Set<string>(),
    forcedIds = new Set<string>(),
    unknownIds = new Set<string>(),
    pendingIds = new Set<string>(),
    ineligibleIds = new Set<string>(),
    listeners = new Set<() => void>();
  const syncListeners = new Set<() => void>();
  let readRevision = owner.session.unread.revision();
  let syncSnapshot = owner.session.unread.sync();
  const entries: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (cause: Error) => void;
    settled: boolean;
  }[] = [];
  const enterChannel = vi.fn(() => {
    let resolve!: () => void;
    let reject!: (cause: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = () => resolvePromise();
      reject = rejectPromise;
    });
    entries.push({ promise, resolve, reject, settled: false });
    return promise;
  });
  const channelList = {
    status: "ready" as const,
    channels: ["c", "other"].map((id) => ({
      id,
      name: id,
      members: [viewer.pubkey],
    })),
  };
  const windows = new Map<string, ChannelWindow>();
  const channels = {
    ...owner.session.channels,
    window: (id: string) =>
      windows.get(id) ?? owner.session.channels.window(id),
    list: () => channelList,
    subscribeList: () => () => {},
  };
  const snapshot = (channelId: string) => {
    return {
      target: { kind: "channel" as const, channelId },
      observedCount: unreadIds.size,
      attentionCount: 0,
      coverage: "observed" as const,
      freshness: "observed" as const,
      manual: "none" as const,
    };
  };
  const snapshots = new Map([
    ["c", snapshot("c")],
    ["other", snapshot("other")],
  ]);
  const unread = {
    ...owner.session.unread,
    enterChannel,
    snapshot(target: ReadTarget) {
      return snapshots.get(target.channelId) ?? snapshot(target.channelId);
    },
    subscribe(_target: ReadTarget, listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync: () => syncSnapshot,
    subscribeSync(listener: () => void) {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    attention(_channelId: string, id: string) {
      return {
        status: unknownIds.has(id)
          ? ("unknown" as const)
          : ineligibleIds.has(id)
            ? ("ineligible" as const)
            : ("eligible" as const),
        ...(pendingIds.has(id) ? { pending: true } : {}),
        unread: unreadIds.has(id),
        forced: forcedIds.has(id),
        viewing: false,
      };
    },
    revision: () => readRevision,
  };
  const session = { ...owner.session, channels, unread };
  function row(
    event: RelayEvent,
    channelId = "c",
    extra: Partial<ChannelMessage> = {},
  ): ChannelMessage {
    snapshots.set(channelId, snapshot(channelId));
    return {
      id: event.id,
      channelId,
      authorId: event.pubkey,
      content: event.content,
      createdAt: event.created_at,
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      ...extra,
    };
  }
  function tree(
    channelId: string,
    rows: readonly ChannelMessage[],
    hasMore = false,
    active = true,
    presented = true,
  ) {
    const window: ChannelWindow = {
      channelId,
      status: "ready",
      freshness: "verified",
      hasMore,
      loadingOlder: false,
      historyLimited: false,
      error: undefined,
      rows,
    };
    windows.set(channelId, window);
    return (
      <MessageManagement
        session={session}
        channelId={channelId}
        active={active}
      >
        {presented ? (
          <ChannelTimeline
            channelId={channelId}
            scope="scope"
            viewer={viewer.pubkey}
            queries={session}
            window={window}
            onOpenLink={() => false}
          />
        ) : (
          <p role="status">Loading messages…</p>
        )}
      </MessageManagement>
    );
  }
  function publish(channelId = "c") {
    snapshots.set(channelId, snapshot(channelId));
    act(() => {
      for (const listener of [...listeners]) listener();
    });
  }
  function completeReadStateSnapshot() {
    syncSnapshot = {
      ...syncSnapshot,
      status: "reconciled",
      completeness: "snapshot",
    };
    act(() => {
      for (const listener of [...syncListeners]) listener();
    });
  }
  return {
    owner,
    viewer,
    peer,
    row,
    tree,
    unread,
    unreadIds,
    forcedIds,
    unknownIds,
    pendingIds,
    ineligibleIds,
    enterChannel,
    subscribers: () => ({ unread: listeners.size, sync: syncListeners.size }),
    completeReadStateSnapshot,
    async completeEntry() {
      const entry = entries.find((candidate) => !candidate.settled);
      if (!entry) throw new Error("No pending channel entry");
      entry.settled = true;
      await act(async () => {
        entry.resolve();
        await entry.promise;
      });
    },
    async failEntry() {
      const entry = entries.find((candidate) => !candidate.settled);
      if (!entry) throw new Error("No pending channel entry");
      entry.settled = true;
      await act(async () => {
        entry.reject(new Error("Could not restore unread state."));
        await entry.promise.catch(() => {});
      });
    },
    notifyAttention() {
      act(() => {
        for (const listener of [...syncListeners]) listener();
      });
    },
    advanceReadRevision() {
      readRevision++;
    },
    publish,
  };
}

it("waits for entry and unread evidence before selecting a verified entry boundary", async () => {
  const h = boundaryFixture();
  const own = h.row(message(h.viewer, "c", "Own message", 1));
  const agents = h.row(message(h.peer, "c", "Agent coordination", 2), "c", {
    audience: "agents",
  });
  const joined = h.row(message(h.peer, "c", "Membership activity", 3), "c", {
    membership: {
      type: "member_joined",
      actor: h.viewer.pubkey,
      target: h.peer.pubkey,
    },
  });
  const firstUnread = h.row(message(h.peer, "c", "First unread message", 4));
  const laterUnread = h.row(message(h.peer, "c", "Later unread message", 5));
  h.forcedIds.add(own.id);
  h.unreadIds.add(agents.id);
  h.unreadIds.add(firstUnread.id);
  h.forcedIds.add(firstUnread.id);
  h.unreadIds.add(laterUnread.id);
  const rows = [own, agents, joined, firstUnread, laterUnread];
  const mounted = render(h.tree("c", rows));
  expect(h.enterChannel).toHaveBeenCalledExactlyOnceWith("c");
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  await h.completeEntry();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();

  h.unknownIds.add(firstUnread.id);
  mounted.rerender(h.tree("c", rows));
  h.publish();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();

  h.unknownIds.delete(firstUnread.id);
  h.pendingIds.add(firstUnread.id);
  h.notifyAttention();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  h.pendingIds.delete(firstUnread.id);
  h.ineligibleIds.add(firstUnread.id);
  h.notifyAttention();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  h.completeReadStateSnapshot();
  h.publish();
  const separator = screen.getByText("New messages", { exact: true });
  const first = screen.getByText("First unread message", { exact: true });
  const row = (id: string) =>
    document.querySelector(`[data-message-id="${id}"]`);
  for (const preceding of [own, agents, joined]) {
    const earlier = row(preceding.id);
    expect(earlier).not.toBeNull();
    expect(
      (earlier?.compareDocumentPosition(separator) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  }
  expect(
    separator.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(screen.queryByText("Own message", { exact: true })).not.toBeNull();
});

it.each([
  { remoteRead: false, presented: true },
  { remoteRead: true, presented: true },
  { remoteRead: true, presented: false },
])(
  "does not infer an entry boundary after incomplete history: %j",
  async ({ remoteRead, presented }) => {
    const h = boundaryFixture();
    const older = h.row(
      message(h.peer, "c", "Older unread outside the entry window", 1),
    );
    const read = h.row(message(h.peer, "c", "Read in loaded window", 2));
    const unread = h.row(message(h.peer, "c", "Unread in loaded window", 3));
    h.unreadIds.add(older.id);
    h.unreadIds.add(unread.id);
    h.completeReadStateSnapshot();
    h.publish();
    const revision = h.unread.revision();
    const mounted = render(h.tree("c", [read, unread], true, true, presented));
    await h.completeEntry();
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();

    if (remoteRead) h.unreadIds.delete(older.id);
    h.publish();
    mounted.rerender(h.tree("c", [older, read, unread]));
    h.publish();
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();
    expect(h.unread.attention("c", older.id).unread).toBe(!remoteRead);
    expect(h.unread.attention("c", unread.id).unread).toBe(true);
    expect(h.unread.revision()).toBe(revision);
    mounted.unmount();
  },
);

it("does not select a stale unread row after reading advances while unread evidence is pending", async () => {
  const h = boundaryFixture();
  const read = h.row(message(h.peer, "c", "Already read", 1));
  const unread = h.row(message(h.peer, "c", "Unread before paging", 2));
  h.unreadIds.add(unread.id);
  const mounted = render(h.tree("c", [read, unread]));

  await h.completeEntry();
  h.advanceReadRevision();
  h.completeReadStateSnapshot();
  mounted.rerender(h.tree("c", [read, unread]));
  h.publish();

  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  mounted.unmount();
});

it("omits a pending boundary after a shared read revision changes without changing this channel's unread evidence", async () => {
  const h = boundaryFixture();
  const unread = h.row(message(h.peer, "c", "Still unread in this channel", 1));
  h.unreadIds.add(unread.id);
  h.publish();
  const target = { kind: "channel" as const, channelId: "c" };
  const entrySnapshot = h.unread.snapshot(target);
  const entryAttention = h.unread.attention("c", unread.id);
  const mounted = render(h.tree("c", [unread]));
  await h.completeEntry();

  h.advanceReadRevision();
  h.publish("other");
  h.completeReadStateSnapshot();
  mounted.rerender(h.tree("c", [unread]));

  expect(screen.queryByRole("separator", { name: "New messages" })).toBeNull();
  expect(h.unread.snapshot(target)).toBe(entrySnapshot);
  expect(h.unread.snapshot(target).observedCount).toBe(1);
  expect(h.unread.attention("c", unread.id)).toEqual(entryAttention);
  expect(h.unread.attention("c", unread.id).unread).toBe(true);
  mounted.unmount();
});

it.each([1, 10, 11])(
  "excludes a post-entry arrival at timestamp %s while snapshot evidence is pending",
  async (createdAt) => {
    const h = boundaryFixture();
    const read = h.row({
      ...message(h.viewer, "c", "Own message at entry", 10),
      id: "0".repeat(64),
    });
    const mounted = render(h.tree("c", [read]));
    await h.completeEntry();

    const live = h.row({
      ...message(h.peer, "c", "Arrived during entry", createdAt),
      id: "f".repeat(64),
    });
    h.unreadIds.add(live.id);
    const rows = createdAt < 10 ? [live, read] : [read, live];
    mounted.rerender(h.tree("c", rows));
    h.completeReadStateSnapshot();
    h.publish();

    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();
    expect(h.unread.attention("c", live.id).unread).toBe(true);
    mounted.unmount();
  },
);

it("does not adopt later-loaded unread rows as entry membership", async () => {
  const h = boundaryFixture();
  const mounted = render(h.tree("c", []));
  const late = h.row(message(h.peer, "c", "First loaded after entry", 1));
  h.unreadIds.add(late.id);
  mounted.rerender(h.tree("c", [late]));
  await h.completeEntry();
  h.completeReadStateSnapshot();
  h.publish();

  expect(screen.queryByRole("separator", { name: "New messages" })).toBeNull();
  expect(h.unread.attention("c", late.id).unread).toBe(true);
  mounted.unmount();
});

it.each([
  { entryReady: false, unreadAtEntry: false },
  { entryReady: true, unreadAtEntry: false },
  { entryReady: false, unreadAtEntry: true },
  { entryReady: true, unreadAtEntry: true },
])(
  "uses entry unread rows after a pre-mount arrival: %j",
  async ({ entryReady, unreadAtEntry }) => {
    const h = boundaryFixture();
    const entry = h.row(
      message(unreadAtEntry ? h.peer : h.viewer, "c", "Message at entry", 10),
    );
    if (unreadAtEntry) {
      h.unreadIds.add(entry.id);
      h.completeReadStateSnapshot();
    }
    const mounted = render(h.tree("c", [entry], false, true, false));
    if (entryReady) await h.completeEntry();
    const revision = h.unread.revision();

    const live = h.row(message(h.peer, "c", "Arrived while loading", 1));
    h.unreadIds.add(live.id);
    mounted.rerender(h.tree("c", [live, entry]));
    if (!entryReady) await h.completeEntry();
    h.completeReadStateSnapshot();
    h.publish();

    expect(
      screen.getByText("Arrived while loading", { exact: true }),
    ).toBeTruthy();
    if (unreadAtEntry) {
      const boundary = screen.getByRole("separator", { name: "New messages" });
      expect(
        screen
          .getByText("Arrived while loading")
          .compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(
        boundary.compareDocumentPosition(screen.getByText("Message at entry")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    } else {
      expect(
        screen.queryByRole("separator", { name: "New messages" }),
      ).toBeNull();
    }
    expect(h.unread.attention("c", entry.id).unread).toBe(unreadAtEntry);
    expect(h.unread.attention("c", live.id).unread).toBe(true);
    expect(h.unread.revision()).toBe(revision);
    expect(h.enterChannel).toHaveBeenCalledTimes(1);
    mounted.unmount();
  },
);

it("retains loaded entry membership through a delayed first timeline mount", async () => {
  const h = boundaryFixture();
  const unread = h.row(message(h.peer, "c", "Unread at entry", 1));
  h.unreadIds.add(unread.id);
  const mounted = render(h.tree("c", [unread], false, true, false));
  await h.completeEntry();
  h.completeReadStateSnapshot();
  h.publish();
  mounted.rerender(h.tree("c", [unread]));

  expect(screen.getByRole("separator", { name: "New messages" })).toBeTruthy();
  expect(h.unread.attention("c", unread.id).unread).toBe(true);
  mounted.unmount();
});

it("omits a delayed first-mount boundary after entry read intent changes", async () => {
  const h = boundaryFixture();
  const unread = h.row(message(h.peer, "c", "Unread at entry", 1));
  h.unreadIds.add(unread.id);
  const mounted = render(h.tree("c", [unread], false, true, false));
  h.advanceReadRevision();
  await h.completeEntry();
  h.completeReadStateSnapshot();
  h.publish();
  mounted.rerender(h.tree("c", [unread]));

  expect(screen.queryByRole("separator", { name: "New messages" })).toBeNull();
  expect(h.unread.attention("c", unread.id).unread).toBe(true);
  mounted.unmount();
});

it("omits a delayed first-mount boundary after synchronized entry reading changes", async () => {
  const h = boundaryFixture();
  const first = h.row(message(h.peer, "c", "Unread at entry", 1));
  const later = h.row(message(h.peer, "c", "Still unread after sync", 2));
  h.unreadIds.add(first.id);
  h.unreadIds.add(later.id);
  h.completeReadStateSnapshot();
  const mounted = render(h.tree("c", [first, later], false, true, false));
  await h.completeEntry();

  const entryRevision = h.unread.revision();
  h.unreadIds.delete(first.id);
  h.notifyAttention();
  mounted.rerender(h.tree("c", [first, later]));

  expect(screen.queryByRole("separator", { name: "New messages" })).toBeNull();
  expect(h.unread.revision()).toBe(entryRevision);
  expect(h.unread.attention("c", later.id).unread).toBe(true);
  mounted.unmount();
});

it("omits the boundary if entry reconciliation changes read intent", async () => {
  const h = boundaryFixture();
  const unread = h.row(message(h.peer, "c", "Unread during entry", 1));
  h.unreadIds.add(unread.id);
  const mounted = render(h.tree("c", [unread]));
  h.advanceReadRevision();
  await h.completeEntry();
  h.completeReadStateSnapshot();
  h.publish();

  expect(screen.queryByRole("separator", { name: "New messages" })).toBeNull();
  expect(h.unread.attention("c", unread.id).unread).toBe(true);
  mounted.unmount();
});

it("omits the boundary and releases listeners when channel-entry reconciliation fails", async () => {
  const h = boundaryFixture();
  const unread = h.row(message(h.peer, "c", "Unread before failed entry", 1));
  h.unreadIds.add(unread.id);
  render(h.tree("c", [unread]));
  h.completeReadStateSnapshot();
  h.publish();
  expect(h.subscribers()).toEqual({ unread: 1, sync: 1 });

  await h.failEntry();

  expect(screen.getByRole("alert").textContent).toContain(
    "Could not restore unread state.",
  );
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  expect(h.subscribers()).toEqual({ unread: 0, sync: 0 });
});

it("keeps the first boundary stable through automatic reading and live messages", async () => {
  const h = boundaryFixture();
  const read = h.row(message(h.peer, "c", "Already read", 1));
  const firstUnread = h.row(message(h.peer, "c", "Previously unread", 2));
  h.unreadIds.add(firstUnread.id);
  const mounted = render(h.tree("c", [read, firstUnread]));
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  await h.completeEntry();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  h.completeReadStateSnapshot();
  const before = (content: string) => {
    const separator = screen.getByRole("separator", { name: "New messages" });
    const target = screen.getByText(content, { exact: true });
    return !!(
      separator.compareDocumentPosition(target) &
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  };
  expect(before("Previously unread")).toBe(true);

  h.unreadIds.delete(firstUnread.id);
  h.publish();
  const live = h.row(message(h.peer, "c", "Arrived during visit", 3));
  h.unreadIds.add(live.id);
  mounted.rerender(h.tree("c", [read, firstUnread, live]));
  expect(before("Previously unread")).toBe(true);
  expect(before("Arrived during visit")).toBe(true);

  const nextVisit = h.row(
    message(h.peer, "other", "Unread in another channel", 4),
    "other",
  );
  h.unreadIds.clear();
  h.unreadIds.add(nextVisit.id);
  h.publish("other");
  mounted.rerender(h.tree("other", [nextVisit]));
  await h.completeEntry();
  expect(before("Unread in another channel")).toBe(true);
  mounted.unmount();
});

it.each([true, false])(
  "retains a completed channel boundary through a temporary timeline unmount, unread at entry=%s",
  async (unreadAtEntry) => {
    const h = boundaryFixture();
    const first = h.row(message(h.peer, "c", "First entry message", 1));
    if (unreadAtEntry) h.unreadIds.add(first.id);
    const mounted = render(h.tree("c", [first]));
    await h.completeEntry();
    h.completeReadStateSnapshot();
    expect(!!screen.queryByRole("separator", { name: "New messages" })).toBe(
      unreadAtEntry,
    );

    mounted.rerender(h.tree("c", [first], false, true, false));
    expect(
      screen.queryByRole("region", { name: "Channel message history" }),
    ).toBeNull();
    h.unreadIds.delete(first.id);
    h.advanceReadRevision();
    const live = h.row(message(h.peer, "c", "Arrived during inline reveal", 2));
    h.unreadIds.add(live.id);
    h.publish();
    mounted.rerender(h.tree("c", [first, live]));

    expect(h.enterChannel).toHaveBeenCalledTimes(1);
    const boundary = screen.queryByRole("separator", { name: "New messages" });
    if (unreadAtEntry) {
      expect(boundary).not.toBeNull();
      expect(
        (boundary?.compareDocumentPosition(
          screen.getByText("First entry message"),
        ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    } else expect(boundary).toBeNull();
    mounted.unmount();
  },
);

it.each(["read intent", "backdated arrival"])(
  "retains the pending entry baseline through an inline-reveal unmount and %s",
  async (change) => {
    const h = boundaryFixture();
    const entry = h.row(message(h.peer, "c", "Present at entry", 2));
    if (change === "read intent") h.unreadIds.add(entry.id);
    const mounted = render(h.tree("c", [entry]));
    await h.completeEntry();
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();
    mounted.rerender(h.tree("c", [entry], false, true, false));

    const rows = [entry];
    if (change === "read intent") h.advanceReadRevision();
    else {
      const live = h.row(message(h.peer, "c", "Backdated after entry", 1));
      rows.unshift(live);
      h.unreadIds.add(live.id);
    }
    h.completeReadStateSnapshot();
    h.publish();
    mounted.rerender(h.tree("c", rows));

    expect(h.enterChannel).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();
    expect(rows.some((row) => h.unread.attention("c", row.id).unread)).toBe(
      true,
    );
    mounted.unmount();
  },
);

it.each([
  "entry",
  "before inline reveal",
  "before snapshot",
  "before first mount",
] as const)(
  "omits a pending boundary after synchronized reading changes attention captured at %s",
  async (timing) => {
    const h = boundaryFixture();
    const first = h.row(message(h.peer, "c", "Unread at entry", 1));
    const second = h.row(
      message(h.peer, "c", "Still unread after remote reading", 2),
    );
    h.unreadIds.add(first.id);
    h.unreadIds.add(second.id);
    if (timing === "entry") h.completeReadStateSnapshot();
    const revision = h.unread.revision();
    const mounted = render(
      h.tree(
        "c",
        [first, second],
        false,
        true,
        timing !== "before first mount",
      ),
    );
    if (timing !== "entry") await h.completeEntry();

    if (timing === "before inline reveal") {
      mounted.rerender(h.tree("c", [first, second], false, true, false));
      h.completeReadStateSnapshot();
      expect(
        screen.queryByRole("region", { name: "Channel message history" }),
      ).toBeNull();
    }

    h.unreadIds.delete(first.id);
    h.notifyAttention();
    h.publish();
    expect(h.unread.revision()).toBe(revision);
    expect(h.unread.attention("c", first.id).unread).toBe(false);
    if (timing === "before snapshot" || timing === "before first mount")
      h.completeReadStateSnapshot();
    if (timing === "entry") await h.completeEntry();
    mounted.rerender(h.tree("c", [first, second]));

    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();
    expect(h.unread.attention("c", second.id).unread).toBe(true);
    expect(h.enterChannel).toHaveBeenCalledTimes(1);
    mounted.unmount();
  },
);

it.each([
  ["unknown", "entry"],
  ["pending", "entry"],
  ["unknown", "snapshot"],
  ["pending", "snapshot"],
  ["unknown", "delayed mount"],
  ["pending", "delayed mount"],
] as const)(
  "does not adopt synchronized reading after %s attention at %s",
  async (attention, timing) => {
    const h = boundaryFixture();
    const first = h.row(message(h.peer, "c", "Unresolved at entry", 1));
    const later = h.row(message(h.peer, "c", "Still unread after sync", 2));
    h.unreadIds.add(first.id);
    h.unreadIds.add(later.id);
    const unresolved = attention === "unknown" ? h.unknownIds : h.pendingIds;
    unresolved.add(first.id);
    if (timing !== "snapshot") h.completeReadStateSnapshot();
    const revision = h.unread.revision();
    const mounted = render(
      h.tree("c", [first, later], false, true, timing !== "delayed mount"),
    );
    await h.completeEntry();
    if (timing === "snapshot") h.completeReadStateSnapshot();
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();

    // A remote read arrives before the reply's root/classification lookup ends.
    h.unreadIds.delete(first.id);
    h.notifyAttention();
    unresolved.delete(first.id);
    h.notifyAttention();
    mounted.rerender(h.tree("c", [first, later]));
    h.publish();

    expect(h.unread.revision()).toBe(revision);
    expect(h.unread.attention("c", first.id).unread).toBe(false);
    expect(h.unread.attention("c", later.id).unread).toBe(true);
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();
    mounted.unmount();
  },
);

it.each([false, true])(
  "captures a new boundary only while active, initially active=%s",
  async (initiallyActive) => {
    const h = boundaryFixture();
    const first = h.row(message(h.peer, "c", "Earlier unread message", 1));
    const next = h.row(message(h.peer, "c", "Next visit unread message", 2));
    h.unreadIds.add(first.id);
    const mounted = render(h.tree("c", [first, next], false, initiallyActive));
    if (!initiallyActive) {
      expect(h.subscribers()).toEqual({ unread: 0, sync: 0 });
      mounted.rerender(h.tree("c", [first, next]));
    }
    expect(h.subscribers()).toEqual({ unread: 1, sync: 1 });
    await h.completeEntry();
    h.completeReadStateSnapshot();
    h.publish();
    expect(h.subscribers()).toEqual({ unread: 0, sync: 0 });
    expect(
      screen
        .getByText("New messages", { exact: true })
        .compareDocumentPosition(
          screen.getByText("Earlier unread message", { exact: true }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    h.unreadIds.delete(first.id);
    h.unreadIds.add(next.id);
    mounted.rerender(h.tree("c", [first, next], false, false));
    expect(h.subscribers()).toEqual({ unread: 0, sync: 0 });
    expect(screen.queryByText("New messages", { exact: true })).toBeNull();

    mounted.rerender(h.tree("c", [first, next]));
    expect(h.subscribers()).toEqual({ unread: 1, sync: 1 });
    await h.completeEntry();
    h.publish();
    expect(h.subscribers()).toEqual({ unread: 0, sync: 0 });
    const separator = screen.getByText("New messages", { exact: true });
    expect(
      separator.compareDocumentPosition(
        screen.getByText("Next visit unread message", { exact: true }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(h.enterChannel).toHaveBeenCalledTimes(2);
    mounted.unmount();
    expect(h.subscribers()).toEqual({ unread: 0, sync: 0 });
  },
);

it("does not move a completed no-boundary visit when unrelated unread arrives", async () => {
  const h = boundaryFixture();
  const read = h.row(message(h.peer, "c", "Already read", 1));
  const joined = h.row(message(h.peer, "c", "Membership activity", 2), "c", {
    membership: {
      type: "member_joined",
      actor: h.peer.pubkey,
      target: h.peer.pubkey,
    },
  });
  const mounted = render(h.tree("c", [read, joined]));
  await h.completeEntry();
  h.completeReadStateSnapshot();
  h.publish();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();

  const live = h.row(message(h.peer, "c", "Arrived during visit", 3));
  h.unreadIds.add(live.id);
  mounted.rerender(h.tree("c", [read, joined, live]));
  h.publish();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  mounted.unmount();
});

it("finalizes an excluded unread row before a live eligible message arrives", async () => {
  const h = boundaryFixture();
  const agent = h.row(message(h.peer, "c", "Agent coordination", 1), "c", {
    audience: "agents",
  });
  h.unreadIds.add(agent.id);
  const mounted = render(h.tree("c", [agent]));
  await h.completeEntry();
  h.completeReadStateSnapshot();
  h.publish();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();

  const live = h.row(message(h.peer, "c", "Arrived during visit", 2));
  h.unreadIds.add(live.id);
  mounted.rerender(h.tree("c", [agent, live]));
  h.publish();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();
  mounted.unmount();
});

it("does not let an earlier entry completion ready a replacement visit", async () => {
  const h = boundaryFixture();
  const unread = h.row(message(h.peer, "c", "Unread after re-entry", 1));
  h.unreadIds.add(unread.id);
  const mounted = render(h.tree("c", [unread]));
  await h.completeReadStateSnapshot();
  h.publish();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();

  mounted.rerender(h.tree("c", [unread], false, false));
  mounted.rerender(h.tree("c", [unread]));
  expect(h.enterChannel).toHaveBeenCalledTimes(2);
  await h.completeEntry();
  expect(screen.queryByText("New messages", { exact: true })).toBeNull();

  await h.completeEntry();
  expect(screen.getByText("New messages", { exact: true })).toBeTruthy();
  mounted.unmount();
});
it.each([false, true])(
  "preserves a restored row when the boundary appears and disappears, initially settled=%s",
  async (initiallySettled) => {
    const h = boundaryFixture();
    const read = h.row(message(h.peer, "c", "Earlier read message", 1));
    const unread = h.row(message(h.peer, "c", "Restored unread message", 2));
    h.unreadIds.add(unread.id);
    writeView("scope", "scroll:c", {
      offset: 900,
      bottom: false,
      anchor: { id: unread.id, y: 100 },
    });
    const mounted = render(h.tree("c", [read, unread]));
    const scroller = screen.getByRole("region", {
      name: "Channel message history",
    });
    // This models the hold/settled permutations; new-message-boundary.spec.mjs
    // covers saved-offset geometry with the real virtualizer.
    scroll.itemOffset.mockReturnValue(100);
    scroll.toIndex.mockImplementation((_index, { offset = 0 }) => {
      scroller.scrollTop = 100 + offset;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this === scroller) return new DOMRect(0, 0, 800, 600);
        if (this.tagName === "LI")
          return new DOMRect(0, 100 - scroller.scrollTop, 800, 80);
        if (this.dataset.messageId === unread.id) {
          const boundary = document.querySelector(
            "[data-new-messages-boundary]",
          );
          return new DOMRect(
            0,
            100 + (boundary ? 32 : 0) - scroller.scrollTop,
            800,
            80,
          );
        }
        return new DOMRect(0, 0, 800, 80);
      },
    );
    if (initiallySettled) await frame();

    await h.completeEntry();
    h.completeReadStateSnapshot();
    h.publish();
    expect(screen.getByText("New messages", { exact: true })).toBeTruthy();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, {
      align: "start",
      offset: -68,
    });
    expect(scroller.scrollTop).toBe(32);

    mounted.rerender(h.tree("c", [read, unread], false, false));
    expect(screen.queryByText("New messages", { exact: true })).toBeNull();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, {
      align: "start",
      offset: -100,
    });
    expect(scroller.scrollTop).toBe(0);
    mounted.unmount();
  },
);
it.each([
  { offset: 0, gap: 1400 },
  { offset: 400, gap: 1000 },
  { offset: 400, gap: 40 },
])(
  "refreshes measured geometry without changing reading intent at offset $offset / gap $gap",
  async ({ offset, gap }) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    let rowY = 120;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
      },
    );
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
    region.scrollTop = offset;
    fireEvent.scroll(region);
    fireEvent(region, new Event("scrollend"));

    // Virtua's measured offsets commit without another scroll event.
    rowY += 238;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      offset + region.clientHeight + gap,
    );
    act(() => scroll.resized());
    h.append();
    await h.measured();
    expect(region.scrollTop).toBe(offset);

    // Measurements during an active hold must still preserve its original Y.
    rowY += 90;
    act(() => scroll.resized());
    await act(async () => {
      screen.getByRole("list").style.height = "2210px";
    });
    expect(region.scrollTop).toBe(offset + 90);
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({
      bottom: false,
      anchor: { y: 358 },
    });
  },
);
it("preserves a held reader's logical offset while its DOM lookup is absent", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let rowY = 120;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
  region.scrollTop = 400;
  fireEvent.scroll(region);
  fireEvent(region, new Event("scrollend"));
  scroll.itemOffset.mockImplementation((index) => index * 100);
  h.pageAroundAnchor();
  await h.measured();
  // A drag after the hold starts must become the new logical baseline.
  region.scrollTop -= 50;
  rowY += 50;
  fireEvent.scroll(region);

  // Model Virtua evicting the lookup, while React still owns the test DOM.
  const row = region.querySelector<HTMLElement>(
    `[data-message-id="${h.saved.anchor.id}"]`,
  );
  expect(row).not.toBeNull();
  row?.removeAttribute("data-message-id");
  scroll.itemOffset.mockImplementation((index) => index * 100 + 45.5);
  region.scrollTop = 423; // Virtua has already applied part of the batch.
  await act(async () => {
    screen.getByRole("list").style.height = "2210px";
  });
  expect(region.scrollTop).toBe(495.5);

  // Another virtualized batch must not undo the drag or double-count a jump.
  scroll.itemOffset.mockImplementation((index) => index * 100 + 135.5);
  region.scrollTop += 10;
  await act(async () => {
    screen.getByRole("list").style.height = "2300px";
  });
  expect(region.scrollTop).toBe(585.5);
});

it("keeps a held reader when measured row offsets change without total height", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let rowY = 120;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
  region.scrollTop = 400;
  fireEvent.scroll(region);
  fireEvent.pointerDown(region);
  h.append();
  await h.measured();
  const list = screen.getByRole("list");
  const height = list.style.height;
  // Virtua can toggle pointer-events before this gesture's scroll reader runs.
  // That list-only change must not pull the drag back to its previous anchor.
  region.scrollTop -= 50;
  rowY += 50;
  await act(async () => {
    list.style.pointerEvents = "none";
  });
  expect(region.scrollTop).toBe(350);
  fireEvent.scroll(region);
  // Equal and opposite row resizes leave the total unchanged, while Virtua's
  // partial compensation moves the held paragraph up by 113px.
  region.scrollTop += 113;
  rowY -= 113;
  await act(async () => {
    (list.firstElementChild as HTMLElement).style.top = "113px";
  });
  expect(list.style.height).toBe(height);
  expect(region.scrollTop).toBe(350);
});

it("keeps fractional correction residue from accumulating during a held drag", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let offset = 0;
  let rowTop = 1520;
  // WebKit quantizes scrollTop even when measured row offsets are fractional.
  Object.defineProperty(region, "scrollTop", {
    configurable: true,
    get: () => offset,
    set: (value: number) => {
      offset = Math.trunc(value);
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, this.closest("ol") ? rowTop - offset : 0, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
  rowTop = 520;
  region.scrollTop = 400;
  fireEvent.scroll(region);
  fireEvent.pointerDown(region);
  h.append();
  await h.measured();
  let expectedY = 120;
  for (let step = 0; step < 8; step++) {
    rowTop += 1.75;
    await act(async () => {
      (screen.getByRole("list").firstElementChild as HTMLElement).style.top =
        `${step + 1}px`;
    });
    // The automatic correction emits a scroll event; it is not a new user position.
    fireEvent.scroll(region);
    expect(Math.abs(rowTop - offset - expectedY)).toBeLessThan(1);
    if (step === 3) {
      region.scrollTop -= 150;
      expectedY += 150;
      fireEvent.scroll(region);
    }
  }
  fireEvent.pointerUp(region);
});

it("retargets a held reader when its former row is below the viewport", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let formerY = 120;
  let olderY = -200;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const row = this.closest<HTMLElement>("[data-message-id]");
      const y = row?.dataset.messageId === "older" ? olderY : row ? formerY : 0;
      return new DOMRect(0, y, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
  region.scrollTop = 400;
  fireEvent.scroll(region);
  fireEvent.pointerDown(region);
  h.pageAroundAnchor();
  await h.measured();

  // Scrolling away selects the newly visible older row. The former reader's
  // DOM can return below the viewport without reclaiming the active hold.
  formerY = 900;
  olderY = 100;
  region.scrollTop = 0;
  fireEvent.scroll(region);
  formerY += 300;
  await act(async () => {
    screen.getByRole("list").style.height = "2420px";
  });
  expect(region.scrollTop).toBe(0);
});

it("retains the saved anchor correction when cached rows are promoted before its frame", async () => {
  const h = mount();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
  scroll.toIndex.mockClear();
  await h.measured();
  h.promote();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
});
it("reader input cancels the queued correction even when cached rows are then promoted", async () => {
  const h = mount();
  await frame();
  scroll.toIndex.mockClear();
  await h.measured();
  fireEvent.wheel(
    screen.getByRole("region", { name: "Channel message history" }),
  );
  h.promote();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "local reveal retires restoration without canceling existing bottom follow=%s",
  async (bottom) => {
    const h = mount(bottom);
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    const calls = scroll.toIndex.mock.calls.length;
    await h.measured();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    expect(scroll.toIndex.mock.calls.length).toBe(calls + 1);
  },
);

it.each(["none", "wheel", "key"])(
  "a reveal on mount follows late measurements unless reader input=%s",
  async (input) => {
    const h = mount(false, true);
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    scroll.toIndex.mockClear();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (input === "wheel") fireEvent.wheel(feed);
    if (input === "key") fireEvent.keyDown(feed, { key: "PageUp" });
    await h.measured();
    await frame();
    if (input === "none") {
      expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
      h.unmount();
      expect(readView("scope", "scroll:c", null)).toMatchObject({
        bottom: true,
      });
    } else expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it.each(["wheel", "key"])(
  "reader input before the reveal frame stays authoritative after a row refresh or prepend: %s",
  async (input) => {
    const h = mount();
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (input === "wheel") fireEvent.wheel(feed);
    else fireEvent.keyDown(feed, { key: "PageUp" });
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    // A later echo/edit replaces rows; it must not revive the canceled reveal.
    h.refreshSent();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    // Nor may an older-history page, which reruns the effect as a prepend.
    h.prependOlder();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "an older-history prepend before the reveal frame still reveals the sent row, read up first=%s",
  async (readUp) => {
    const h = mount(true);
    await frame();
    await frame();
    if (readUp) {
      fireEvent.wheel(
        screen.getByRole("region", { name: "Channel message history" }),
      );
      await frame();
    }
    scroll.toIndex.mockClear();
    h.reveal();
    // The prepend cancels the reveal frame before it runs; the rerun must
    // reschedule the reveal at the sent row's new index, not lose it.
    h.prependOlder();
    await frame();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(2, { align: "end" });
    expect(scroll.toIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  },
);

it.each([false, true])(
  "a completed reveal is not rescheduled by a later older-history prepend, bottom=%s",
  async (bottom) => {
    const h = mount(bottom);
    await frame();
    h.reveal();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    scroll.toIndex.mockClear();
    // The reveal is recorded only once its scroll runs. A page landing after
    // that must find it complete, not reschedule it at the sent row's new index.
    h.prependOlder();
    await frame();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it("waits for a sent row to arrive without restoring over its reveal", async () => {
  const h = mount();
  await frame();
  h.awaitReveal();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  h.reveal();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  scroll.toIndex.mockClear();
  h.reveal();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "the first intermediate bottom-follow scroll retains intent unless reader input=%s",
  async (readerInput) => {
    const h = mount(true);
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // Virtua can deliver an intermediate offset before measuring its final range.
    feed.scrollTop = 162;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    scroll.toIndex.mockClear();
    await h.measured();
    await frame();
    if (readerInput) expect(scroll.toIndex).not.toHaveBeenCalled();
    else expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  },
);

it("a resize before the local reveal scroll event cannot revive the prior reading anchor", async () => {
  const h = mount();
  await frame();
  h.reveal();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  scroll.toIndex.mockClear();
  // Composer/sidebar layout may resize before the browser delivers scroll.
  await act(async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    for (const resize of resizes) resize();
  });
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  expect(scroll.toIndex).not.toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
});

it.each([false, true])(
  "a scroll before any visible virtual row mounts retains restoration unless reader input=%s",
  async (readerInput) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // The virtualizer has accepted the offset, but its mounted range is still
    // offscreen. No paragraph or row is available to replace the saved anchor.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? -200 : 0, 800, 100);
      },
    );
    feed.scrollTop = 900;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(
      readerInput ? { bottom: false } : h.saved,
    );
  },
);

it.each([false, true])(
  "does not turn cold clamps into reader follow intent, repeated=%s",
  async (repeat) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // Cold estimated row heights can clamp the restoring viewport to the bottom.
    // The saved row is mounted, so this is not the anchorless-range case above.
    let rowY = 84;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
      },
    );
    feed.scrollTop = 1400;
    fireEvent.scroll(feed);
    if (repeat) {
      feed.scrollTop = 1200;
      rowY = 284;
      fireEvent.scroll(feed);
      feed.scrollTop = 1400;
      rowY = 84;
      fireEvent.scroll(feed);
    }
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -42,
    });
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(h.saved);
  },
);

it.each(["converged", "gesture", "removed"])(
  "allows bottom follow after restoration is superseded: %s",
  async (boundary) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? 42 : 0, 800, 100);
      },
    );
    if (boundary === "converged") {
      feed.scrollTop = 900;
      fireEvent.scroll(feed);
    } else if (boundary === "gesture") {
      fireEvent.pointerDown(feed);
    } else {
      h.replaceAnchor();
      await frame();
    }
    feed.scrollTop = 1400;
    fireEvent.scroll(feed);
    h.unmount();
    expect(
      readView<{ bottom: boolean }>("scope", "scroll:c", { bottom: false })
        .bottom,
    ).toBe(true);
  },
);

// Intent and native/virtualizer shrink can arrive in one scroll observation.
it.each([
  "wheel",
  "touch",
  "keyboard",
  "link",
  "button",
  "command up",
  "option up",
  "control up",
  "control home",
  "nested top",
  "contained top",
  "no overscroll",
] as const)(
  "%s reader input wins over shrink in the same observation",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    if (input === "wheel") fireEvent.wheel(region, { deltaY: -200 });
    if (input === "keyboard") fireEvent.keyDown(region, { key: "PageUp" });
    if (
      [
        "link",
        "button",
        "command up",
        "option up",
        "control up",
        "control home",
        "nested top",
        "contained top",
        "no overscroll",
      ].includes(input)
    ) {
      const control = document.createElement(
        input === "button" ? "button" : "a",
      );
      if (control instanceof HTMLAnchorElement)
        control.href = "https://example.com";
      control.textContent = "Message control";
      region.append(control);
      if (["nested top", "contained top", "no overscroll"].includes(input)) {
        const inner = document.createElement("div");
        inner.style.overflowY = "auto";
        inner.style.overscrollBehaviorY =
          input === "contained top"
            ? "contain"
            : input === "no overscroll"
              ? "none"
              : "auto";
        region.append(inner);
        inner.append(control);
        inner.scrollTop = 0;
      }
      control.focus();
      fireEvent.keyDown(control, {
        key: input.endsWith("up")
          ? "ArrowUp"
          : input === "control home"
            ? "Home"
            : "PageUp",
        metaKey: input === "command up",
        altKey: input === "option up",
        ctrlKey: input.startsWith("control"),
      });
    }
    if (input === "touch") {
      fireEvent.touchStart(region, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(region, { touches: [{ clientY: 300 }] });
    }
    // No intermediate stable-height scroll: native clamp, virtualizer correction
    // and the reader's movement are first seen together.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 400;
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    await h.measured();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({
      bottom: false,
    });
  },
);
it.each(["keyboard", "wheel", "scrollbar"])(
  "%s movement survives a frame and shrink during the same gesture",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    if (input === "keyboard") fireEvent.keyDown(region, { key: "PageUp" });
    if (input === "wheel") fireEvent.wheel(region, { deltaY: -300 });
    if (input === "scrollbar") fireEvent.pointerDown(region);
    // The first event has not yet crossed the near-bottom threshold. A native
    // smooth scroll / drag continues after this rendering opportunity.
    region.scrollTop -= 40;
    fireEvent.scroll(region);
    await frame();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1920,
    );
    region.scrollTop -= 340; // 80px shrink plus 260px continued reader movement.
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    await h.measured();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({
      bottom: false,
    });
  },
);

it.each(["auto", "contain", "none"])(
  "retires an unconsumed %s inner-top PageUp before a later layout-only shrink",
  async (containment) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    inner.style.overscrollBehaviorY = containment;
    const control = document.createElement("a");
    control.href = "https://example.com";
    inner.append(control);
    region.append(inner);
    control.focus();
    fireEvent.keyDown(control, { key: "PageUp" });
    // WebKit can consume this key without moving either scrollport. No scroll or
    // scrollend follows; let that rendering opportunity pass before later reflow.
    await frame();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 800;
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    expect(scroll.toIndex).toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
  },
);

it("a finished near-bottom wheel does not taint a later layout-only shrink", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.wheel(region, { deltaY: -1 });
  region.scrollTop -= 1;
  fireEvent.scroll(region);
  fireEvent(region, new Event("scrollend"));
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1600);
  region.scrollTop = 600;
  fireEvent.scroll(region);
  h.promote();
  await frame();
  h.unmount();
  expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
});

it.each([
  "editable",
  "nested scroll",
  "prevented",
  "button activation",
  "modified page up",
] as const)(
  "%s keyboard input does not claim history scrolling during shrink",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    const control = document.createElement(
      input === "editable" ? "textarea" : "button",
    );
    region.append(control);
    if (input === "nested scroll") {
      const inner = document.createElement("div");
      inner.style.overflowY = "auto";
      region.append(inner);
      inner.append(control);
      inner.scrollTop = 100;
    }
    if (input === "prevented")
      control.addEventListener("keydown", (event) => event.preventDefault());
    control.focus();
    fireEvent.keyDown(control, {
      key: input === "button activation" ? " " : "PageUp",
      shiftKey: input === "button activation",
      altKey: input === "modified page up",
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 400;
    fireEvent.scroll(region);
    h.promote();
    await frame();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
  },
);

it("reads through the last message when a Huddle card is newest, with no plugin renderer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 500),
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 800, 500),
  ] as unknown as DOMRectList);
  const owner = createRelaySession(null);
  owners.push(owner);
  const catchUp = vi.fn(async () => {}),
    observe = vi.fn(async () => {});
  const sync = {
    ...owner.session.unread.sync(),
    capability: "frontier-sync" as const,
  };
  const session = {
    ...owner.session,
    unread: {
      ...owner.session.unread,
      sync: () => sync,
      reading: () => ({ view: () => {}, dispose: () => {}, observe, catchUp }),
    },
  };
  const base = {
    channelId: "c",
    authorId: "a".repeat(64),
    content: "Message",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  try {
    render(
      <ChannelTimeline
        channelId="c"
        scope="read-huddle"
        queries={session}
        window={{
          channelId: "c",
          status: "ready",
          freshness: "verified",
          error: undefined,
          hasMore: false,
          loadingOlder: false,
          rows: [
            { ...base, id: "message" },
            {
              ...base,
              id: "card",
              content: "",
              createdAt: 2,
              huddle: { room: "room", state: "started" },
            },
          ],
        }}
        onOpenLink={() => false}
      />,
    );
    await frame();
    await frame();
    const history = screen.getByRole("region", {
      name: "Channel message history",
    });
    await act(async () => {
      history.focus();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(catchUp).toHaveBeenCalledWith("message", undefined);
    expect(observe).toHaveBeenCalledWith(["message"]);
    expect(
      history
        .querySelector('[data-message-id="card"]')
        ?.hasAttribute("data-huddle-row"),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("scroll completion saves row geometry measured after the last scroll event", async () => {
  const h = mount();
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let rowY = 42;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
    },
  );
  fireEvent.wheel(region, { deltaY: -900 });
  region.scrollTop = 0;
  fireEvent.scroll(region);
  // Virtual rows finish measuring at the top without changing scrollTop again.
  rowY = 142;
  fireEvent(region, new Event("scrollend"));
  h.unmount();
  expect(readView("scope", "scroll:c", null)).toEqual({
    bottom: false,
    anchor: { id: h.saved.anchor.id, y: 142 },
  });
});

it("catching up saves the bottom once scrolling settles, so a reload opens at the latest message", async () => {
  const h = mount();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  fireEvent.wheel(region, { deltaY: 600 });
  for (const top of [700, 1100, 1400]) {
    region.scrollTop = top;
    fireEvent.scroll(region);
  }
  // Scroll events update the place in memory only.
  expect(readView("scope", "scroll:c", null)).toEqual(h.saved);
  fireEvent(region, new Event("scrollend"));
  expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
  h.reload();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  expect(scroll.toIndex).not.toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
});

it.each(["scrollend", "pagehide"])(
  "a reload reopens the message a reader stopped at, at the same y, saved on %s",
  async (save) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? 120 : 0, 800, 100);
      },
    );
    fireEvent.wheel(region, { deltaY: -400 });
    region.scrollTop = 400;
    fireEvent.scroll(region);
    if (save === "scrollend") fireEvent(region, new Event("scrollend"));
    else fireEvent(window, new Event("pagehide"));
    h.reload();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -120,
    });
  },
);

it("a saved row missing from the first rows stays pending: the reader follows, scrollend keeps the place, and its arrival restores it", async () => {
  const h = mount(false, false, false);
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  expect(scroll.toOffset).not.toHaveBeenCalled();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  // The timeline's own scroll to the end settles; the saved place survives it.
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent(region, new Event("scrollend"));
  expect(readView("scope", "scroll:c", null)).toEqual(h.saved);
  scroll.toIndex.mockClear();
  h.loadAnchor();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, {
    align: "start",
    offset: -42,
  });
});

/** A focused reader reopening at a saved row the first rows do not hold yet. */
async function pendingReader() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 500),
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 800, 500),
  ] as unknown as DOMRectList);
  const owner = createRelaySession(null);
  owners.push(owner);
  const catchUp = vi.fn(async () => {}),
    observe = vi.fn(async () => {});
  const sync = {
    ...owner.session.unread.sync(),
    capability: "frontier-sync" as const,
  };
  const session = {
    ...owner.session,
    unread: {
      ...owner.session.unread,
      sync: () => sync,
      reading: () => ({ view: () => {}, dispose: () => {}, observe, catchUp }),
    },
  };
  const base = {
    channelId: "c",
    authorId: "a".repeat(64),
    content: "Message",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const tree = (rows: ChannelWindow["rows"]) => (
    <ChannelTimeline
      channelId="c"
      scope="read-restore"
      queries={session}
      window={{
        channelId: "c",
        status: "ready",
        freshness: "cached",
        error: undefined,
        hasMore: false,
        loadingOlder: false,
        rows,
      }}
      onOpenLink={() => false}
    />
  );
  writeView("read-restore", "scroll:c", {
    bottom: false,
    anchor: { id: "saved", y: 42 },
  });
  const latest = { ...base, id: "latest" };
  const view = render(tree([latest]));
  await frame();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  const history = screen.getByRole("region", {
    name: "Channel message history",
  });
  await act(async () => {
    history.focus();
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  return {
    history,
    catchUp,
    observe,
    load() {
      view.rerender(tree([{ ...base, id: "saved", createdAt: 0 }, latest]));
    },
  };
}

it("following the latest message while a saved row loads reads the rows shown, but does not catch up past the saved row", async () => {
  try {
    const h = await pendingReader();
    expect(h.observe).toHaveBeenCalledWith(["latest"]);
    expect(h.catchUp).not.toHaveBeenCalled();
    scroll.toIndex.mockClear();
    h.load();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -42,
    });
    expect(h.catchUp).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("reader input retires a loading saved row, so a dwell at the latest message catches up", async () => {
  try {
    const h = await pendingReader();
    expect(h.catchUp).not.toHaveBeenCalled();
    fireEvent.keyDown(h.history, { key: "ArrowDown" });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(h.catchUp).toHaveBeenCalledWith("latest", undefined);
  } finally {
    vi.useRealTimers();
  }
});

it("a wheel at the bottom that cannot scroll still retires a loading saved row, so the next dwell catches up", async () => {
  try {
    const h = await pendingReader();
    expect(h.catchUp).not.toHaveBeenCalled();
    // The reader is already at the end: the wheel moves nothing and emits no
    // scroll event, so only the retired restore can wake the dwell.
    fireEvent.wheel(h.history, { deltaY: 100 });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(h.catchUp).toHaveBeenCalledWith("latest", undefined);
  } finally {
    vi.useRealTimers();
  }
});

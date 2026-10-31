// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayEvent } from "../../features/relay/events";
import { createOutbox, type OutgoingEvent } from "../../features/relay/outbox";
import { keypair, signed } from "../../features/relay/testing";
import { ConversationTab } from "./ConversationTab";
import type { ConversationTab as Tab } from "./useChannelTabState";

// Exercise the real tab recovery owner and durable outbox without mounting the
// independent timelines/composers. Recovery must work with no editor mounted.
vi.mock("../../features/messages/ThreadPanel", () => ({
  ThreadPanel: ({
    active,
    replyRequest,
    focusRequest,
    revealSelected,
    revealRequest,
  }: {
    active: boolean;
    replyRequest?: number;
    focusRequest?: number;
    revealSelected?: boolean;
    revealRequest?: number;
  }) => (
    <aside
      data-active={active}
      data-reply-request={replyRequest}
      data-focus-request={focusRequest}
      data-reveal-selected={revealSelected}
      data-reveal-request={revealRequest}
    >
      Thread content
    </aside>
  ),
}));
const threadOpeners = vi.hoisted(
  () => [] as ((id: string, root: string, intent?: "reply") => void)[],
);
vi.mock("./ChannelBody", () => ({
  ChannelBody: ({
    activityLane,
    holding,
    inlineTarget,
    marksRead,
    onOpenThread,
  }: {
    activityLane?: boolean;
    holding?: boolean;
    inlineTarget?: { messageId: string };
    marksRead?: boolean;
    onOpenThread(id: string, root: string, intent?: "reply"): void;
  }) => {
    threadOpeners.push(onOpenThread);
    return (
      <div
        data-activity-lane={activityLane}
        data-holding={holding}
        data-target={inlineTarget?.messageId}
        data-marks-read={marksRead}
      >
        Conversation content
      </div>
    );
  },
}));
vi.mock("../../features/messages/MessageComposer", () => ({
  MessageComposer: ({
    focusRequest,
    shown,
  }: {
    focusRequest?: number;
    shown?: boolean;
  }) => (
    <div data-focus-request={focusRequest} data-shown={shown}>
      Composer content
    </div>
  ),
}));
const unreadEvidence = {
  revision: () => 0,
  sync: () => ({ capability: "unsupported" }),
};
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

it.each(["thread", "conversation"] as const)(
  "%s tabs recover failed edits outside the editor and only for their channel",
  async (kind) => {
    const viewer = keypair();
    const edit = (channel: string, content: string) =>
      signed(viewer, {
        kind: 40003,
        created_at: 1700000001,
        content,
        tags: [
          ["h", channel],
          ["e", "a".repeat(64)],
        ],
      });
    const retry = edit("beta", "Retry this correction");
    const discard = edit("beta", "Discard this correction");
    const unrelated = edit("alpha", "Other channel correction");
    let stored: readonly OutgoingEvent[] = [retry, discard, unrelated].map(
      (event) => ({
        event,
        signed: event,
        delivery: "failed",
        error: "Edit refused",
      }),
    );
    const publish = vi.fn(async (_event: RelayEvent) => {});
    const owner = createOutbox(
      viewer.pubkey,
      { kinds: [40003], sign: async (event) => signed(viewer, event), publish },
      {
        load: async () => stored,
        save: (next) => {
          stored = next;
        },
      },
    );
    owners.push(owner);
    await owner.outbox.ready();
    const channels = {
      status: "ready",
      channels: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
    };
    // Only management consumes this session; independent child views above are
    // stubbed. These writable tabs have static eligibility/profile evidence.
    const session = {
      unread: unreadEvidence,
      outbox: owner.outbox,
      channels: {
        window: () => ({ rows: [] }),
        list: () => channels,
        subscribeList: () => () => {},
      },
      profiles: { subscribe: () => () => {} },
      messages: { canRetry: () => true },
    } as unknown as RelaySession;
    render(
      <ConversationTab
        active
        tab={{
          id: "beta-tab",
          kind,
          channelId: "beta",
          messageId: "a".repeat(64),
        }}
        channel={{ id: "beta", name: "Beta" }}
        session={session}
        scope="recovery-test"
        openLink={() => false}
        canOpenLink={() => false}
        openThread={() => {}}
        close={() => {}}
      />,
    );
    const notices = screen.getAllByRole("status");
    expect(notices).toHaveLength(2);
    expect(screen.queryByText(unrelated.content)).not.toBeInTheDocument();
    const retryNotice = notices.find((notice) =>
      notice.textContent?.includes(retry.content),
    );
    assert.exists(retryNotice);
    fireEvent.click(
      within(retryNotice).getByRole("button", { name: "Retry message update" }),
    );
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0]).toEqual(retry);
    await waitFor(() =>
      expect(screen.queryByText(retry.content)).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Discard failed update" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(stored.map((item) => [item.event.id, item.delivery])).toEqual([
        [retry.id, "accepted"],
        [unrelated.id, "failed"],
      ]),
    );
    expect(publish).toHaveBeenCalledTimes(1);
  },
);

it.each(["thread", "conversation"] as const)(
  "%s tabs hold an unread visit only while active and retain their content",
  (kind) => {
    const channel = { id: "beta", name: "Beta", members: ["viewer"] };
    const snapshot = { status: "ready", channels: [channel] };
    const enterChannel = vi.fn(async () => {});
    const leaveChannel = vi.fn();
    const session = {
      viewer: "viewer",
      channels: {
        window: () => ({ rows: [] }),
        list: () => snapshot,
        subscribeList: () => () => {},
      },
      profiles: {},
      unread: { ...unreadEvidence, enterChannel, leaveChannel },
    } as unknown as RelaySession;
    const props = {
      tab: {
        id: "beta-tab",
        kind,
        channelId: "beta",
        messageId: "a".repeat(64),
      },
      channel,
      session,
      scope: "visit-test",
      openLink: () => false,
      canOpenLink: () => false,
      openThread: () => {},
      close: () => {},
    };
    const mounted = render(<ConversationTab {...props} active={false} />);
    const content = screen.getByLabelText("Conversation in Beta");
    expect(enterChannel).not.toHaveBeenCalled();
    if (kind === "thread")
      expect(screen.getByText("Thread content")).toHaveAttribute(
        "data-active",
        "false",
      );
    mounted.rerender(<ConversationTab {...props} active />);
    expect(enterChannel).toHaveBeenCalledExactlyOnceWith("beta");
    if (kind === "thread")
      expect(screen.getByText("Thread content")).toHaveAttribute(
        "data-active",
        "true",
      );
    mounted.rerender(<ConversationTab {...props} active={false} />);
    expect(leaveChannel).toHaveBeenCalledExactlyOnceWith("beta");
    expect(screen.getByLabelText("Conversation in Beta")).toBe(content);
    mounted.rerender(<ConversationTab {...props} active />);
    expect(enterChannel).toHaveBeenCalledTimes(2);
    mounted.unmount();
    expect(leaveChannel).toHaveBeenCalledTimes(2);
  },
);

it.each(["thread", "conversation"] as const)(
  "%s tabs that only reveal never visit their channel",
  (kind) => {
    const channel = { id: "beta", name: "Beta", members: ["viewer"] };
    const snapshot = { status: "ready", channels: [channel] };
    const enterChannel = vi.fn(async () => {});
    const session = {
      viewer: "viewer",
      channels: {
        window: () => ({ rows: [] }),
        list: () => snapshot,
        subscribeList: () => () => {},
      },
      profiles: {},
      unread: { ...unreadEvidence, enterChannel, leaveChannel: vi.fn() },
    } as unknown as RelaySession;
    render(
      <ConversationTab
        tab={{
          id: "beta-tab",
          kind,
          channelId: "beta",
          messageId: "a".repeat(64),
          // A conversation tab seeks no message here; its reader is not mocked.
          revealRequest: kind === "thread" ? 1 : undefined,
        }}
        channel={channel}
        session={session}
        scope="reveal-test"
        openLink={() => false}
        canOpenLink={() => false}
        openThread={() => {}}
        close={() => {}}
        active
        visit={false}
      />,
    );
    expect(screen.getByLabelText("Conversation in Beta")).toBeVisible();
    expect(enterChannel).not.toHaveBeenCalled();
    if (kind === "thread")
      expect(screen.getByText("Thread content")).toHaveAttribute(
        "data-reveal-selected",
        "true",
      );
  },
);

it.each([false, true])(
  "restored Reply intent is not replayed but fresh requests are delivered (focusOnMount=%s)",
  (focusOnMount) => {
    const channel = { id: "beta", name: "Beta" };
    const snapshot = { status: "ready", channels: [channel] };
    const session = {
      unread: unreadEvidence,
      channels: {
        window: () => ({ rows: [] }),
        list: () => snapshot,
        subscribeList: () => () => {},
      },
    } as unknown as RelaySession;
    const tab = {
      id: "thread",
      kind: "thread" as const,
      channelId: "beta",
      messageId: "a".repeat(64),
      replyRequest: 1,
    };
    const props = {
      tab,
      channel,
      session,
      scope: "focus-test",
      active: true,
      focusOnMount,
      openLink: () => false,
      canOpenLink: () => false,
      openThread: () => {},
      close: () => {},
    };
    const mounted = render(<ConversationTab {...props} />);
    const thread = screen.getByText("Thread content");
    if (focusOnMount) expect(thread).toHaveAttribute("data-reply-request", "1");
    else expect(thread).not.toHaveAttribute("data-reply-request");
    mounted.rerender(<ConversationTab {...props} focusOnMount />);
    if (!focusOnMount) expect(thread).not.toHaveAttribute("data-reply-request");
    // Renaming or merging copies the tab without making a new request.
    mounted.rerender(
      <ConversationTab {...props} tab={{ ...tab, name: "Launch plan" }} />,
    );
    if (!focusOnMount) expect(thread).not.toHaveAttribute("data-reply-request");
    mounted.rerender(
      <ConversationTab {...props} tab={{ ...tab, replyRequest: undefined }} />,
    );
    expect(thread).not.toHaveAttribute("data-reply-request");
    // A non-Reply opening resets the sequence; a later Reply may reuse number 1.
    mounted.rerender(<ConversationTab {...props} tab={{ ...tab }} />);
    expect(thread).toHaveAttribute("data-reply-request", "1");
  },
);

it("a tab mounted later in its visit treats the visit's requests as restored", () => {
  const channel = { id: "beta", name: "Beta" };
  const snapshot = { status: "ready", channels: [channel] };
  const session = {
    unread: unreadEvidence,
    channels: {
      window: () => ({ rows: [] }),
      list: () => snapshot,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const tab: Tab = {
    id: "thread",
    kind: "thread",
    channelId: "beta",
    messageId: "a".repeat(64),
    replyRequest: 1,
    revealRequest: 1,
    focusRequest: 1,
  };
  const props = {
    channel,
    session,
    scope: "deferred-test",
    active: true,
    focusOnMount: true,
    restored: tab,
    openLink: () => false,
    canOpenLink: () => false,
    openThread: () => {},
    close: () => {},
  };
  const mounted = render(<ConversationTab {...props} tab={tab} />);
  const thread = screen.getByText("Thread content");
  expect(thread).not.toHaveAttribute("data-reply-request");
  expect(thread).not.toHaveAttribute("data-focus-request");
  expect(thread).toHaveAttribute("data-reveal-selected", "false");
  mounted.rerender(
    <ConversationTab
      {...props}
      tab={{ ...tab, replyRequest: 2, revealRequest: 2, focusRequest: 2 }}
    />,
  );
  expect(thread).toHaveAttribute("data-reply-request", "2");
  expect(thread).toHaveAttribute("data-focus-request", "2");
  expect(thread).toHaveAttribute("data-reveal-request", "2");
});

it.each([
  ["conversation", false],
  ["conversation", true],
  ["thread", false],
  ["thread", true],
] as const)(
  "restored %s composer focus is not replayed but fresh requests are delivered (focusOnMount=%s)",
  (kind, focusOnMount) => {
    const channel = { id: "beta", name: "Beta" };
    const snapshot = { status: "ready", channels: [channel] };
    const session = {
      unread: unreadEvidence,
      channels: {
        window: () => ({ rows: [] }),
        list: () => snapshot,
        subscribeList: () => () => {},
      },
    } as unknown as RelaySession;
    const tab: Tab =
      kind === "thread"
        ? {
            id: "beta-tab",
            kind,
            channelId: "beta",
            messageId: "a".repeat(64),
            focusRequest: 1,
          }
        : { id: "beta-tab", kind, channelId: "beta", focusRequest: 1 };
    const props = {
      tab,
      channel,
      session,
      scope: "composer-focus-test",
      active: true,
      focusOnMount,
      openLink: () => false,
      canOpenLink: () => false,
      openThread: () => {},
      close: () => {},
    };
    const mounted = render(<ConversationTab {...props} />);
    const composer = screen.getByText(
      kind === "thread" ? "Thread content" : "Composer content",
    );
    if (focusOnMount)
      expect(composer).toHaveAttribute("data-focus-request", "1");
    else expect(composer).not.toHaveAttribute("data-focus-request");
    mounted.rerender(
      <ConversationTab {...props} tab={{ ...tab, focusRequest: 2 }} />,
    );
    expect(composer).toHaveAttribute("data-focus-request", "2");
  },
);

it.each(["pointerDown", "keyDown"] as const)(
  "a focus request expires once the user acts first (%s)",
  (event) => {
    const channel = { id: "beta", name: "Beta" };
    const snapshot = { status: "ready", channels: [channel] };
    const session = {
      unread: unreadEvidence,
      channels: {
        window: () => ({ rows: [] }),
        list: () => snapshot,
        subscribeList: () => () => {},
      },
    } as unknown as RelaySession;
    const tab: Tab = {
      id: "thread",
      kind: "thread",
      channelId: "beta",
      messageId: "a".repeat(64),
      focusRequest: 1,
    };
    const props = {
      tab,
      channel,
      session,
      scope: "focus-expiry-test",
      active: true,
      openLink: () => false,
      canOpenLink: () => false,
      openThread: () => {},
      close: () => {},
    };
    const mounted = render(<ConversationTab {...props} />);
    const thread = screen.getByText("Thread content");
    expect(thread).toHaveAttribute("data-focus-request", "1");
    // Acting elsewhere before the reply box loads keeps the user's focus.
    act(() => {
      fireEvent[event](document.body, { key: "a" });
    });
    expect(thread).not.toHaveAttribute("data-focus-request");
    mounted.rerender(
      <ConversationTab {...props} tab={{ ...tab, focusRequest: 2 }} />,
    );
    expect(thread).toHaveAttribute("data-focus-request", "2");
  },
);

it.each([false, true])(
  "conversation tabs reserve the jump button's activity lane only for a live channel (cached=%s)",
  (cached) => {
    const channel = {
      id: "beta",
      name: "Beta",
      ...(cached ? { cached: true as const } : {}),
    };
    const snapshot = { status: "ready", channels: [channel] };
    const session = {
      unread: unreadEvidence,
      channels: {
        window: () => ({ rows: [] }),
        list: () => snapshot,
        subscribeList: () => () => {},
      },
    } as unknown as RelaySession;
    render(
      <ConversationTab
        tab={{ id: "beta-tab", kind: "conversation", channelId: "beta" }}
        channel={channel}
        session={session}
        scope="lane-test"
        active
        openLink={() => false}
        canOpenLink={() => false}
        openThread={() => {}}
        close={() => {}}
      />,
    );
    // The composer below the body mounts TypingIndicator only when live.
    expect(screen.getByText("Conversation content")).toHaveAttribute(
      "data-activity-lane",
      String(!cached),
    );
  },
);

function openingAt(rows: { id: string; threadRootId?: string }[]) {
  const channel = { id: "beta", name: "Beta" };
  const snapshot = { status: "ready", channels: [channel] };
  let window = {
    channelId: "beta",
    status: "loading",
    rows: [] as typeof rows,
    hasMore: false,
    loadingOlder: false,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const session = {
    unread: unreadEvidence,
    channels: {
      list: () => snapshot,
      subscribeList: () => () => {},
      window: () => window,
      subscribeWindow: (_: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: () => {},
      loadOlder: () => {},
    },
  } as unknown as RelaySession;
  const props = {
    channel,
    session,
    scope: "opening-test",
    active: true,
    openLink: () => false,
    canOpenLink: () => false,
    openThread: () => {},
    close: () => {},
  };
  return {
    props,
    settle() {
      act(() => {
        window = { ...window, status: "ready", rows };
        for (const listener of listeners) listener();
      });
    },
  };
}

it("a conversation tab opens at its message once the reader finds it", () => {
  const c = openingAt([{ id: "post" }]);
  const tab = {
    id: "conversation:beta",
    kind: "conversation" as const,
    channelId: "beta",
    messageId: "post",
    revealRequest: 1,
  };
  render(<ConversationTab {...c.props} tab={tab} />);
  const body = screen.getByText("Conversation content");
  expect(body).toHaveAttribute("data-holding", "true");
  c.settle();
  expect(body).toHaveAttribute("data-holding", "false");
  expect(body).toHaveAttribute("data-target", "post");
  expect(body).toHaveAttribute("data-marks-read", "true");
});

it("a retained conversation tab gives its rows one thread opener that reaches the latest handler", () => {
  const c = openingAt([]);
  const tab = {
    id: "conversation:beta",
    kind: "conversation" as const,
    channelId: "beta",
  };
  const first = vi.fn();
  const latest = vi.fn();
  threadOpeners.length = 0;
  const view = render(
    <ConversationTab {...c.props} tab={tab} openThread={first} />,
  );
  // The page re-renders its retained tabs with new handlers.
  view.rerender(<ConversationTab {...c.props} tab={tab} openThread={latest} />);
  expect(threadOpeners.length).toBeGreaterThan(1);
  expect(new Set(threadOpeners).size).toBe(1);
  threadOpeners[0]?.("reply", "root", "reply");
  expect(latest).toHaveBeenCalledWith("reply", "root", "reply");
  expect(first).not.toHaveBeenCalled();
});

it("a conversation tab opens a reply at its message as the thread", () => {
  const c = openingAt([{ id: "root" }, { id: "reply", threadRootId: "root" }]);
  render(
    <ConversationTab
      {...c.props}
      tab={{
        id: "conversation:beta",
        kind: "conversation",
        channelId: "beta",
        messageId: "reply",
        revealRequest: 1,
      }}
    />,
  );
  c.settle();
  const thread = screen.getByText("Thread content");
  expect(thread).toHaveAttribute("data-reveal-selected", "true");
  expect(thread).toHaveAttribute("data-reveal-request", "1");
  expect(screen.queryByText("Conversation content")).toBeNull();
});

it("a thread tab asks its reader to reveal for each open at a message, not on restore", () => {
  const c = openingAt([]);
  const tab = {
    id: "thread:beta:root",
    kind: "thread" as const,
    channelId: "beta",
    messageId: "reply",
    revealRequest: 1,
  };
  const mounted = render(
    <ConversationTab {...c.props} tab={tab} focusOnMount={false} />,
  );
  const thread = screen.getByText("Thread content");
  expect(thread).toHaveAttribute("data-reveal-selected", "false");
  expect(thread).not.toHaveAttribute("data-reveal-request");
  mounted.rerender(
    <ConversationTab
      {...c.props}
      tab={{ ...tab, revealRequest: 2 }}
      focusOnMount={false}
    />,
  );
  expect(thread).toHaveAttribute("data-reveal-selected", "true");
  expect(thread).toHaveAttribute("data-reveal-request", "2");
});

it("markRead false reaches the reader, and a restored tab does not reveal again", () => {
  const c = openingAt([{ id: "post" }]);
  const tab = {
    id: "conversation:beta",
    kind: "conversation" as const,
    channelId: "beta",
    messageId: "post",
    revealRequest: 2,
    markRead: false as const,
  };
  const mounted = render(
    <ConversationTab {...c.props} tab={tab} focusOnMount={false} />,
  );
  c.settle();
  const body = screen.getByText("Conversation content");
  expect(body).toHaveAttribute("data-marks-read", "false");
  expect(body).not.toHaveAttribute("data-target");
  expect(body).toHaveAttribute("data-holding", "false");
  // A new open of the restored tab reveals its message.
  mounted.rerender(
    <ConversationTab
      {...c.props}
      tab={{ ...tab, revealRequest: 3 }}
      focusOnMount={false}
    />,
  );
  expect(body).toHaveAttribute("data-target", "post");
});

it("lets the tab supply Solo chat identity without repeating a visible heading", () => {
  const channel = {
    id: "beta",
    name: "Poem explanation",
    channelType: "solo" as const,
  };
  const snapshot = { status: "ready", channels: [channel] };
  const idle = () => () => {};
  const profiles = new Map();
  const session = {
    unread: unreadEvidence,
    channels: {
      window: () => ({ rows: [] }),
      list: () => snapshot,
      subscribeList: idle,
    },
    profiles: { snapshot: () => profiles, subscribe: idle },
    agentChoices: { snapshot: () => undefined, subscribe: idle },
  } as unknown as RelaySession;
  render(
    <ConversationTab
      tab={{ id: "chat", kind: "conversation", channelId: "beta" }}
      channel={channel}
      session={session}
      scope="tab-title-test"
      openLink={() => false}
      canOpenLink={() => false}
      openThread={() => {}}
      close={() => {}}
      active
      visit={false}
    />,
  );
  const conversation = screen.getByRole("region", {
    name: "Conversation in Poem explanation",
  });
  expect(
    within(conversation).queryByRole("heading", { name: "Poem explanation" }),
  ).toBeNull();
  expect(within(conversation).getByText("Conversation content")).toBeVisible();
  expect(within(conversation).getByText("Composer content")).toBeVisible();
});

it("tells the composer when its tab is shown, apart from whether showing visits", () => {
  const channel = { id: "beta", name: "Chat", channelType: "solo" as const };
  const snapshot = { status: "ready", channels: [channel] };
  const idle = () => () => {};
  const profiles = new Map();
  const session = {
    unread: unreadEvidence,
    channels: {
      window: () => ({ rows: [] }),
      list: () => snapshot,
      subscribeList: idle,
    },
    profiles: { snapshot: () => profiles, subscribe: idle },
    agentChoices: { snapshot: () => undefined, subscribe: idle },
  } as unknown as RelaySession;
  const tab = (active: boolean) => (
    <ConversationTab
      tab={{ id: "chat", kind: "conversation", channelId: "beta" }}
      channel={channel}
      session={session}
      scope="tab-shown-test"
      openLink={() => false}
      canOpenLink={() => false}
      openThread={() => {}}
      close={() => {}}
      active={active}
      visit={false}
    />
  );
  const view = render(tab(true));
  const composer = screen.getByText("Composer content");
  expect(composer).toHaveAttribute("data-shown", "true");
  view.rerender(tab(false));
  expect(composer).toHaveAttribute("data-shown", "false");
  view.rerender(tab(true));
  expect(composer).toHaveAttribute("data-shown", "true");
});

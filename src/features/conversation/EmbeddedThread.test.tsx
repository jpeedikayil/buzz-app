import {
  ConversationHost,
  type ConversationInteractions,
} from "./ConversationHost";
import { ConversationPresentation } from "./ConversationPresentation";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EmbeddedThread } from "./EmbeddedThread";
import { ConversationChannel, ConversationComposer } from "./Conversation";
import type { Context } from "@deepseek-ai/cordis";
import type { ComponentProps } from "react";
import { createAgentLibrary } from "../agents/library";
import { useMessageDeletion } from "../messages/MessageManagement";
import type { MessageComposerProps } from "../messages/MessageComposer";
import type { MessageRowProps } from "../messages/MessageRow";
import type { PanelProps, RegisteredPanel } from "../panels/service";
import type { ChannelMessage } from "../relay/contracts";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";

// The real ThreadPanel and MessageManagement are composed; only leaf UI with
// its own mounted suites is reduced to the props this owner supplies.
vi.mock("../relay/react", () => {
  const profiles = new Map();
  return { useProfileGeneration: () => 0, useRowProfiles: () => profiles };
});
vi.mock("../messages/MessageRow", () => ({
  MessageRow: ({ row, onOpenLink, onOpenMediaReview }: MessageRowProps) => (
    <article>
      <button
        type="button"
        onClick={() => onOpenLink?.("fixture:one", { rootId: row.id })}
      >
        Open linked panel
      </button>
      <button
        type="button"
        // biome-ignore lint/style/noNonNullAssertion: the fixture row has one attachment.
        onClick={() => onOpenMediaReview?.(row.id, row.attachments[0]!, 0)}
      >
        Open media review
      </button>
    </article>
  ),
}));
vi.mock("../messages/MessageComposer", () => ({
  MessageComposer: ({ soloConversation }: MessageComposerProps) => (
    <section
      aria-label="Composer"
      data-solo-conversation={String(!!soloConversation)}
      data-deletion={String(!!useMessageDeletion())}
    />
  ),
}));
vi.mock("../messages/MediaReviewViewer", () => ({
  MediaReviewViewer: (props: { onOpenLink(url: string): boolean }) => (
    <section aria-label="Media review">
      <button type="button" onClick={() => props.onOpenLink("fixture:one")}>
        Open panel from review
      </button>
    </section>
  ),
}));
const dialog = vi.hoisted(() => ({
  finalFocus: undefined as (() => HTMLElement | false) | undefined,
}));
vi.mock("../../shared/design-system/ui/Dialog", () => ({
  Dialog: (props: {
    children: React.ReactNode;
    finalFocus(): HTMLElement | false;
  }) => {
    dialog.finalFocus = props.finalFocus;
    return <section>{props.children}</section>;
  },
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture(
  channelType: "stream" | "solo" = "stream",
  operations: readonly OutgoingEvent[] = [],
  creator?: string,
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let captured: PanelProps | undefined;
  const panel = {
    key: "fixture",
    id: "fixture",
    pluginId: "fixture",
    revision: "1",
    title: "Fixture",
    matches: () => true,
    component: (props: PanelProps) => {
      captured = props;
      return <p>Linked content</p>;
    },
  } as RegisteredPanel;
  let panels = [panel];
  const listeners = new Set<() => void>();
  const root: ChannelMessage = {
    id: "a".repeat(64),
    channelId: "c",
    authorId: "b".repeat(64),
    content: "root",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [{ url: "https://fixture.test/image.png", kind: "image" }],
    reactions: [],
    replyCount: 0,
  };
  const thread = {
    status: "ready",
    root,
    replies: [],
    error: undefined,
    canLoadMore: false,
    limited: false,
  };
  const viewer = "a".repeat(64);
  const profiles = new Map();
  const channels = {
    channels: [
      { id: "c", name: "Channel", channelType, members: [viewer], creator },
      { id: "d", name: "Other", channelType, members: [viewer] },
    ],
  };
  const unread = {
    revision: () => 0,
    sync: () => ({ capability: "unsupported" }),
    snapshot: () => undefined,
    subscribe: () => () => {},
    attention: () => ({ unread: false }),
    enterChannel: vi.fn(async () => {}),
    leaveChannel: vi.fn(),
  };
  const outbox = {
    subscribe: () => () => {},
    observeSend: () => () => {},
    snapshot: () => operations,
    supports: () => true,
    retry: vi.fn(),
  };
  const session = {
    viewer,
    thread: () => ({
      snapshot: () => thread,
      subscribe: () => () => {},
      refresh: async () => {},
      loadMore: async () => {},
      dispose() {},
    }),
    channels: {
      subscribeList: () => () => {},
      list: () => channels,
      window: () => ({ rows: [] }),
    },
    profiles: {
      ensure: async () => {},
      snapshot: () => profiles,
      subscribe: () => () => {},
    },
    agentChoices: createAgentLibrary(undefined).queries,
    messages: { retry() {}, canRetry: () => true },
    media: () => undefined,
    unread,
    outbox,
  } as unknown as RelaySession;
  const scope = `https://fixture.test:${viewer}`;
  const host = {
    panels: {
      snapshot: () => panels,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      resolve: () => panels[0],
    },
    relay: { snapshot: () => ({ status: "ready", session, scope }) },
    navigation: { open: vi.fn() },
  } as unknown as Context;
  const props = {
    host,
    session,
    scope,
    channelId: "c",
    channelName: "Channel",
    messageId: root.id,
    extensions: {} as ComponentProps<typeof EmbeddedThread>["extensions"],
  };
  return {
    props,
    unread,
    outbox,
    listeners,
    panelProps: () => captured,
    removePanels() {
      act(() => {
        panels = [];
        for (const fn of listeners) fn();
      });
    },
  };
}

it("retires panel actions on contribution removal, destination change and unmount", () => {
  const h = fixture();
  const view = render(<EmbeddedThread {...h.props} />);
  fireEvent.click(screen.getByText("Open linked panel"));
  expect(screen.getByText("Linked content")).toBeVisible();
  const old = h.panelProps();
  view.rerender(<EmbeddedThread {...h.props} messageId={"c".repeat(64)} />);
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
  expect(old?.context?.open("fixture:two")).toBe(false);
  fireEvent.click(screen.getByText("Open linked panel"));
  const removed = h.panelProps();
  h.removePanels();
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
  expect(removed?.context?.open("fixture:two")).toBe(false);
  view.unmount();
  expect(removed?.context?.open("fixture:two")).toBe(false);
  expect(h.listeners.size).toBe(0);
});

it("a panel keeps the thread root it was opened from, like Channels", () => {
  const h = fixture();
  render(<EmbeddedThread {...h.props} />);
  fireEvent.click(screen.getByText("Open linked panel"));
  expect(h.panelProps()?.context?.rootId).toBe(h.props.messageId);
  act(() => {
    h.panelProps()?.context?.open("fixture:two");
  });
  expect(h.panelProps()?.target).toBe("fixture:two");
  expect(h.panelProps()?.context?.rootId).toBe(h.props.messageId);
});

it.each([
  ["a panel replaces itself", "Open linked panel"],
  ["media review opens a panel", "Open media review"],
] as const)("focus returns to the message when %s", (_, opener) => {
  const h = fixture();
  render(<EmbeddedThread {...h.props} />);
  const button = screen.getByText(opener);
  button.focus();
  fireEvent.click(button);
  if (opener === "Open media review") {
    const inner = screen.getByText("Open panel from review");
    inner.focus();
    fireEvent.click(inner);
  } else {
    // A control inside the panel that the replacement unmounts.
    const inner = document.createElement("button");
    document.body.append(inner);
    inner.focus();
    act(() => {
      h.panelProps()?.context?.open("fixture:two");
    });
    inner.remove();
  }
  expect(screen.getByText("Linked content")).toBeVisible();
  expect(dialog.finalFocus?.()).toBe(button);
});

it("a panel opened from media review replaces the viewer, and media review replaces a panel", () => {
  render(<EmbeddedThread {...fixture().props} />);
  fireEvent.click(screen.getByText("Open media review"));
  fireEvent.click(screen.getByText("Open panel from review"));
  expect(screen.getByText("Linked content")).toBeVisible();
  expect(screen.queryByLabelText("Media review")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Open media review"));
  expect(screen.getByLabelText("Media review")).toBeVisible();
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
});

it("the channel reply composer gets message management", () => {
  render(<EmbeddedThread {...fixture("stream").props} />);
  expect(screen.getByLabelText("Composer")).toHaveAttribute(
    "data-deletion",
    "true",
  );
});

it("a Solo thread opens without a reply composer", () => {
  render(<EmbeddedThread {...fixture("solo").props} />);
  expect(screen.getByRole("article")).toBeVisible();
  expect(screen.queryByLabelText("Composer")).not.toBeInTheDocument();
});

it("selecting a channel supplies its readers without remounting the page below", () => {
  const { props } = fixture();
  const interactions: ConversationInteractions = {
    onOpenLink: () => true,
    canOpenLink: () => false,
    onOpenMediaReview: () => {},
  };
  const page = (channel?: {
    id: string;
    name: string;
    channelType: "solo";
  }) => (
    <ConversationChannel
      session={props.session}
      scope={props.scope}
      extensions={props.extensions}
      channel={channel}
      interactions={interactions}
    >
      <input aria-label="Page state" />
      {channel && <ConversationComposer />}
    </ConversationChannel>
  );
  const view = render(page());
  const input = screen.getByLabelText("Page state");
  fireEvent.change(input, { target: { value: "kept" } });
  view.rerender(page({ id: "c", name: "Channel", channelType: "solo" }));
  expect(screen.getByLabelText("Page state")).toBe(input);
  expect(input).toHaveValue("kept");
  const composer = screen.getByLabelText("Composer");
  expect(composer).toHaveAttribute("data-solo-conversation", "true");
  expect(composer).toHaveAttribute("data-deletion", "true");
  view.rerender(page());
  expect(screen.getByLabelText("Page state")).toBe(input);
});

it("keeps one channel visit while the thread is retargeted within a channel", () => {
  const h = fixture();
  const view = render(<EmbeddedThread {...h.props} />);
  expect(h.unread.enterChannel).toHaveBeenCalledExactlyOnceWith("c");
  view.rerender(<EmbeddedThread {...h.props} messageId={"c".repeat(64)} />);
  expect(h.unread.enterChannel).toHaveBeenCalledOnce();
  expect(h.unread.leaveChannel).not.toHaveBeenCalled();
  // Leaving the channel is the barrier: the visit does follow the channel.
  view.rerender(<EmbeddedThread {...h.props} channelId="d" />);
  expect(h.unread.leaveChannel).toHaveBeenCalledExactlyOnceWith("c");
  expect(h.unread.enterChannel).toHaveBeenLastCalledWith("d");
});

it("offers recovery for a failed edit left in the outbox", () => {
  const h = fixture("stream", [
    {
      event: {
        id: "edit",
        kind: 40003,
        content: "edited",
        tags: [
          ["h", "c"],
          ["e", "a".repeat(64)],
        ],
      },
      delivery: "failed",
      error: "Relay refused the edit.",
    } as unknown as OutgoingEvent,
  ]);
  render(<EmbeddedThread {...h.props} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Message edit: Relay refused the edit.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry message update" }));
  expect(h.outbox.retry).toHaveBeenCalledExactlyOnceWith("edit");
});

it("the shared conversation host supplies live actions and retires them while its reader is withheld", () => {
  const h = fixture();
  let captured: ConversationInteractions | undefined;
  const mount = (visible: boolean) => (
    <ConversationPresentation value={visible}>
      <ConversationHost {...h.props} threadId={h.props.messageId}>
        {(interactions) => {
          captured = interactions;
          return (
            <button
              type="button"
              onClick={() => interactions.onOpenLink("fixture:one")}
            >
              Open profile
            </button>
          );
        }}
      </ConversationHost>
    </ConversationPresentation>
  );
  const view = render(mount(true));
  const old = captured;
  expect(old?.canOpenLink?.("fixture:one")).toBe(true);
  fireEvent.click(screen.getByText("Open profile"));
  expect(screen.getByText("Linked content")).toBeVisible();
  expect(h.panelProps()?.channelContext?.threadId).toBe(h.props.messageId);
  view.rerender(mount(false));
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
  expect(old?.onOpenLink("fixture:one")).toBe(false);
  act(() =>
    old?.onOpenMediaReview?.(
      "a",
      { kind: "image", url: "https://fixture.test/image.png" },
      0,
    ),
  );
  expect(screen.queryByLabelText("Media review")).not.toBeInTheDocument();
  view.rerender(mount(true));
  fireEvent.click(screen.getByText("Open profile"));
  expect(screen.getByText("Linked content")).toBeVisible();
});

it("an open channel reserves profile room for its roster and returns it when it closes", () => {
  const { props } = fixture();
  const release = vi.fn();
  const reserve = vi.fn(() => release);
  const session = {
    ...props.session,
    profiles: { ...props.session.profiles, reserve },
  } as RelaySession;
  const interactions: ConversationInteractions = {
    onOpenLink: () => true,
    canOpenLink: () => false,
    onOpenMediaReview: () => {},
  };
  const page = (id?: string, active?: boolean) => (
    <ConversationChannel
      session={session}
      scope={props.scope}
      extensions={props.extensions}
      channel={id ? { id, name: "Channel" } : undefined}
      active={active}
      interactions={interactions}
    >
      <input aria-label="Page state" />
    </ConversationChannel>
  );
  const view = render(page("c"));
  expect(reserve).toHaveBeenCalledExactlyOnceWith(1);
  view.rerender(page());
  expect(release).toHaveBeenCalledOnce();
  view.rerender(page("d"));
  expect(reserve).toHaveBeenCalledTimes(2);
  // A retained tab in the background gives the room back until it is shown.
  view.rerender(page("d", false));
  expect(release).toHaveBeenCalledTimes(2);
  view.rerender(page("d", true));
  expect(reserve).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(release).toHaveBeenCalledTimes(3);
});

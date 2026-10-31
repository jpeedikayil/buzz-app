// @vitest-environment jsdom
import { StrictMode } from "react";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { npubEncode } from "nostr-tools/nip19";
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import { expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { PREVIEW_REST_MS } from "../../shared/design-system/ui/hoverIntent";
import { messageCopyText } from "./message-copy";
import { profileTarget, profileActivityViewTarget } from "../profiles/target";
import { renderToStaticMarkup } from "react-dom/server";
import { foldMessages } from "../relay/fold";
import { eventDto } from "../relay/events";
import { createProfileDirectory } from "../relay/profile-directory";
import {
  keypair,
  message,
  profile as profileEvent,
  signed,
  summary,
} from "../relay/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { MessageRow } from "./MessageRow";
import { MessageManagement } from "./MessageManagement";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { UnreadCapability, UnreadSnapshot } from "../relay/unread";
import type { RelaySession } from "../relay/session";
import type { TypingEntry } from "../relay/typing";
import { LinkLabel } from "../../bundled/links/InlineLink";
import { attestedOwner } from "../agents/owner-attestation";

// Real verification, observed so tests can wait for its verdict.
vi.mock("../agents/owner-attestation", async (original) => {
  const actual = await original<typeof import("../agents/owner-attestation")>();
  return { ...actual, attestedOwner: vi.fn(actual.attestedOwner) };
});

const row: ChannelMessage = {
  id: "root",
  channelId: "channel",
  authorId: "author",
  content: "Root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 23,
};

it.each([false, true])(
  "previews human and agent identities and preserves avatar navigation: %s",
  async (agentEnvelope) => {
    vi.useFakeTimers();
    const showPopover = HTMLElement.prototype.showPopover;
    HTMLElement.prototype.showPopover = function () {
      this.style.display = "block";
    };
    const authorId = "ab".repeat(32);
    const open = vi.fn(() => true);
    try {
      renderDom(
        <MessageRow
          row={{
            ...row,
            authorId,
            ...(agentEnvelope ? { agentEnvelope: true as const } : {}),
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      const avatar = screen.getByRole("button", {
        name: `View ${authorId.slice(0, 10)} profile`,
      });
      expect(
        screen.queryByRole("dialog", { name: /profile preview/ }),
      ).toBeNull();
      fireEvent.mouseEnter(avatar);
      fireEvent.mouseMove(avatar);
      await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
      const preview = screen.getByRole("dialog", {
        name: `${authorId.slice(0, 10)} profile preview`,
      });
      expect(preview).toHaveTextContent(authorId.slice(0, 10));
      expect(!!within(preview).queryByLabelText("Agent")).toBe(agentEnvelope);
      fireEvent.click(
        within(preview).getByRole("button", { name: "View profile" }),
      );
      expect(open).toHaveBeenCalledWith(
        profileTarget(authorId, { agent: agentEnvelope }),
        { rootId: "root" },
      );
      open.mockClear();
      fireEvent.click(avatar);
      expect(open).toHaveBeenCalledWith(
        profileTarget(authorId, { agent: agentEnvelope }),
        { rootId: "root" },
      );
    } finally {
      cleanup();
      if (showPopover) HTMLElement.prototype.showPopover = showPopover;
      else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
      vi.useRealTimers();
    }
  },
);

it.each([
  { recognized: undefined, handled: true },
  { recognized: false, handled: true },
  { recognized: true, handled: false },
  { recognized: true, handled: true },
])(
  "opens images through an explicitly accepting host or the local viewer: %j",
  ({ recognized, handled }) => {
    const url = "https://relay.test/media/image.png";
    const open = vi.fn(() => handled);
    try {
      renderDom(
        <MessageRow
          row={{ ...row, attachments: [{ url, kind: "image" }] }}
          profile={undefined}
          media={() => url}
          onOpenLink={open}
          canOpenLink={recognized === undefined ? undefined : () => recognized}
          day={false}
          retry={undefined}
        />,
      );
      fireEvent.click(
        screen.getByRole("link", { name: "Open image attachment" }),
      );
      if (recognized)
        expect(open).toHaveBeenCalledWith(url, { rootId: row.id });
      else expect(open).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog") !== null).toBe(
        !recognized || !handled,
      );
    } finally {
      cleanup();
    }
  },
);

it("tells link handlers the thread a reply was opened from", () => {
  const open = vi.fn(() => true);
  const authorId = "ab".repeat(32);
  try {
    renderDom(
      <MessageRow
        row={{
          ...row,
          authorId,
          id: "reply",
          threadRootId: "thread",
          replyCount: 0,
        }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={open}
        canOpenLink={() => true}
        day={false}
        retry={undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: `View ${authorId.slice(0, 10)} profile`,
      }),
    );
    expect(open).toHaveBeenCalledWith(profileTarget(authorId), {
      rootId: "thread",
    });
  } finally {
    cleanup();
  }
});

it("keeps plain agent presence without avatar activity, and omits human presence from messages", () => {
  const agentRow = { ...row, authorId: "a".repeat(64) };
  const subscribe = vi.fn(() => () => {});
  const status = vi.fn<() => "online" | "unknown">(() => "online");
  const channels = { channels: [], status: "ready" };
  let working = false;
  const activityListeners = new Set<() => void>();
  const session = {
    agentActivity: {
      snapshot: () => ({
        turns: working
          ? [
              {
                agent: agentRow.authorId,
                channelId: row.channelId,
                state: "working",
              },
            ]
          : [],
        typing: [],
      }),
      subscribe: (listener: () => void) => {
        activityListeners.add(listener);
        return () => {
          activityListeners.delete(listener);
        };
      },
    },
    presence: { subscribe, status, limited: () => false },
    messages: { report: undefined },
    channels: {
      subscribeList: () => () => {},
      list: () => channels,
    },
  } as unknown as RelaySession;
  const show = (agent: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={agentRow}
        agentPubkeys={agent ? new Set([agentRow.authorId]) : undefined}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
  const agent = show(true);
  expect(agent).not.toContain("agent-motion-avatar");
  expect(agent).toContain('data-status="online"');
  expect(agent).toContain('data-avatar-shape="squircle"');
  expect(agent).toContain('aria-label="Agent, online"');
  const human = show(false);
  expect(human).not.toContain('data-status="online"');
  expect(human).not.toContain("data-compact");
  expect(status).toHaveBeenCalledTimes(1);
  const props = {
    row: agentRow,
    session,
    profile: undefined,
    media: () => undefined,
    onOpenLink: () => false,
    day: false,
    retry: undefined,
  };
  const mounted = renderDom(
    <MessageRow {...props} agentPubkeys={new Set([agentRow.authorId])} />,
  );
  expect(subscribe).toHaveBeenCalledWith(
    agentRow.authorId,
    expect.any(Function),
    false,
  );
  mounted.rerender(
    <MessageRow
      {...props}
      agentPubkeys={new Set([agentRow.authorId])}
      canOpenLink={() => true}
    />,
  );
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription(/^Presence: online\s*$/);
  act(() => {
    working = true;
    for (const listener of activityListeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription("Presence: online");
  expect(document.querySelector(".agent-motion-avatar")).toBeNull();
  expect(document.querySelector('[data-status="online"]')).toBeInTheDocument();
  expect(activityListeners.size).toBe(0);
  act(() => {
    working = false;
    for (const listener of activityListeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription(/^Presence: online\s*$/);
  mounted.unmount();
  status.mockReturnValue("unknown");
  const unknown = renderDom(<MessageRow {...props} canOpenLink={() => true} />);
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).not.toHaveAccessibleDescription();
  unknown.unmount();
  subscribe.mockClear();
  renderDom(<MessageRow {...props} />);
  expect(subscribe).not.toHaveBeenCalled();
  cleanup();
});
it.each(["bare", "angle", "markdown", "escaped"] as const)(
  "renders link contributions inside message prose, preserving punctuation and plain-link fallback (%s)",
  (format) => {
    const url = "https://github.com/block/buzz/issues/1234";
    const label =
      format === "markdown" || format === "escaped" ? "Repository" : url;
    const content = {
      bare: url,
      angle: `<${url}>`,
      markdown: `[Repository](${url})`,
      escaped: `[Repository]\\([${url}](${url}))`,
    }[format];
    const entry = {
      id: "link",
      title: "Link",
      key: "buzz.links/link",
      pluginId: "buzz.links",
      revision: "one",
      matches: () => true,
      component: ({ url }: { url: string }) => <LinkLabel href={url} />,
    };
    const render = (enabled: boolean) =>
      renderToStaticMarkup(
        <MessageRow
          row={{
            ...row,
            content: `Before ${content}. After`,
            replyCount: 0,
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          extensions={{
            tools: { snapshot: () => [], subscribe: () => () => {} },
            inline: { snapshot: () => [], subscribe: () => () => {} },
            links: {
              snapshot: () => (enabled ? [entry] : []),
              subscribe: () => () => {},
            },
          }}
        />,
      );
    const enabled = render(true);
    expect(enabled).toContain(`href="${url}"`);
    expect(enabled).toContain('data-link-kind="github"');
    const container = document.createElement("div");
    container.innerHTML = enabled;
    expect(container.textContent).toContain(`Before ${label}. After`);
    expect(enabled).not.toContain("&lt;");
    expect(enabled).not.toContain("&gt;");
    expect(render(false)).not.toContain("data-link-kind");
    expect(render(false)).toContain(`>${label}</a>`);
  },
);

it.each([
  ["😀 🙏 👏", [], true],
  ["😀".repeat(40), [], true],
  [
    ":party: ".repeat(24),
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    true,
  ],
  ["😀 🙏 👏 😄 hello", [], false],
  [":unknown: 😀", [], false],
  ["  \n  ", [], false],
] as const)(
  "keeps emoji-only message size independent of count: %s",
  (content, emoji, large) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{ ...row, content, emoji }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html.includes('data-single-emoji="true"')).toBe(large);
    expect(html.includes('data-emoji-only="true"')).toBe(large);
  },
);
function render(
  patch: Partial<UnreadSnapshot>,
  replies = 23,
  clickable = true,
  threadRootId?: string,
) {
  const snapshot = vi.fn(() => ({
    observedCount: null,
    manual: "none",
    ...patch,
  }));
  const unread = { snapshot } as unknown as UnreadCapability;
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, replyCount: replies, threadRootId }}
      unread={unread}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={clickable ? () => {} : undefined}
    />,
  );
  return { html, snapshot };
}
it("renders the signed whole-thread total rather than only direct replies", () => {
  const author = keypair(),
    relay = keypair();
  const root = message(author, "channel", "Root", 1);
  const [folded] = foldMessages("channel", relay.pubkey, [
    root,
    summary(relay, "channel", root.id, {
      reply_count: 1,
      descendant_count: 3,
      participants: [author.pubkey],
    }),
  ]);
  if (!folded) throw new Error("Missing root");
  const html = renderToStaticMarkup(
    <MessageRow
      row={folded}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={() => {}}
    />,
  );
  expect(html).toContain('aria-label="View thread: 3 replies"');
  expect(html).toContain("3 replies</span>");
});
it("selects this thread, adds an accessible unread cue and preserves the total reply count", () => {
  const { html, snapshot } = render({ observedCount: 2 });
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "root",
  });
  expect(html).toContain(
    'aria-label="View thread: 23 replies. Observed unread replies. Not an exact total."',
  );
  expect(html).toContain(
    'aria-hidden="true" title="Observed unread replies. Not an exact total."',
  );
  expect(html).toContain("23 replies</span>");
});
it.each([null, 0])(
  "omits the dot for %s observed replies, not a fabricated unread total",
  (observedCount) => {
    const { html } = render({ observedCount });
    expect(html).toContain('aria-label="View thread: 23 replies"');
    expect(html).not.toContain("title=");
  },
);
it("describes local manual intent and stale evidence honestly", () => {
  expect(render({ manual: "local-only", observedCount: 0 }).html).toContain(
    "Thread marked unread on this device only",
  );
  expect(render({ manual: "remote", observedCount: 0 }).html).toContain(
    "Thread marked unread",
  );
  expect(render({ observedCount: 1, freshness: "stale" }).html).toContain(
    "Observed unread replies; may be out of date",
  );
});
it("does not select unread for rows without a thread button", () => {
  expect(render({}, 0).snapshot).not.toHaveBeenCalled();
  expect(render({}, 23, false).snapshot).not.toHaveBeenCalled();
});

it("selects the opening root for a broadcast reply instead of its own row ID", () => {
  const { snapshot } = render({ observedCount: 1 }, 23, true, "original-root");
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "original-root",
  });
});

it("renders exact identity controls only while a target can be opened", () => {
  const author = "a".repeat(64),
    recipient = "b".repeat(64);
  const renderProfile = (enabled: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          authorId: author,
          content: "Hello @Mic",
          mentions: [recipient],
        }}
        profile={{ name: "Author" }}
        participantProfiles={new Map([[recipient, { name: "Mic" }]])}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => enabled}
        day={false}
        retry={undefined}
      />,
    );
  const enabled = renderProfile(true);
  expect(enabled).toContain('aria-label="View Author profile"');
  expect(enabled).toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain(
    'aria-label="View Author profile"',
  );
  expect(renderProfile(false)).toContain('data-mention-name="Mic"');
});

it.each(["~~~js\nconst delimiter = '~~~';\n@Mic\n~~~\nOutside @Mic"])(
  "only exposes the prose mention through MessageRow: %s",
  (content) => {
    const recipient = "b".repeat(64);
    const html = renderToStaticMarkup(
      <MessageRow
        row={{ ...row, content, mentions: [recipient] }}
        profile={undefined}
        participantProfiles={new Map([[recipient, { name: "Mic" }]])}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => true}
        day={false}
        retry={undefined}
      />,
    );
    expect(html.match(/aria-label="View Mic profile"/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="View Mic profile"')).toBeGreaterThan(
      html.indexOf("Outside "),
    );
  },
);

it.each([9, 40002])(
  "does not manufacture profile bindings when kind %s images are removed",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of [
      "@M![x][image]ic\n\n[image]: https://example.test/a.png",
      "@M![x](https://example.test/a.png)ic",
      "@M![x](http://example.test/a.png)ic",
      "@![x](https://example.test/a.png)Mic",
      "Hello @M![x](https://example.test/a.png)ic ![y](https://example.test/b.png)",
    ]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      expect(folded.content).toContain("@Mic");
      expect(folded.attachmentSeams?.length).toBeGreaterThan(0);
      expect(folded.mentions).toEqual([recipient.pubkey]);
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(html).toContain("@Mic");
    }
    const [unchanged] = foldMessages("channel", relay.pubkey, [
      message(author, "channel", "@Mic  \n", 1),
    ]);
    expect(unchanged?.attachmentSeams).toBeUndefined();
  },
);

it("binds signed names beside removed attachments that cannot join them", () => {
  const author = keypair(),
    person = keypair(),
    agent = keypair(),
    namesake = keypair(),
    relay = keypair();
  const media = "https://relay.test/media/shot.png";
  const profiles = new Map([
    [person.pubkey, { name: "kalvin" }],
    [agent.pubkey, { name: "am", isAgent: true as const }],
    [namesake.pubkey, { name: "kalvin chau" }],
  ]);
  const render = (
    content: string,
    mentions: string[],
    tags: string[][] = [],
  ) => {
    const [folded] = foldMessages("channel", relay.pubkey, [
      message(author, "channel", content, 1, [
        ...mentions.map((pubkey) => ["p", pubkey]),
        ...tags,
      ]),
    ]);
    if (!folded) throw new Error("missing message");
    return renderToStaticMarkup(
      <MessageRow
        row={folded}
        profile={undefined}
        participantProfiles={profiles}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => true}
        day={false}
        retry={undefined}
      />,
    );
  };
  const chip = (kind: string, name: string) =>
    new RegExp(
      `data-mention-kind="${kind}"[^>]*aria-label="View ${name} profile"`,
    );
  expect(
    render(
      "@kalvin <https://github.com/block/buzz/pull/7904> :pray-for-stamp:\n![image](https://static.example/stamp.gif)",
      [person.pubkey],
    ),
  ).toMatch(chip("person", "kalvin"));
  expect(
    render(
      `@am i like the \`:ls\` feature\n\n![image.png](<${media}>)`,
      [agent.pubkey],
      [["imeta", `url ${media}`, "m image/png"]],
    ),
  ).toMatch(chip("agent", "am"));
  // Removal may end a name, but a longer name must not cross the seam.
  const joined = render("@kalvin![x](https://example.test/a.png) chau", [
    person.pubkey,
    namesake.pubkey,
  ]);
  expect(joined).toMatch(chip("person", "kalvin"));
  expect(joined).not.toContain("View kalvin chau profile");
});

it.each([9, 40002])(
  "preserves signed kind %s code indentation through fold and render",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of ["    @Mic", "\t@Mic"]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(folded.content).toBe(content);
    }
  },
);

it.each([
  { dimensions: { width: 1600, height: 900 }, width: "360px" },
  { dimensions: { width: 200, height: 800 }, width: "80px" },
  { dimensions: { width: 40, height: 20 }, width: "40px" },
  { dimensions: { width: 999999, height: 1 }, width: "" },
  { dimensions: { width: 1, height: 999999 }, width: "" },
])(
  "reserves a bounded preview from image dimensions: %j",
  ({ dimensions, width }) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: [
            { url: "https://image.test/shot.png", kind: "image", dimensions },
          ],
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    const preview = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector<HTMLAnchorElement>("a[data-media-preview]");
    expect(preview?.style.width).toBe(width);
    expect(preview?.style.aspectRatio).toBe(
      width ? `${dimensions.width} / ${dimensions.height}` : "",
    );
    expect(html).toContain('aria-label="Open image attachment"');
    expect(html).toContain('loading="lazy"');
  },
);

it("uses loaded image proportions without metadata and resets them when the source changes", async () => {
  const show = (url: string) => (
    <MessageRow
      row={{ ...row, attachments: [{ url, kind: "image" }] }}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />
  );
  const view = renderDom(show("https://image.test/landscape.png"));
  try {
    const link = () =>
      view.getByRole("link", { name: "Open image attachment" });
    const loaded = (width: number, height: number) => {
      const image = link().querySelector("img");
      if (!image) throw new Error("Expected attachment image");
      Object.defineProperties(image, {
        naturalWidth: { value: width },
        naturalHeight: { value: height },
        decode: { value: () => Promise.resolve() },
      });
      fireEvent.load(image);
    };
    loaded(900, 600);
    await waitFor(() => expect(link().style.aspectRatio).toBe("360 / 240"));
    view.rerender(show("https://image.test/portrait.png"));
    expect(link().style.aspectRatio).toBe("");
    loaded(300, 600);
    await waitFor(() => expect(link().style.aspectRatio).toBe("160 / 320"));
  } finally {
    view.unmount();
  }
});

it.each([undefined, { width: 640, height: 400 }])(
  "keeps cached images silent and unfetched, but explains a live unavailable source (%j)",
  (dimensions) => {
    const media = vi.fn(() => undefined);
    const imageRow: ChannelMessage = {
      ...row,
      attachments: [
        {
          url: "https://image.test/unavailable.png",
          kind: "image",
          ...(dimensions ? { dimensions } : {}),
        },
      ],
    };
    const show = (cached: boolean) => {
      const list = {
        status: "ready",
        channels: [{ id: row.channelId, cached }],
      };
      const session = {
        messages: {},
        channels: { list: () => list, subscribeList: () => () => {} },
      } as unknown as RelaySession;
      return (
        <MessageRow
          row={imageRow}
          session={session}
          profile={undefined}
          media={media}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      );
    };
    const view = renderDom(show(true));
    try {
      const placeholder = view.container.querySelector(
        '[class*="attachmentImage"][aria-hidden="true"]',
      );
      expect(placeholder).not.toBeNull();
      expect(placeholder).toBeEmptyDOMElement();
      if (dimensions)
        expect(placeholder).toHaveStyle({
          width: "360px",
          aspectRatio: "640 / 400",
        });
      else expect(placeholder).not.toHaveAttribute("style");
      expect(view.container.querySelector("img, canvas, a[href]")).toBeNull();
      expect(screen.queryByText("Image unavailable")).not.toBeInTheDocument();
      view.rerender(show(false));
      const unavailable = screen.getByRole("status");
      expect(unavailable).toHaveTextContent("Image unavailable");
      if (dimensions)
        expect(unavailable).toHaveStyle({
          width: "360px",
          aspectRatio: "640 / 400",
        });
      else expect(unavailable).not.toHaveAttribute("style");
      expect(view.container.querySelector("img, canvas, a[href]")).toBeNull();
      expect(media).toHaveBeenCalledWith("https://image.test/unavailable.png");
    } finally {
      view.unmount();
    }
  },
);

it("does not bypass the session media resolver to paint an inaccessible attachment", () => {
  const media = vi.fn(() => undefined);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://image.test/original.png",
            kind: "image",
            blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          },
        ],
      }}
      profile={undefined}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(media).toHaveBeenCalledWith("https://image.test/original.png");
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("<canvas");
  expect(html).not.toContain("<img");
});

it("requests a small profile image without downsizing message attachments", () => {
  const media = vi.fn((url: string) => url);
  renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { url: "https://image.test/attachment.png", kind: "image" },
        ],
      }}
      profile={{ name: "Author", picture: "https://image.test/avatar.png" }}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );

  expect(media).toHaveBeenCalledWith("https://image.test/avatar.png", "small");
  expect(media).toHaveBeenCalledWith("https://image.test/attachment.png");
});

it("renders proxy audio attachments with an inline player", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            duration: 12,
          },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('aria-label="Play audio"');
  expect(html).toContain('aria-label="Seek audio"');
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(container.querySelector("fieldset")?.textContent).toBe("00:00 00:12");
  expect(html).not.toContain("Download file");
});

it("lets a plugin draw an image it claims, apart from the gallery", () => {
  const card = {
    id: "card",
    title: "Card",
    key: "test.plugin/card",
    pluginId: "test.plugin",
    revision: "one",
    matches: (attachment: { name?: string }) =>
      attachment.name === "Ada.agent.png",
    component: ({ source }: { source: string }) => (
      <span>card from {source}</span>
    ),
  };
  const cards = [card];
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { url: "https://image.test/one.png", kind: "image" },
          {
            url: "https://image.test/ada.png",
            kind: "image",
            name: "Ada.agent.png",
          },
          { url: "https://image.test/two.png", kind: "image" },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      extensions={{
        tools: { snapshot: () => [], subscribe: () => () => {} },
        inline: { snapshot: () => [], subscribe: () => () => {} },
        attachments: { snapshot: () => cards, subscribe: () => () => {} },
      }}
    />,
  );
  expect(html).toContain(
    "card from /api/relay/media?url=https%3A%2F%2Fimage.test%2Fada.png",
  );
  // The images around it stay pictures, each in its own group.
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(
    [...container.querySelectorAll("[data-message-attachments] > *")].map(
      (group) =>
        group.querySelector('[role="group"]')?.getAttribute("aria-label") ??
        group.textContent,
    ),
  ).toEqual([
    "1 image",
    "card from /api/relay/media?url=https%3A%2F%2Fimage.test%2Fada.png",
    "1 image",
  ]);
});

it("renders external audio sources as open file cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            name: "audio.mp3",
          },
        ],
      }}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('aria-label="Open audio.mp3"');
  expect(html).toContain("Open file");
  expect(html).not.toContain('aria-label="Play audio"');
});

it("renders missing audio sources as unavailable file cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            mime: "audio/mpeg",
          },
        ],
      }}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain("MPEG file");
  expect(html).toContain("File unavailable");
  expect(html).toContain('role="status"');
  expect(html).not.toContain('aria-label="Play audio"');
});

it.each([9, 40002])(
  "preserves copied kind %s identities through resend, fold, and profile opening without adding recipients",
  (kind) => {
    const author = keypair(),
      relay = keypair();
    const people = [keypair(), keypair()];
    const profiles = new Map(
      people.map(({ pubkey }) => [pubkey, { name: "Morgan" }]),
    );
    const copies = people.map(({ pubkey }) => {
      const [original] = foldMessages("channel", relay.pubkey, [
        signed(author, {
          kind,
          content:
            kind === 40002
              ? JSON.stringify({ content: "Hello @Morgan" })
              : "Hello @Morgan",
          tags: [
            ["h", "channel"],
            ["p", pubkey],
          ],
        }),
      ]);
      if (!original) throw new Error("missing original");
      return messageCopyText(original, profiles, []);
    });
    const content = copies.join(" and ");
    const [resent] = foldMessages("channel", relay.pubkey, [
      signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [["h", "channel"]],
      }),
    ]);
    if (!resent) throw new Error("missing resent message");
    expect(resent.mentions).toEqual([]);
    expect(messageCopyText(resent, profiles, [])).toBe(content);
    const open = vi.fn((_target: string, _origin?: unknown) => true);
    try {
      renderDom(
        <MessageRow
          row={resent}
          profile={undefined}
          participantProfiles={profiles}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      const references = screen.getAllByRole("button", {
        name: "View Morgan profile",
      });
      expect(references).toHaveLength(2);
      references.forEach((reference) => {
        fireEvent.click(reference);
        expect(document.activeElement).toBe(reference);
      });
      expect(open.mock.calls).toEqual(
        people.map(({ pubkey }) => [
          profileTarget(pubkey),
          { rootId: resent.id },
        ]),
      );
      expect(resent.mentions).toEqual([]);
    } finally {
      cleanup();
    }
  },
);

it.each([
  { replyCount: 0, threadRootId: undefined, expected: false, count: 1 },
  { replyCount: 2, threadRootId: undefined, expected: true, count: 1 },
  { replyCount: 0, threadRootId: "parent", expected: true, count: 1 },
  { replyCount: 2, threadRootId: undefined, expected: true, count: 2 },
])(
  "passes known comment state from the chat photo to its viewer: $expected",
  ({ replyCount, threadRootId, expected, count }) => {
    const attachment = {
      kind: "image" as const,
      url: "https://fixture.test/photo.png",
    };
    const open = vi.fn();
    renderDom(
      <MessageRow
        row={{
          ...row,
          attachments:
            count === 1
              ? [attachment]
              : [
                  attachment,
                  { ...attachment, url: "https://fixture.test/second.png" },
                ],
          replyCount,
          ...(threadRootId ? { threadRootId } : {}),
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        onOpenMediaReview={open}
        day={false}
        retry={undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("link", {
        name: count === 1 ? "Open image attachment" : "Open image 1 of 2",
      }),
      { detail: 1 },
    );
    expect(open).toHaveBeenCalledWith(
      row.id,
      attachment,
      0,
      expected,
      count === 1
        ? [attachment]
        : [
            attachment,
            { ...attachment, url: "https://fixture.test/second.png" },
          ],
    );
    cleanup();
  },
);

// The desktop opener's injected listener (tauri-plugin-opener 2.5.5) launches
// the system browser for any unprevented left click on an HTTP(S) anchor that
// targets `_blank` or carries Ctrl/Shift, skipping only Meta/Alt; a browser tab
// has none of the app's credentials for the raw attachment URL. Without a review
// host every activation must still open in-app, from the same media source that
// loaded the thumbnail.
it.each([
  ["plain", {}],
  ["Shift", { shiftKey: true }],
  ["Ctrl", { ctrlKey: true }],
  ["Cmd", { metaKey: true }],
])(
  "opens a photo in-app from its media source on a %s click when no review host is present",
  async (_, modifiers) => {
    const external: string[] = [];
    const opener = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey
      )
        return;
      const anchor = event
        .composedPath()
        .find(
          (node): node is HTMLAnchorElement =>
            node instanceof HTMLAnchorElement,
        );
      if (
        !anchor?.href ||
        (anchor.target !== "_blank" && !event.ctrlKey && !event.shiftKey)
      )
        return;
      if (/^https?:$/.test(anchor.protocol)) external.push(anchor.href);
    };
    window.addEventListener("click", opener);
    const view = renderMessage({
      row: {
        ...row,
        attachments: [{ kind: "image", url: "https://relay.test/media/a.png" }],
      },
      media: (url) => `http://buzz-media.localhost/${encodeURIComponent(url)}`,
    });
    try {
      const source =
        "http://buzz-media.localhost/https%3A%2F%2Frelay.test%2Fmedia%2Fa.png";
      const thumbnail = screen.getByRole("link", {
        name: "Open image attachment",
      });
      // Middle click, drag and copy on the web yield the authenticated source.
      expect(thumbnail).toHaveAttribute("href", source);
      // The browser's own new-tab default, which the opener leaves to Cmd, is
      // also cancelled.
      expect(fireEvent.click(thumbnail, { detail: 1, ...modifiers })).toBe(
        false,
      );
      const dialog = screen.getByRole("dialog", { name: "Image attachment" });
      expect(
        within(dialog).getByRole("img", { name: "Attachment preview" }),
      ).toHaveAttribute("src", source);
      expect(external).toEqual([]);
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Close fullscreen viewer" }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      // The modal boundary hands focus back on the next frame.
      await waitFor(() => expect(thumbnail).toHaveFocus());
    } finally {
      window.removeEventListener("click", opener);
      view.unmount();
    }
  },
);

it("retires the fullscreen image viewer when its retained row is suspended", () => {
  const tree = (active: boolean) => (
    <ConversationPresentation value={active}>
      <div hidden={!active} inert={!active}>
        <MessageRow
          row={{
            ...row,
            attachments: [{ kind: "image", url: "https://image.test/a.png" }],
          }}
          profile={undefined}
          media={(url) => url}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      </div>
    </ConversationPresentation>
  );
  try {
    const view = renderDom(tree(true));
    fireEvent.click(
      screen.getByRole("link", { name: "Open image attachment" }),
      { detail: 1 },
    );
    expect(
      screen.getByRole("dialog", { name: "Image attachment" }),
    ).toBeInTheDocument();
    view.rerender(tree(false));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    view.rerender(tree(true));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    cleanup();
  }
});

it.each(["peer", "own"] as const)(
  "lists Mark unread above Copy message for a managed %s message",
  async (author) => {
    const snapshot = { channels: [{ id: row.channelId }], status: "ready" };
    const operations: never[] = [];
    const session = {
      viewer: author === "own" ? row.authorId : "viewer",
      channels: {
        list: () => snapshot,
        subscribeList: () => () => {},
        window: () => ({ rows: [row] }),
      },
      messages: { report: vi.fn(async () => {}) },
      profiles: { subscribe: () => () => {}, event: () => undefined },
      outbox: {
        supports: () => true,
        subscribe: () => () => {},
        observeSend: () => () => {},
        snapshot: () => operations,
      },
      unread: {
        revision: () => 0,
        sync: () => ({ capability: "unsupported" }),
        subscribe: () => () => {},
        subscribeSync: () => () => {},
        snapshot: () => undefined,
        attention: () => ({ unread: false, forced: false, viewing: true }),
        following: () => false,
      },
    } as unknown as RelaySession;
    renderDom(
      <MessageManagement session={session} channelId={row.channelId}>
        <MessageRow
          row={{ ...row, threadRootId: "a".repeat(64) }}
          session={session}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      </MessageManagement>,
    );
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(
        author === "own"
          ? [
              "Mark unread",
              "Copy message",
              "Send to channel",
              "Copy link",
              "Delete message",
              "Follow thread",
              "Report",
            ]
          : [
              "Mark unread",
              "Copy message",
              "Copy link",
              "Follow thread",
              "Report",
            ],
      );
    } finally {
      cleanup();
    }
  },
);

it.each(["sending", "failed"] as const)(
  "does not leave an orphan menu separator on a %s own message",
  async (delivery) => {
    const snapshot = { channels: [], status: "ready" };
    const session = {
      viewer: row.authorId,
      channels: { list: () => snapshot, subscribeList: () => () => {} },
      messages: {},
      unread: {
        subscribe: () => () => {},
        subscribeSync: () => () => {},
        snapshot: () => undefined,
        following: () => false,
      },
    } as unknown as RelaySession;
    renderDom(
      <MessageRow
        row={{ ...row, delivery }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Copy message", "Copy link"]);
      expect(screen.queryByRole("separator")).toBeNull();
    } finally {
      cleanup();
    }
  },
);

// These contracts belong to the rendered row, rather than a shallow ThreadPanel fixture.
function renderMessage(
  patch: Partial<import("./MessageRow").MessageRowProps> = {},
) {
  return renderDom(
    <MessageRow
      row={row}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      {...patch}
    />,
  );
}

it.each([true, false])(
  "offers thread starts only where the conversation starts threads (startsThreads=%s)",
  (startsThreads) => {
    const agent = "a".repeat(64);
    const prompt = { ...row, id: "prompt", replyCount: 0 };
    const channels = { channels: [], status: "ready" };
    const library = { identities: [{ pubkey: agent, name: "Brain" }] };
    // Local work records a top-level prompt as its thread root.
    const typing: readonly TypingEntry[] = [
      { channelId: row.channelId, threadRootId: "prompt", pubkey: agent },
    ];
    const session = {
      channels: { list: () => channels, subscribeList: () => () => {} },
      messages: {},
      agentChoices: { snapshot: () => library, subscribe: () => () => {} },
      typing: { snapshot: () => typing, subscribe: () => () => {} },
    } as unknown as RelaySession;
    const thread = vi.fn();
    const view = renderMessage({
      row: prompt,
      viewer: row.authorId,
      session,
      onOpenThread: thread,
      startsThreads,
    });
    try {
      expect(!!screen.queryByRole("button", { name: "Reply" })).toBe(
        startsThreads,
      );
      expect(
        !!screen.queryByRole("button", { name: /^View thread.*working$/ }),
      ).toBe(startsThreads);
      // An existing thread still opens.
      view.rerender(
        <MessageRow
          row={row}
          viewer={row.authorId}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          onOpenThread={thread}
          startsThreads={startsThreads}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /^View thread: 23 replies/ }),
      );
      expect(thread).toHaveBeenCalledWith("root", "root");
      expect(!!screen.queryByRole("button", { name: "Reply" })).toBe(
        startsThreads,
      );
    } finally {
      view.unmount();
    }
  },
);

it.each([
  { startsThreads: true, replyCount: 0, thread: true },
  { startsThreads: false, replyCount: 0, thread: false },
  { startsThreads: false, replyCount: 23, thread: true },
])(
  "gives message accessories a thread only where the row has one to open (%o)",
  ({ startsThreads, replyCount, thread }) => {
    const subscribe = () => () => {};
    const channels = { channels: [], status: "ready" };
    const noTyping: never[] = [];
    const catalog = { entries: [] };
    const profiles = new Map();
    const library = { identities: [] };
    const session = {
      channels: { list: () => channels, subscribeList: subscribe },
      messages: {},
      emoji: { snapshot: () => catalog, subscribe },
      profiles: { snapshot: () => profiles, subscribe },
      agentChoices: { snapshot: () => library, subscribe },
      typing: { snapshot: () => noTyping, subscribe },
    } as unknown as RelaySession;
    const seen = vi.fn();
    const noEntries: never[] = [];
    const empty = { snapshot: () => noEntries, subscribe };
    const entries = [
      {
        id: "activity",
        key: "test:activity",
        pluginId: "test",
        revision: "1",
        title: "Agent activity",
        placement: "message" as const,
        decoratesMessageSummary: true,
        component: ({
          renderMessageSummary,
          openThread,
        }: import("../conversation/contracts").ComposerAccessoryProps) => {
          seen(!!renderMessageSummary, !!openThread);
          return (
            renderMessageSummary?.({
              participants: ["a".repeat(64)],
              content: <span>Brain working</span>,
              label: "Brain, working",
              ref: null,
            }) ?? <span>Brain working</span>
          );
        },
      },
    ];
    const view = renderMessage({
      row: { ...row, replyCount },
      session,
      scope: "test",
      onOpenThread: () => {},
      startsThreads,
      extensions: {
        inline: empty,
        links: empty,
        messages: empty,
        tools: empty,
        accessories: { snapshot: () => entries, subscribe },
      },
    });
    try {
      expect(seen).toHaveBeenLastCalledWith(thread, thread);
      expect(screen.getByText("Brain working")).toBeInTheDocument();
      expect(!!screen.queryByRole("button", { name: /^View thread/ })).toBe(
        thread,
      );
    } finally {
      view.unmount();
    }
  },
);

it("rejects attachment URLs outside the shared safe-link policy", () => {
  const media = vi.fn((url: string) => url);
  const view = renderMessage({
    row: {
      ...row,
      attachments: [
        { url: "https://safe.test/a.png", kind: "image" },
        { url: "https://user:secret@unsafe.test/a.png", kind: "image" },
        { url: "http://unsafe.test/a.png", kind: "image" },
      ],
    },
    media,
  });
  try {
    const links = screen.getAllByRole("link", {
      name: "Open image attachment",
    });
    expect(media).toHaveBeenCalledExactlyOnceWith("https://safe.test/a.png");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://safe.test/a.png");
    expect(view.container.innerHTML).not.toContain("unsafe.test");
  } finally {
    view.unmount();
  }
});

it.each([true, false])(
  "renders a stripped timecode body with seeking available=%s",
  (canSeek) => {
    const seek = vi.fn();
    const view = renderMessage({
      row: { ...row, content: "⏱ 0:42 — **Change** the title" },
      ...(canSeek ? { onMediaTime: seek } : {}),
    });
    try {
      expect(screen.getByText("Change").tagName).toBe("STRONG");
      expect(view.container).toHaveTextContent("Change the title");
      expect(view.container.textContent?.match(/0:42/g)).toHaveLength(1);
      expect(view.container).not.toHaveTextContent("⏱");
      if (canSeek) {
        fireEvent.click(screen.getByRole("button", { name: "0:42" }));
        expect(seek).toHaveBeenCalledExactlyOnceWith(42);
      } else {
        expect(screen.queryByRole("button", { name: "0:42" })).toBeNull();
        expect(screen.getByText("0:42").tagName).toBe("SPAN");
      }
    } finally {
      view.unmount();
    }
  },
);

it.each([undefined, "canonical-root"])(
  "opens the selected row with canonical root %s and retains trigger focus",
  (threadRootId) => {
    const open = vi.fn();
    const view = renderMessage({
      row: { ...row, threadRootId },
      onOpenThread: open,
    });
    try {
      const trigger = screen.getByRole("button", {
        name: "View thread: 23 replies",
      });
      fireEvent.click(trigger);
      expect(trigger).toHaveFocus();
      expect(open).toHaveBeenCalledExactlyOnceWith(
        row.id,
        threadRootId ?? row.id,
      );
    } finally {
      view.unmount();
    }
  },
);

it("shows unbadged working-agent avatars and shared dots only while a known agent types in this thread", () => {
  // The viewer's own agents come from the library; no loaded row names them.
  // Another person's agent only declares itself in its profile.
  const agent = "a".repeat(64);
  const other = "b".repeat(64);
  const foreign = "c".repeat(64);
  const cached = new Map([[foreign, { name: "Stranger", isAgent: true }]]);
  const library = {
    identities: [
      { pubkey: agent, name: "Brain", avatar: "https://safe/brain" },
      { pubkey: other, name: "Pinky" },
    ],
  };
  const listeners = new Set<() => void>();
  let entries: readonly TypingEntry[] = [
    { channelId: row.channelId, threadRootId: row.id, pubkey: agent },
    { channelId: row.channelId, threadRootId: row.id, pubkey: "human" },
    { channelId: row.channelId, threadRootId: row.id, pubkey: foreign },
    { channelId: row.channelId, threadRootId: "elsewhere", pubkey: other },
    { channelId: row.channelId, pubkey: other },
  ];
  const channels = { channels: [], status: "ready" };
  const session = {
    channels: { list: () => channels, subscribeList: () => () => {} },
    messages: {},
    profiles: { snapshot: () => cached, subscribe: () => () => {} },
    agentChoices: { snapshot: () => library, subscribe: () => () => {} },
    typing: {
      snapshot: () => entries,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as RelaySession;
  const media = vi.fn(() => "https://proxy/brain");
  let view = renderMessage({ session, media, onOpenThread: () => {} });
  try {
    const working = screen.getByRole("button", {
      name: "View thread: 23 replies. Brain working",
    });
    const indicator = working.querySelector("[data-thread-working]");
    expect(indicator).not.toBeNull();
    expect(
      indicator?.querySelectorAll('[data-avatar-shape="squircle"]'),
    ).toHaveLength(1);
    expect(indicator?.querySelector("img")).toHaveAttribute(
      "src",
      "https://proxy/brain",
    );
    expect(media).toHaveBeenCalledWith("https://safe/brain", "small");
    expect(indicator?.querySelector(".buzz-avatar-status-dot")).toBeNull();
    expect(indicator?.querySelector("i")).toBeNull();
    act(() => {
      entries = [
        { channelId: row.channelId, threadRootId: row.id, pubkey: agent },
        { channelId: row.channelId, threadRootId: row.id, pubkey: other },
      ];
      for (const listener of listeners) listener();
    });
    expect(
      indicator?.querySelectorAll('[data-avatar-shape="squircle"]'),
    ).toHaveLength(2);
    expect(working).toHaveAccessibleName(
      "View thread: 23 replies. Brain, Pinky working",
    );
    act(() => {
      entries = [
        { channelId: row.channelId, threadRootId: row.id, pubkey: agent },
      ];
      for (const listener of listeners) listener();
    });
    expect(working.querySelector("[data-thread-working]")).not.toBeNull();
    expect(working).not.toHaveTextContent(/is working|agents are working/);
    view.unmount();
    const open = vi.fn();
    view = renderMessage({
      session,
      row: { ...row, replyCount: 0, participants: [] },
      onOpenThread: open,
    });
    const first = screen.getByRole("button", {
      name: "View thread: Brain is working",
    });
    expect(first).toHaveTextContent("View thread");
    expect(first).not.toHaveTextContent("is working");
    fireEvent.click(first);
    expect(open).toHaveBeenCalledExactlyOnceWith(row.id, row.id);
    act(() => {
      entries = [];
      for (const listener of listeners) listener();
    });
    expect(screen.queryByRole("button", { name: /^View thread:/ })).toBeNull();
    view.unmount();
    view = renderMessage({ session, onOpenThread: () => {} });
    const idle = screen.getByRole("button", {
      name: "View thread: 23 replies",
    });
    expect(idle.querySelector("[data-thread-working]")).toBeNull();
  } finally {
    view.unmount();
  }
});

it("bounds reply participants and projects artwork with fallback initials", () => {
  const media = vi.fn((url: string) =>
    url === "https://safe/avatar" ? "https://proxy/avatar" : undefined,
  );
  const view = renderMessage({
    row: { ...row, participants: ["p1", "p2", "p3", "p4", "p5"] },
    participantProfiles: new Map([
      ["p1", { name: "Alice", picture: "https://safe/avatar" }],
      ["p2", { name: "Brain", picture: "http://unsafe" }],
    ]),
    media,
    onOpenThread: () => {},
  });
  try {
    const trigger = screen.getByRole("button", {
      name: "View thread: 23 replies",
    });
    expect(
      [...trigger.querySelectorAll("[title]")].map((e) =>
        e.getAttribute("title"),
      ),
    ).toEqual(["Alice", "Brain", "p3"]);
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      "https://proxy/avatar",
    );
    expect(trigger.querySelectorAll("img")).toHaveLength(1);
    expect(trigger.querySelector('[title="Brain"]')).toHaveTextContent("B");
    expect(trigger.querySelector('[title="p3"]')).toHaveTextContent("P");
    expect(trigger).toHaveTextContent("+2");
    expect(media).toHaveBeenCalledWith("https://safe/avatar", "small");
    expect(media).not.toHaveBeenCalledWith("http://unsafe", "small");
  } finally {
    view.unmount();
  }
});

it.each([1, 2, 3, 4, 5, 6, 10])(
  "caps %i images at four tiles while keeping the full gallery count",
  (count) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: Array.from({ length: count }, (_, i) => ({
            kind: "image",
            url: `https://image.test/${i}.png`,
          })),
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        onOpenMediaReview={() => {}}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(
      `role="group" aria-label="${count} ${count === 1 ? "image" : "images"}"`,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelectorAll("[data-image-grid]")).toHaveLength(
      count >= 4 ? 1 : 0,
    );
    expect(document.querySelectorAll('[role="group"] a[href]')).toHaveLength(
      Math.min(count, 4),
    );
    expect(html).toContain(
      `href="https://image.test/${Math.min(count, 4) - 1}.png"`,
    );
    if (count > 4) {
      expect(
        document.querySelector('[aria-label^="View all"]')?.textContent,
      ).toBe(`+${count - 3}`);
      expect(html).not.toContain('href="https://image.test/4.png"');
    } else {
      expect(document.querySelector('[aria-label^="View all"]')).toBeNull();
    }
    const text = new DOMParser().parseFromString(html, "text/html").body
      .textContent;
    expect(text).not.toContain(`${count} ${count === 1 ? "image" : "images"}`);
  },
);

it.each([true, false])(
  "keeps extra images reachable with gallery support: %s",
  (gallery) => {
    const attachments = Array.from({ length: 6 }, (_, i) => ({
      kind: "image" as const,
      url: `https://image.test/${i}.png`,
    }));
    const open = vi.fn();
    try {
      renderDom(
        <MessageRow
          row={{ ...row, attachments }}
          profile={undefined}
          media={(url) => (url.endsWith("3.png") && gallery ? undefined : url)}
          onOpenLink={() => false}
          {...(gallery ? { onOpenMediaReview: open } : {})}
          day={false}
          retry={undefined}
        />,
      );
      const group = screen.getByRole("group", { name: "6 images" });
      expect(group.querySelectorAll("a")).toHaveLength(gallery ? 4 : 6);
      if (gallery) {
        fireEvent.click(
          screen.getByRole("link", {
            name: "View all 6 images, starting at image 4",
          }),
        );
        expect(open).toHaveBeenCalledWith(
          row.id,
          attachments[3],
          0,
          true,
          attachments,
        );
      } else {
        expect(screen.queryByText("+3")).toBeNull();
      }
      expect(attachments).toHaveLength(6);
    } finally {
      cleanup();
    }
  },
);

it.each([
  ["video", "video", "image", "image", "image"],
  ["image", "video", "image", "video"],
  ["video", "video", "video", "video", "video", "video"],
])("groups mixed media in sender order: %j", (...kinds) => {
  const attachments = kinds.map((kind, index) => ({
    kind: kind as "image" | "video",
    url: `https://media.test/${index}.${kind === "video" ? "mp4" : "png"}`,
  }));
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, attachments }}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      onOpenMediaReview={() => {}}
      day={false}
      retry={undefined}
    />,
  );
  const document = new DOMParser().parseFromString(html, "text/html");
  const group = document.querySelector(
    `[aria-label="${attachments.length} photos and videos"]`,
  );
  expect(group).not.toBeNull();
  const links = [...(group?.querySelectorAll("a") ?? [])];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(
    attachments.slice(0, 4).map((item) => item.url),
  );
  expect(group?.querySelectorAll("[data-video-preview]")).toHaveLength(
    kinds.slice(0, 4).filter((kind) => kind === "video").length,
  );
  expect(links[3]?.textContent).toBe(
    attachments.length > 4 ? `+${attachments.length - 3}` : "",
  );
});

it("preserves interleaved file order and counts unavailable images but not unsafe URLs", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { kind: "image", url: "https://image.test/first.png" },
          { kind: "image", url: "javascript:alert(1)" },
          { kind: "image", url: "https://image.test/unavailable.png" },
          {
            kind: "file",
            url: "https://files.test/notes.md",
            name: "notes.md",
          },
          { kind: "image", url: "https://image.test/last.png" },
        ],
      }}
      profile={undefined}
      media={(url) => (url.includes("unavailable") ? undefined : url)}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('role="group" aria-label="2 images"');
  expect(html).toContain('role="group" aria-label="1 image"');
  const text = new DOMParser().parseFromString(html, "text/html").body
    .textContent;
  expect(text).not.toContain("2 images");
  expect(text).not.toContain("1 image");
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("javascript:");
  expect(html.indexOf('href="https://image.test/first.png"')).toBeLessThan(
    html.indexOf('href="https://files.test/notes.md"'),
  );
  expect(html.indexOf('href="https://files.test/notes.md"')).toBeLessThan(
    html.indexOf('href="https://image.test/last.png"'),
  );
});

it("keeps audio and video players between their original image runs", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { kind: "image", url: "https://image.test/first.png" },
          {
            kind: "audio",
            url: "https://files.test/voice.mp3",
            name: "voice.mp3",
          },
          {
            kind: "video",
            url: "https://files.test/demo.mp4",
            name: "demo.mp4",
          },
          { kind: "image", url: "https://image.test/last.png" },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html.match(/role="group" aria-label="1 image"/g)).toHaveLength(2);
  expect(html).toContain("<audio");
  expect(html).toContain("<video");
  const first = html.indexOf(
    'href="/api/relay/media?url=https%3A%2F%2Fimage.test%2Ffirst.png"',
  );
  const last = html.indexOf(
    'href="/api/relay/media?url=https%3A%2F%2Fimage.test%2Flast.png"',
  );
  expect(first).toBeGreaterThan(-1);
  expect(first).toBeLessThan(html.indexOf("<audio"));
  expect(html.indexOf("<audio")).toBeLessThan(html.indexOf("<video"));
  expect(html.indexOf("<video")).toBeLessThan(last);
});

it.each([true, false])(
  "uses smaller shared avatars without shrinking thread profile controls (clickable=%s)",
  (clickable) => {
    const props = {
      row: { ...row, authorId: "a".repeat(64) },
      profile: undefined,
      media: () => undefined,
      onOpenLink: () => false,
      canOpenLink: () => clickable,
      day: false,
      retry: undefined,
      layout: "thread" as const,
    };
    const view = renderDom(<MessageRow {...props} compactAvatar />);
    expect(view.container.querySelector(".buzz-avatar")).toHaveAttribute(
      "data-size",
      "tiny",
    );
    if (clickable) {
      expect(
        view.getByRole("button", { name: "View aaaaaaaaaa profile" }),
      ).toHaveAttribute("data-size", "sm");
    }
    view.rerender(<MessageRow {...props} />);
    expect(view.container.querySelector(".buzz-avatar")).toHaveAttribute(
      "data-size",
      "small",
    );
    view.unmount();
  },
);

it("plays native audio and voice notes through the authenticated scheme", () => {
  for (const name of [undefined, "voice note.m4a"]) {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: [
            {
              url: "https://relay.test/media/audio",
              kind: "audio",
              ...(name ? { name } : {}),
            },
          ],
        }}
        profile={undefined}
        media={() =>
          `buzz-media://localhost/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}.m4a`)}`
        }
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(`aria-label="Play ${name ?? "audio"}"`);
    expect(html).toContain("<audio");
    expect(html).not.toContain("Open file");
  }
});

it("never mounts an audio player for a native lookalike", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [{ url: "https://relay.test/audio", kind: "audio" }],
      }}
      profile={undefined}
      media={() =>
        `buzz-media://evil.test/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}.m4a`)}`
      }
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).not.toContain("<audio");
  expect(html).toContain("File unavailable");
});

it("opens the exact source thread from a shared message", () => {
  const open = vi.fn(() => true);
  const rootId = "a".repeat(64);
  try {
    renderDom(
      <MessageRow
        row={{ ...row, sentFromThread: { rootId } }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={open}
        day={false}
        retry={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Thread" }));
    expect(open).toHaveBeenCalledWith(
      `buzz://message?channel=channel&id=${rootId}&thread=${rootId}`,
      { rootId: "root" },
    );
  } finally {
    cleanup();
  }
});

it.each(["own", "other", "root", "pending", "archived", "read-only"])(
  "offers Send to channel only for a writable authored reply: %s",
  async (scenario) => {
    const snapshot = {
      channels: [
        {
          id: row.channelId,
          archived: scenario === "archived",
          readOnly: scenario === "read-only",
        },
      ],
      status: "ready",
    };
    const send = vi.fn();
    const getThreadRoot = vi.fn(() => row);
    const session = {
      viewer: row.authorId,
      channels: { list: () => snapshot, subscribeList: () => () => {} },
      messages: { sendToChannel: send },
      outbox: { supports: () => true },
      unread: {
        subscribe: () => () => {},
        subscribeSync: () => () => {},
        snapshot: () => undefined,
        following: () => false,
      },
    } as unknown as RelaySession;
    const reply: ChannelMessage = {
      ...row,
      threadRootId: scenario === "root" ? undefined : "a".repeat(64),
      authorId: scenario === "other" ? "other" : row.authorId,
      ...(scenario === "pending" ? { delivery: "sending" as const } : {}),
    };
    try {
      renderDom(
        <MessageRow
          row={reply}
          getThreadRoot={getThreadRoot}
          session={session}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />,
        { wrapper: ToastProvider },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      const item = screen.queryByRole("menuitem", { name: "Send to channel" });
      expect(!!item).toBe(scenario === "own");
      expect(getThreadRoot).not.toHaveBeenCalled();
      if (item) {
        fireEvent.click(item);
        expect(getThreadRoot).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith(reply, row);
      }
    } finally {
      cleanup();
    }
  },
);

it("dismisses an unsubmitted report when its retained row is suspended", async () => {
  const report = vi.fn(async () => {});
  const session = {
    messages: { report },
    channels: {},
    unread: {
      subscribe: () => () => {},
      subscribeSync: () => () => {},
      snapshot: () => undefined,
      following: () => false,
    },
  } as unknown as RelaySession;
  const tree = (active: boolean) => (
    <ToastProvider>
      <ConversationPresentation value={active}>
        <div hidden={!active} inert={!active}>
          <MessageRow
            row={row}
            profile={undefined}
            media={() => undefined}
            onOpenLink={() => false}
            day={false}
            retry={undefined}
            session={session}
          />
        </div>
      </ConversationPresentation>
    </ToastProvider>
  );
  try {
    const view = renderDom(tree(true));
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    const reportItem = await screen.findByRole("menuitem", { name: "Report" });
    expect(reportItem.previousElementSibling).toHaveAttribute(
      "role",
      "separator",
    );
    fireEvent.click(reportItem);
    expect(
      await screen.findByRole("dialog", { name: "Report message" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Unsubmitted note" },
    });
    view.rerender(tree(false));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    view.rerender(tree(true));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(report).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

it("presents automation, links the owner and discloses the separate relay signer", async () => {
  const ownerId = "ab".repeat(32),
    signer = "cd".repeat(32);
  const open = vi.fn(() => true);
  try {
    renderMessage({
      row: {
        ...row,
        authorId: ownerId,
        signerId: signer,
        workflowOwnerId: ownerId,
      },
      viewer: ownerId,
      profile: { name: "Wes" },
      participantProfiles: new Map([[ownerId, { name: "Wes" }]]),
      onOpenLink: open,
      canOpenLink: () => true,
    });
    expect(screen.getByText("Workflow")).toBeTruthy();
    expect(document.querySelector("[data-viewer-message]")).toBeNull();
    expect(document.querySelector("[data-own]")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "View workflow owner Wes profile" }),
    );
    expect(open).toHaveBeenCalledWith(profileTarget(ownerId), {
      rootId: "root",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Workflow message details" }),
    );
    expect(
      await screen.findByText(/the owner did not sign this message/),
    ).toBeTruthy();
    expect(
      screen.getByText("Signed by the relay").nextElementSibling,
    ).toHaveTextContent(npubEncode(signer));
    expect(
      screen.getByText("Owner public key").nextElementSibling,
    ).toHaveTextContent(npubEncode(ownerId));
    expect(
      screen.queryByRole("button", { name: "View Relay profile" }),
    ).toBeNull();
  } finally {
    cleanup();
  }
});

it("contains a broken plugin message action to its own contribution", () => {
  const listeners = new Set<() => void>();
  const entry = (
    id: string,
    marker: () => React.ReactNode,
    matches = () => true,
  ) => ({
    id,
    title: id,
    key: `test.plugin/${id}`,
    pluginId: "test.plugin",
    revision: "one",
    matches,
    icon: marker,
    component: () => null,
    marker,
  });
  const broken = () => {
    throw new Error("broken contribution");
  };
  const healthy = entry("healthy", () => <span>healthy marker</span>);
  let actions = [
    entry(
      "throwing-matcher",
      () => <span>never</span>,
      () => broken(),
    ),
    entry("throwing-marker", broken),
    healthy,
  ];
  const store = {
    snapshot: () => actions,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const swap = (next: typeof actions) => {
    actions = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  const none: never[] = [];
  const channelList = { channels: [], status: "ready" };
  const session = {
    viewer: "viewer",
    presence: {
      subscribe: () => () => {},
      status: () => "unknown",
      limited: () => false,
    },
    messages: { report: undefined },
    channels: { subscribeList: () => () => {}, list: () => channelList },
  } as unknown as RelaySession;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    renderDom(
      <MessageRow
        row={{ ...row, replyCount: 0 }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={{
          tools: { snapshot: () => none, subscribe: () => () => {} },
          inline: { snapshot: () => none, subscribe: () => () => {} },
          actions: store,
        }}
      />,
    );
    expect(screen.getByText("Root")).toBeInTheDocument();
    expect(screen.getByText("healthy marker")).toBeInTheDocument();
    expect(screen.queryByText("never")).toBeNull();
    // Disabling and re-enabling is a fresh installation with a fresh boundary.
    swap([healthy]);
    swap([entry("throwing-marker", () => <span>fixed marker</span>), healthy]);
    expect(screen.getByText("fixed marker")).toBeInTheDocument();
    expect(screen.getByText("healthy marker")).toBeInTheDocument();
  } finally {
    error.mockRestore();
    cleanup();
  }
});

it("contains a throwing plugin action icon and opened component", async () => {
  const broken = () => {
    throw new Error("broken contribution");
  };
  const entry = (
    id: string,
    icon: () => React.ReactNode,
    component: () => React.ReactNode,
  ) => ({
    id,
    title: id,
    key: `test.plugin/${id}`,
    pluginId: "test.plugin",
    revision: "one",
    matches: () => true,
    icon,
    component,
  });
  const actions = [
    entry("Broken icon", broken, () => null),
    entry("Broken component", () => <span>ok icon</span>, broken),
  ];
  const none: never[] = [];
  const empty = { snapshot: () => none, subscribe: () => () => {} };
  const channelList = { channels: [], status: "ready" };
  const session = {
    viewer: "viewer",
    presence: {
      subscribe: () => () => {},
      status: () => "unknown",
      limited: () => false,
    },
    unread: {
      subscribe: () => () => {},
      subscribeSync: () => () => {},
      snapshot: () => undefined,
      following: () => false,
    },
    messages: { report: undefined },
    channels: { subscribeList: () => () => {}, list: () => channelList },
  } as unknown as RelaySession;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    renderDom(
      <MessageRow
        row={{ ...row, replyCount: 0 }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={{
          tools: empty,
          inline: empty,
          actions: { snapshot: () => actions, subscribe: () => () => {} },
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Broken icon" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Broken component/ }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByText("Root")).toBeInTheDocument();
  } finally {
    error.mockRestore();
    cleanup();
  }
});

it("keeps a plugin action dialog closed when its plugin is reinstalled with the same key", async () => {
  const listeners = new Set<() => void>();
  const entry = () => ({
    id: "remind",
    title: "Remind",
    key: "test.plugin/remind",
    pluginId: "test.plugin",
    revision: "one",
    matches: () => true,
    component: () => <span>action dialog</span>,
  });
  let actions = [entry()];
  const swap = (next: typeof actions) => {
    actions = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  const none: never[] = [];
  const empty = { snapshot: () => none, subscribe: () => () => {} };
  const channelList = { channels: [], status: "ready" };
  const session = {
    viewer: "viewer",
    presence: {
      subscribe: () => () => {},
      status: () => "unknown",
      limited: () => false,
    },
    unread: {
      subscribe: () => () => {},
      subscribeSync: () => () => {},
      snapshot: () => undefined,
      following: () => false,
    },
    messages: { report: undefined },
    channels: { subscribeList: () => () => {}, list: () => channelList },
  } as unknown as RelaySession;
  try {
    renderDom(
      <MessageRow
        row={{ ...row, replyCount: 0 }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={{
          tools: empty,
          inline: empty,
          actions: {
            snapshot: () => actions,
            subscribe(listener: () => void) {
              listeners.add(listener);
              return () => void listeners.delete(listener);
            },
          },
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remind" }));
    expect(await screen.findByText("action dialog")).toBeInTheDocument();
    swap([]);
    expect(screen.queryByText("action dialog")).toBeNull();
    swap([entry()]);
    expect(screen.queryByText("action dialog")).toBeNull();
  } finally {
    cleanup();
  }
});

it.each(["timeline", "thread", "continuation"] as const)(
  "right-aligns own %s rows and keeps only the last grouped avatar",
  (layout) => {
    const props = {
      layout,
      row: { ...row, authorId: "ab".repeat(32) },
      viewer: "ab".repeat(32),
      profile: { name: "author" },
      media: () => undefined,
      onOpenLink: () => true,
      canOpenLink: () => true,
      day: false,
      retry: undefined,
    };
    try {
      const { container, rerender } = renderDom(
        <MessageRow {...props} stackNext />,
      );
      expect(container.querySelector("[data-own]")).toHaveTextContent("Root");
      expect(
        container.querySelector("[data-viewer-message]"),
      ).toHaveTextContent("Root");
      expect(
        screen.queryByRole("button", { name: "View author profile" }),
      ).toBeNull();
      rerender(<MessageRow {...props} stackPrevious />);
      expect(
        screen.getByRole("button", { name: "View author profile" }),
      ).toBeInTheDocument();
      expect(
        container.querySelector("[data-viewer-message]"),
      ).toHaveTextContent("Root");
      rerender(<MessageRow {...props} viewer="someone-else" />);
      expect(container.querySelector("[data-own]")).toBeNull();
      expect(container.querySelector("[data-viewer-message]")).toBeNull();
      rerender(<MessageRow {...props} viewer={undefined} />);
      expect(container.querySelector("[data-viewer-message]")).toBeNull();
    } finally {
      cleanup();
    }
  },
);

it.each(["timeline", "thread", "continuation"] as const)(
  "retains a focused grouped avatar until focus leaves in %s rows",
  (layout) => {
    const render = (stackNext: boolean) => (
      <>
        <button type="button">Elsewhere</button>
        <MessageRow
          row={{ ...row, authorId: "ab".repeat(32) }}
          profile={{ name: "author" }}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
          layout={layout}
          stackNext={stackNext}
        />
      </>
    );
    try {
      const view = renderDom(render(false));
      const avatar = screen.getByRole("button", {
        name: "View author profile",
      });
      const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
      act(() => avatar.focus());
      // Window blur retains activeElement even though the control gets blur.
      fireEvent.blur(avatar, { relatedTarget: null });
      expect(avatar).toHaveFocus();
      view.rerender(render(true));
      expect(avatar).toHaveFocus();
      act(() => elsewhere.focus());
      expect(avatar).not.toBeInTheDocument();
      expect(elsewhere).toHaveFocus();
      view.rerender(render(false));
      view.rerender(render(true));
      expect(
        screen.queryByRole("button", { name: "View author profile" }),
      ).toBeNull();
      expect(elsewhere).toHaveFocus();
    } finally {
      cleanup();
    }
  },
);

it.each(["image", "video", "file", "audio"] as const)(
  "places %s attachments outside the text bubble and omits empty bubbles",
  (kind) => {
    const props = {
      row: {
        ...row,
        content: "",
        attachments: [{ kind, url: "https://example.com/photo.png" }],
      },
      profile: undefined,
      media: () => undefined,
      onOpenLink: () => true,
      day: false,
      retry: undefined,
    };
    try {
      const { container, rerender } = renderDom(<MessageRow {...props} />);
      expect(container.querySelector("[data-own]")).toBeNull();
      expect(container.querySelector("[class*=messageBubble]")).toBeNull();
      rerender(
        <MessageRow
          {...props}
          row={{ ...props.row, content: "Photo caption" }}
        />,
      );
      const bubble = container.querySelector("[class*=messageBubble]");
      const attachments = container.querySelector(
        "[class*=messageAttachments]",
      );
      expect(bubble).toHaveTextContent("Photo caption");
      expect(attachments).not.toBeNull();
      expect(bubble?.contains(attachments)).toBe(false);
      expect(bubble?.nextElementSibling).toBe(attachments);
      expect(screen.getByText("Photo caption")).toBeInTheDocument();
    } finally {
      cleanup();
    }
  },
);

it.each([true, false])(
  "aligns only own agent-audience entries and preserves expanded prose (own=%s)",
  (own) => {
    try {
      const { container } = renderDom(
        <MessageRow
          row={{
            ...row,
            audience: "agents",
            content: "A short preview\n\nMore details.",
          }}
          viewer={own ? row.authorId : "someone-else"}
          profile={{ name: "author" }}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />,
      );
      const audience = container.querySelector('[data-audience="agents"]');
      expect(audience?.hasAttribute("data-viewer-message")).toBe(own);
      fireEvent.click(
        screen.getByRole("button", { name: "author: A short preview…" }),
      );
      expect(screen.getByText("More details.")).toBeInTheDocument();
      expect(audience?.querySelector("[data-layout]")).not.toHaveAttribute(
        "data-viewer-message",
      );
    } finally {
      cleanup();
    }
  },
);

it.each(["", "Please review this.\n\n"])(
  "places session cards outside the caption bubble and keeps message interactions (caption=%s)",
  async (caption) => {
    const content = `${caption}[Session: PR 45 fixes](buzz://channel/session-id)`;
    const reply = vi.fn(),
      thread = vi.fn(),
      open = vi.fn(() => true),
      react = vi.fn();
    try {
      const { container } = renderDom(
        <MessageRow
          row={{ ...row, content }}
          viewer={row.authorId}
          profile={undefined}
          media={() => undefined}
          onOpenLink={open}
          day={false}
          retry={undefined}
          onReply={reply}
          onOpenThread={thread}
          quickControls={
            <button type="button" onClick={react}>
              React
            </button>
          }
        />,
      );
      const card = screen.getByRole("link", {
        name: "Open Chat: PR 45 fixes",
      });
      const bubble = container.querySelector("[class*=messageBubble]");
      expect(card.closest("[data-solo-cards]")).not.toBeNull();
      expect(card.closest("[class*=messageBubble]")).toBeNull();
      if (caption) {
        if (!bubble) throw new Error("Caption bubble missing");
        expect(bubble).toHaveTextContent("Please review this.");
        expect(
          card.compareDocumentPosition(bubble) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      } else {
        expect(bubble).toBeNull();
        expect(container.querySelector("[data-bubble]")).toBeNull();
        expect(container.querySelector("[data-own]")).toBeNull();
      }
      expect(container.querySelectorAll("[data-message-id=root]")).toHaveLength(
        1,
      );
      fireEvent.click(card);
      expect(open).toHaveBeenCalledWith("buzz://channel/session-id", {
        rootId: "root",
      });
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      expect(reply).toHaveBeenCalledWith("root");
      fireEvent.click(screen.getByRole("button", { name: "React" }));
      expect(react).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("button", { name: "More message actions" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /23 replies/ }),
      ).toBeInTheDocument();
    } finally {
      cleanup();
    }
  },
);

it("keeps the timestamp seek action beside a detached session card", () => {
  const seek = vi.fn();
  try {
    renderDom(
      <MessageRow
        row={{
          ...row,
          content: "⏱ 0:42 — [Session: Fix](buzz://channel/session-id)",
        }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => true}
        day={false}
        retry={undefined}
        onMediaTime={seek}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "0:42" }));
    expect(seek).toHaveBeenCalledWith(42);
    expect(
      screen
        .getByRole("link", { name: "Open Chat: Fix" })
        .closest("[class*=messageBubble]"),
    ).toBeNull();
  } finally {
    cleanup();
  }
});

it("shows a message for agents as one line from its author to whom it addresses", () => {
  const agent = keypair();
  const rivet = "b".repeat(64);
  const tagged = (audience: string, content: string) =>
    foldMessages("channel", keypair().pubkey, [
      signed(agent, {
        kind: 9,
        content,
        created_at: 5,
        tags: [
          ["h", "channel"],
          ["p", rivet],
          ["audience", audience],
        ],
      }),
    ])[0] as ChannelMessage;
  expect(tagged("everyone", "hi").audience).toBeUndefined();
  expect(tagged("unknown", "hi").audience).toBeUndefined();
  const quiet = tagged(
    "agents",
    "@Rivet, **run** the suite\n\nThen report back to @Rivet.",
  );
  expect(quiet.audience).toBe("agents");
  try {
    renderDom(
      <MessageRow
        row={quiet}
        viewer={quiet.authorId}
        stackPrevious={false}
        stackNext={false}
        canOpenLink={() => true}
        profile={{ name: "Morgarita" }}
        participantProfiles={new Map([[rivet, { name: "Rivet" }]])}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    const line = screen.getByRole("button", {
      name: "Morgarita to Rivet: **run** the suite…",
    });
    expect(line).toHaveAttribute("aria-expanded", "false");
    const timestamp = line.parentElement?.querySelector("time");
    const timestampSlot = timestamp?.parentElement;
    expect(timestamp).toBeVisible();
    expect(
      screen.getByText(/(?:1969|1970) at /, {
        selector: 'time > span[aria-hidden="true"]',
      }),
    ).toBeVisible();
    // Reveal focuses the scroll anchor with tabIndex -1; on the button, that
    // would take the only toggle out of the Tab order.
    expect(line).not.toHaveAttribute("data-message-id");
    expect(line.parentElement).toHaveAttribute("data-message-id");
    expect(screen.queryByText(/Then report back/)).toBeNull();
    expect(line.parentElement?.querySelector("time:not(.sr-only)")).toBe(
      timestamp,
    );
    fireEvent.pointerEnter(line);
    expect(line.parentElement?.querySelector("time:not(.sr-only)")).toBe(
      timestamp,
    );
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    // Expanding preserves the timestamp node and its trailing slot, rather
    // than remounting it above the body and moving it to the opposite edge.
    expect(
      line.parentElement?.querySelectorAll("time:not(.sr-only)"),
    ).toHaveLength(1);
    expect(line.parentElement?.querySelector("time:not(.sr-only)")).toBe(
      timestamp,
    );
    expect(timestamp?.parentElement).toBe(timestampSlot);
    expect(line.parentElement?.lastElementChild).toBe(timestampSlot);
    expect(
      screen.getByText(/(?:1969|1970) at /, {
        selector: 'time > span[aria-hidden="true"]',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "View Morgarita profile" }),
    ).toBeNull();
    const expanded = screen.getByText("run").closest("[data-message-id]");
    expect(expanded?.querySelector("[data-viewer-message]")).toBeNull();
    expect(expanded?.querySelector('[class*="messageBubble"]')).toBeNull();
    expect(expanded?.querySelector("[data-own]")).toBeNull();

    expect(line.parentElement?.querySelector("time:not(.sr-only)")).toBe(
      timestamp,
    );
    fireEvent.pointerEnter(expanded ?? line);
    expect(line.parentElement?.querySelector("time:not(.sr-only)")).toBe(
      timestamp,
    );
    // Base UI binds the trigger to its panel. One stable message anchor stays
    // outside the animated content, including while that content is retiring.
    const panelId = line.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId ?? "")).toContainElement(
      screen.getByText(/Then report back/),
    );
    expect(
      document.querySelectorAll(`[data-message-id="${quiet.id}"]`),
    ).toHaveLength(1);
    expect(line.parentElement).toHaveAttribute("data-message-id", quiet.id);
    // The body keeps later mentions but drops the one the line shows.
    expect(screen.getByText(/Then report back/)).toBeInTheDocument();
    expect(screen.queryByText("@Rivet,")).toBeNull();
    expect(screen.getByText("run").tagName).toBe("STRONG");
    // Anywhere in the open box folds it back.
    fireEvent.click(screen.getByText(/Then report back/));
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(line.parentElement?.querySelector("time:not(.sr-only)")).toBe(
      timestamp,
    );
  } finally {
    cleanup();
  }
});

it.each([false, true])(
  "coordination opens its actions only from context interaction (expanded=%s)",
  async (expanded) => {
    const onReply = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: write },
    });
    const content = "@Rivet, **run** the suite\n\nThen report back.";
    try {
      renderDom(
        <ToastProvider>
          <MessageRow
            row={{
              ...row,
              content,
              mentions: ["b".repeat(64)],
              audience: "agents",
            }}
            profile={{ name: "Morgarita" }}
            participantProfiles={new Map([["b".repeat(64), { name: "Rivet" }]])}
            media={() => undefined}
            onOpenLink={() => false}
            onReply={onReply}
            day={false}
            retry={undefined}
          />
        </ToastProvider>,
      );
      const toggle = screen.getByRole("button", { name: /Morgarita to Rivet/ });
      if (expanded) fireEvent.click(toggle);
      fireEvent.pointerEnter(toggle);
      expect(
        screen.queryByRole("button", { name: "More message actions" }),
      ).toBeNull();
      expect(
        screen.queryByRole("group", { name: "Message actions" }),
      ).toBeNull();
      fireEvent.contextMenu(
        expanded ? screen.getByText(/Then report back/) : toggle,
        {
          clientX: 20,
          clientY: 20,
          button: 2,
        },
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Copy message" }),
      );
      expect(write).toHaveBeenCalledExactlyOnceWith(
        "[@Rivet](nostr:npub1hwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwasxw04hu), **run** the suite\n\nThen report back.",
      );
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
      toggle.focus();
      fireEvent.keyDown(toggle, { key: "F10", shiftKey: true });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
      await waitFor(() =>
        expect(onReply).toHaveBeenCalledExactlyOnceWith(row.id),
      );
      expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  },
);

it("keeps an agents message that opens with prose, or is only a mention, as written", () => {
  const rivet = "b".repeat(64);
  const line = (content: string) => {
    try {
      renderDom(
        <MessageRow
          row={{ ...row, content, mentions: [rivet], audience: "agents" }}
          profile={{ name: "Morgarita" }}
          participantProfiles={new Map([[rivet, { name: "Rivet" }]])}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />,
      );
      return screen.getByRole("button").getAttribute("aria-label");
    } finally {
      cleanup();
    }
  };
  expect(line("thanks @Rivet")).toBe("Morgarita: thanks @Rivet");
  expect(line("@Rivet")).toBe("Morgarita: @Rivet");
});

it.each(["available", "human", "profiles disabled", "retired"])(
  "message activity action respects exact agent and active destinations: %s",
  async (mode) => {
    const author = "ab".repeat(32);
    let retired = false;
    const target = profileActivityViewTarget(author);
    const open = vi.fn();
    const canOpen = (value: string) =>
      !retired && !(mode === "profiles disabled" && value === target);
    try {
      renderDom(
        <MessageRow
          row={{
            ...row,
            authorId: author,
            ...(mode !== "human" ? { agentEnvelope: true as const } : {}),
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={canOpen}
          day={false}
          retry={undefined}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      if (mode === "available" || mode === "retired") {
        const item = screen.getByRole("menuitem", { name: "View activity" });
        expect(item.querySelector(".buzz-menu-icon svg")).toBeInTheDocument();
        expect(screen.queryByRole("separator")).not.toBeInTheDocument();
        retired = mode === "retired";
        fireEvent.click(item);
        if (retired) expect(open).not.toHaveBeenCalled();
        else expect(open).toHaveBeenCalledWith(target);
      } else
        expect(
          screen.queryByRole("menuitem", { name: "View activity" }),
        ).not.toBeInTheDocument();
    } finally {
      cleanup();
    }
  },
);

it("keeps agent and human emoji reactions ordinary, without treating them as activity", () => {
  const agent = { id: "agent-reaction", authorId: "agent" };
  const human = { id: "human-reaction", authorId: "human" };
  const reactions = [
    { content: "👀", events: [agent, human] },
    { content: "💬", events: [agent] },
    { content: "✅", events: [agent] },
  ];
  try {
    const view = renderDom(
      <MessageRow
        row={{ ...row, reactions }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        agentPubkeys={new Set(["agent"])}
        participantProfiles={
          new Map([["agent", { name: "Other agent", isAgent: true }]])
        }
      />,
    );
    expect(view.getAllByText("👀", { exact: true })).toHaveLength(2);
    expect(view.getAllByText("💬", { exact: true })).toHaveLength(1);
    expect(view.getAllByText("✅", { exact: true })).toHaveLength(1);
    expect(
      screen.queryByRole("img", { name: "Other agent working" }),
    ).toBeNull();
  } finally {
    cleanup();
  }
});

it("lets message plugins open targets through the row's link handler", async () => {
  const contribution = <T extends object>(id: string, value: T) => ({
    id,
    title: id,
    key: `test.plugin/${id}`,
    pluginId: "test.plugin",
    revision: "one",
    ...value,
  });
  const listeners = new Set<() => void>();
  const reader = <T,>(get: () => readonly T[]) => ({
    snapshot: get,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  let retainedOpen: ((target: string) => boolean) | undefined;
  const renderer = contribution("body", {
    matches: () => true,
    component: ({
      message,
      open,
    }: {
      message: ChannelMessage;
      open(target: string): boolean;
    }) => {
      retainedOpen = open;
      return (
        <button type="button" onClick={() => open("panel:body")}>
          Body {message.content}
        </button>
      );
    },
  });
  let messages = [renderer];
  const inline = contribution("inline", {
    matches: () => [{ start: 0, end: 4 }],
    component: ({
      text,
      open,
    }: {
      text: string;
      open(target: string): boolean;
    }) => (
      <button type="button" onClick={() => open("panel:inline")}>
        Inline {text}
      </button>
    ),
  });
  const action = contribution("Open work", {
    matches: () => true,
    component: ({
      open,
      canOpen,
      close,
    }: {
      open(target: string): boolean;
      canOpen(target: string): boolean;
      close(): void;
    }) => (
      <button
        type="button"
        disabled={!canOpen("panel:action")}
        onClick={() => {
          open("panel:action");
          close();
        }}
      >
        Action open
      </button>
    ),
  });
  const none: never[] = [];
  const channelList = { channels: [], status: "ready" };
  const session = {
    viewer: "viewer",
    presence: {
      subscribe: () => () => {},
      status: () => "unknown",
      limited: () => false,
    },
    unread: {
      subscribe: () => () => {},
      subscribeSync: () => () => {},
      snapshot: () => undefined,
      following: () => false,
    },
    messages: { report: undefined },
    channels: { subscribeList: () => () => {}, list: () => channelList },
  } as unknown as RelaySession;
  const inlines = [inline];
  const actions = [action];
  const extensions = {
    tools: reader(() => none),
    inline: reader(() => inlines),
    actions: reader(() => actions),
    messages: reader(() => messages),
  };
  const open = vi.fn(() => true);
  const rowProps = {
    session,
    profile: undefined,
    media: () => undefined,
    onOpenLink: open,
    canOpenLink: (target: string) => target.startsWith("panel:"),
    day: false,
    retry: undefined,
  };
  try {
    renderDom(
      <MessageRow
        {...rowProps}
        row={{ ...row, id: "reply", threadRootId: "root", replyCount: 0 }}
        extensions={extensions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Body Root" }));
    expect(open).toHaveBeenLastCalledWith("panel:body", { rootId: "root" });
    // The whole-body renderer hides inline text; remove it to reach inline.
    messages = [];
    act(() => {
      for (const listener of listeners) listener();
    });
    open.mockClear();
    expect(retainedOpen?.("panel:body")).toBe(false);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Inline Root" }));
    expect(open).toHaveBeenLastCalledWith("panel:inline", { rootId: "root" });
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open work" }));
    const button = await screen.findByRole("button", { name: "Action open" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(open).toHaveBeenLastCalledWith("panel:action", { rootId: "root" });
  } finally {
    cleanup();
  }
});

it("keeps coordination author artwork visible across grouping and disclosure changes", () => {
  const props = {
    row: {
      ...row,
      audience: "agents" as const,
      content: "Still working on this",
    },
    profile: { name: "Working agent" },
    media: () => undefined,
    onOpenLink: () => false,
    day: false,
    retry: undefined,
  };
  const view = renderDom(<MessageRow {...props} stackPrevious={false} />);
  const authorArtwork = () =>
    view.container.querySelector(
      '[data-audience="agents"] [title="Working agent"]',
    );
  expect(authorArtwork()).not.toBeNull();
  view.rerender(<MessageRow {...props} stackPrevious />);
  expect(authorArtwork()).not.toBeNull();
  const disclosure = screen.getByRole("button", {
    name: "Working agent: Still working on this",
  });
  fireEvent.click(disclosure);
  expect(authorArtwork()).not.toBeNull();
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  expect(authorArtwork()).not.toBeNull();
  view.rerender(<MessageRow {...props} stackPrevious day />);
  expect(authorArtwork()).not.toBeNull();
  cleanup();
});

it.each([0, 23])(
  "keeps working agents in the accessible summary alongside failures (%s replies)",
  (replyCount) => {
    const workingAgent = "a".repeat(64);
    const failedAgent = "b".repeat(64);
    const subscribe = () => () => {};
    const channels = { channels: [], status: "ready" };
    const profiles = new Map();
    const library = { identities: [{ pubkey: workingAgent, name: "Brain" }] };
    const typing = [
      { channelId: row.channelId, threadRootId: row.id, pubkey: workingAgent },
    ];
    const catalog = { entries: [] };
    const session = {
      channels: { list: () => channels, subscribeList: subscribe },
      messages: {},
      emoji: { snapshot: () => catalog, subscribe },
      profiles: { snapshot: () => profiles, subscribe },
      agentChoices: { snapshot: () => library, subscribe },
      typing: { snapshot: () => typing, subscribe },
    } as unknown as RelaySession;
    const noEntries: never[] = [];
    const empty = { snapshot: () => noEntries, subscribe };
    const entries = [
      {
        id: "failed-summary",
        key: "test:failed-summary",
        pluginId: "test",
        revision: "1",
        title: "Failed activity",
        placement: "message" as const,
        decoratesMessageSummary: true,
        component: ({
          renderMessageSummary,
        }: import("../conversation/contracts").ComposerAccessoryProps) =>
          renderMessageSummary?.({
            participants: [failedAgent],
            content: <span>1 failed</span>,
            label: "Pinky failed",
            ref: null,
          }) ?? null,
      },
    ];
    const view = renderMessage({
      row: { ...row, replyCount },
      session,
      scope: "test",
      onOpenThread: () => {},
      extensions: {
        inline: empty,
        links: empty,
        messages: empty,
        tools: empty,
        accessories: { snapshot: () => entries, subscribe },
      },
    });
    try {
      const summary = screen.getByRole("button", {
        name: replyCount
          ? "View thread: 23 replies. Brain working. Pinky failed"
          : "View thread: Brain working. Pinky failed",
      });
      expect(summary).toHaveTextContent("1 failed");
      expect(summary).not.toHaveTextContent("View thread");
      if (replyCount) expect(summary).toHaveTextContent("23 replies");
      expect(
        summary.querySelector('[data-thread-working] [data-state="working"]'),
      ).not.toBeNull();
    } finally {
      view.unmount();
    }
  },
);

function styleSession(viewer: string) {
  return {
    viewer,
    channels: {
      list: () => ({ channels: [], status: "ready" }),
      subscribeList: () => () => {},
    },
    messages: {},
    unread: {
      subscribe: () => () => {},
      subscribeSync: () => () => {},
      snapshot: () => undefined,
      following: () => false,
    },
  } as unknown as RelaySession;
}
const styleTargets = (container: HTMLElement) => {
  const payload =
    container.querySelector("[data-message-action-anchor]")?.parentElement ??
    container.querySelector("[data-message-attachments]")?.parentElement;
  if (!payload?.parentElement) throw new Error("Expected a message payload");
  return {
    message: container.querySelector("[data-layout]"),
    content: payload.parentElement,
    payload,
  };
};
it.each([
  { kind: "own text", viewer: row.authorId, attachments: [], own: true },
  {
    kind: "another author's text",
    viewer: "viewer",
    attachments: [],
    own: false,
  },
  {
    kind: "own attachment-only",
    viewer: row.authorId,
    attachments: [{ kind: "image" as const, url: "https://image.test/a.png" }],
    own: false,
  },
])(
  "marks $kind rows for own-message, bubble and attachment styling",
  ({ viewer, attachments, own }) => {
    const { container } = renderDom(
      <MessageRow
        row={{
          ...row,
          content: attachments.length ? "" : row.content,
          attachments,
        }}
        session={styleSession(viewer)}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    try {
      const { message, content, payload } = styleTargets(container);
      const bubble = attachments.length === 0;
      expect(message?.hasAttribute("data-own")).toBe(own);
      expect(content.hasAttribute("data-bubble")).toBe(bubble);
      expect(payload.hasAttribute("data-attachments")).toBe(!bubble);
    } finally {
      cleanup();
    }
  },
);
it("keeps own-message and bubble styling off a shown thread root", () => {
  const { container } = renderDom(
    <MessageRow
      row={{ ...row, audience: "agents" }}
      session={styleSession(row.authorId)}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  try {
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const { message, content } = styleTargets(container);
    expect(message).not.toHaveAttribute("data-own");
    expect(content).not.toHaveAttribute("data-bubble");
  } finally {
    cleanup();
  }
});

it.each([
  {
    claim: undefined,
    fails: false,
    card: true,
    listed: ["notes.txt", "shot.png"],
  },
  { claim: "shot", fails: false, card: true, listed: ["notes.txt"] },
  {
    claim: "throws",
    fails: false,
    card: true,
    listed: ["notes.txt", "shot.png"],
  },
  {
    claim: "shot",
    fails: true,
    card: false,
    listed: ["notes.txt", "shot.png"],
  },
  // The host skips the message body here, so the card never mounts.
  {
    claim: "shot",
    fails: false,
    card: false,
    listed: ["notes.txt", "shot.png"],
    content: "",
  },
  {
    claim: "shot",
    fails: false,
    card: false,
    listed: ["notes.txt", "shot.png"],
    content: "[Session: PR 45 fixes](buzz://channel/session-id)",
  },
])(
  "lists only the attachments a message renderer does not claim: %o",
  ({ claim, fails, card, listed, content }) => {
    const entry = {
      id: "card",
      title: "Card",
      key: "fixture.card:card",
      pluginId: "fixture.card",
      revision: "one",
      matches: () => true,
      ...(claim
        ? {
            ownsAttachment: (
              _message: unknown,
              attachment: { url: string },
            ) => {
              if (claim === "throws") throw new Error("broken claim");
              return attachment.url.endsWith("shot.png");
            },
          }
        : {}),
      component: () => {
        if (fails) throw new Error("broken renderer");
        return <p>Plugin card</p>;
      },
    };
    // Stable snapshots: useSyncExternalStore rereads on every render.
    const none: never[] = [];
    const entries = [entry];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = renderDom(
      <MessageRow
        row={{
          ...row,
          ...(content === undefined ? {} : { content }),
          replyCount: 0,
          attachments: [
            {
              kind: "file",
              url: "https://media.test/notes.txt",
              name: "notes.txt",
            },
            {
              kind: "file",
              url: "https://media.test/shot.png",
              name: "shot.png",
            },
          ],
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={{
          tools: { snapshot: () => none, subscribe: () => () => {} },
          inline: { snapshot: () => none, subscribe: () => () => {} },
          messages: { snapshot: () => entries, subscribe: () => () => {} },
        }}
      />,
    );
    try {
      expect(!!screen.queryByText("Plugin card")).toBe(card);
      expect(!!screen.queryByText("Root")).toBe(!card && content === undefined);
      for (const name of ["notes.txt", "shot.png"])
        expect(screen.queryAllByText(name)).toHaveLength(
          listed.includes(name) ? 1 : 0,
        );
    } finally {
      view.unmount();
      error.mockRestore();
    }
  },
);

it("returns claimed attachments when a card fails late and claims again after reinstall", () => {
  let fail = false;
  const install = (revision: string) => ({
    id: "card",
    title: "Card",
    key: `fixture.card:card:${revision}`,
    pluginId: "fixture.card",
    revision,
    matches: () => true,
    ownsAttachment: (_message: unknown, attachment: { url: string }) =>
      attachment.url.endsWith("shot.png"),
    component: () => {
      if (fail) throw new Error("broken renderer");
      return <p>Plugin card</p>;
    },
  });
  // Stable snapshots: useSyncExternalStore rereads on every render.
  const none: never[] = [];
  let entries = [install("one")];
  const listeners = new Set<() => void>();
  const messages = {
    snapshot: () => entries,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const update = (next: typeof entries) =>
    act(() => {
      entries = next;
      for (const listener of listeners) listener();
    });
  const message = {
    ...row,
    replyCount: 0,
    attachments: [
      {
        kind: "file" as const,
        url: "https://media.test/notes.txt",
        name: "notes.txt",
      },
      {
        kind: "file" as const,
        url: "https://media.test/shot.png",
        name: "shot.png",
      },
    ],
  };
  const extensions = {
    tools: { snapshot: () => none, subscribe: () => () => {} },
    inline: { snapshot: () => none, subscribe: () => () => {} },
    messages,
  };
  const render = (next: typeof message) => (
    <MessageRow
      row={next}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      extensions={extensions}
    />
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = renderDom(render(message));
  const listed = (name: string) => screen.queryAllByText(name).length;
  try {
    expect(screen.getByText("Plugin card")).toBeInTheDocument();
    expect(listed("shot.png")).toBe(0);

    // The same registration fails on a later render.
    fail = true;
    view.rerender(render({ ...message }));
    expect(screen.queryByText("Plugin card")).toBeNull();
    expect(screen.getByText("Root")).toBeInTheDocument();
    expect(listed("shot.png")).toBe(1);
    expect(listed("notes.txt")).toBe(1);

    // A reinstalled plugin is a new registration and gets a fresh start.
    fail = false;
    update([install("two")]);
    expect(screen.getByText("Plugin card")).toBeInTheDocument();
    expect(listed("shot.png")).toBe(0);
    expect(listed("notes.txt")).toBe(1);

    // Removing the plugin lists every attachment again.
    update([]);
    expect(screen.queryByText("Plugin card")).toBeNull();
    expect(listed("shot.png")).toBe(1);
  } finally {
    view.unmount();
    error.mockRestore();
  }
});

it.each(["unmatched", "collapsed"] as const)(
  "claims attachments again when a failed card remounts healthy (%s)",
  async (unmount) => {
    let fail = true;
    const entry = {
      id: "card",
      title: "Card",
      key: "fixture.card:card",
      pluginId: "fixture.card",
      revision: "one",
      matches: (message: { content: string }) =>
        message.content.includes("card"),
      ownsAttachment: (_message: unknown, attachment: { url: string }) =>
        attachment.url.endsWith("shot.png"),
      component: () => {
        if (fail) throw new Error("broken renderer");
        return <p>Plugin card</p>;
      },
    };
    // Stable snapshots: useSyncExternalStore rereads on every render.
    const none: never[] = [];
    const entries = [entry];
    const extensions = {
      tools: { snapshot: () => none, subscribe: () => () => {} },
      inline: { snapshot: () => none, subscribe: () => () => {} },
      messages: { snapshot: () => entries, subscribe: () => () => {} },
    };
    const message = {
      ...row,
      content: "A card",
      replyCount: 0,
      ...(unmount === "collapsed" ? { audience: "agents" as const } : {}),
      attachments: [
        {
          kind: "file" as const,
          url: "https://media.test/shot.png",
          name: "shot.png",
        },
      ],
    };
    const render = (next: typeof message) => (
      <MessageRow
        row={next}
        profile={{ name: "author" }}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={extensions}
      />
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = renderDom(render(message));
    const toggle = () =>
      fireEvent.click(screen.getByRole("button", { name: /^author: A card/ }));
    const listed = () => screen.queryAllByText("shot.png").length;
    try {
      if (unmount === "collapsed") toggle();
      expect(screen.queryByText("Plugin card")).toBeNull();
      expect(listed()).toBe(1);

      fail = false;
      if (unmount === "unmatched") {
        // An edit stops the match, then a later edit matches again.
        view.rerender(render({ ...message, content: "A note" }));
        expect(listed()).toBe(1);
        view.rerender(render({ ...message }));
      } else {
        // Closing to completion unmounts the panel; reopening remounts it.
        toggle();
        await waitFor(() => expect(listed()).toBe(0));
        expect(screen.getAllByText("A card")).toHaveLength(1);
        toggle();
      }
      expect(screen.getByText("Plugin card")).toBeInTheDocument();
      expect(listed()).toBe(0);
    } finally {
      view.unmount();
      error.mockRestore();
    }
  },
);

it("keeps a failed card's attachments listed under StrictMode", () => {
  const entry = {
    id: "card",
    title: "Card",
    key: "fixture.card:card",
    pluginId: "fixture.card",
    revision: "one",
    matches: (message: { content: string }) => message.content.includes("card"),
    ownsAttachment: (_message: unknown, attachment: { url: string }) =>
      attachment.url.endsWith("shot.png"),
    component: () => {
      throw new Error("broken renderer");
    },
  };
  const none: never[] = [];
  const entries = [entry];
  const extensions = {
    tools: { snapshot: () => none, subscribe: () => () => {} },
    inline: { snapshot: () => none, subscribe: () => () => {} },
    messages: { snapshot: () => entries, subscribe: () => () => {} },
  };
  const message = {
    ...row,
    content: "A card",
    replyCount: 0,
    attachments: [
      {
        kind: "file" as const,
        url: "https://media.test/shot.png",
        name: "shot.png",
      },
    ],
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  // StrictMode replays mount effects: unmount, then mount the same failed boundary.
  const view = renderDom(
    <StrictMode>
      <MessageRow
        row={message}
        profile={{ name: "author" }}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={extensions}
      />
    </StrictMode>,
  );
  try {
    expect(screen.queryByText("Plugin card")).toBeNull();
    expect(screen.queryAllByText("shot.png")).toHaveLength(1);
  } finally {
    view.unmount();
    error.mockRestore();
  }
});

const listed = { channels: [], status: "ready" };

it.each([
  {
    case: "signed owner",
    forged: false,
    viewer: undefined,
    label: "Logan’s agent",
  },
  // The viewer's own agent shows only the mark.
  { case: "viewer's agent", forged: false, viewer: "owner", label: undefined },
  { case: "forged owner", forged: true, viewer: undefined, label: undefined },
])(
  "names an agent's owner from its signed profile ($case)",
  async ({ forged, viewer, label }) => {
    const agent = keypair();
    const owner = keypair();
    const signer = forged ? keypair() : owner;
    const conditions = "";
    const sig = bytesToHex(
      schnorr.sign(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              `nostr:agent-auth:${agent.pubkey}:${conditions}`,
            ),
          ),
        ),
        signer.secret,
      ),
    );
    // Relay-read events carry signature proof; only those get an owner check.
    const head = eventDto(
      signed(agent, {
        kind: 0,
        content: JSON.stringify({ name: "Quinn" }),
        tags: [["auth", owner.pubkey, conditions, sig]],
      }),
    );
    const quinn: Profile = { name: "Quinn", isAgent: true };
    const verifications = vi.mocked(attestedOwner);
    verifications.mockClear();
    // The owner's name arrives after verification, as a background load.
    const read = vi.fn(async () => {
      // Later than the render that requested it, so only a subscription shows it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return [profileEvent(owner, { name: "Logan" })];
    });
    const directory = createProfileDirectory({ read });
    directory.accept([head]);
    const subscribe = () => () => {};
    const session = {
      channels: { list: () => listed, subscribeList: subscribe },
      messages: {},
      profiles: directory.queries,
    } as unknown as RelaySession;
    const view = renderMessage({
      row: { ...row, authorId: agent.pubkey },
      profile: quinn,
      // Timelines pass row-selected profiles, which never include the owner.
      participantProfiles: new Map([[agent.pubkey, quinn]]),
      session,
      viewer: viewer === "owner" ? owner.pubkey : row.authorId,
    });
    try {
      const byline = view.container.querySelector("strong")?.parentElement;
      // The mention-chip agent mark sits beside the name either way.
      expect(byline?.querySelector("svg")).not.toBeNull();
      expect(verifications).toHaveBeenCalledWith(head);
      // Barrier: the real signature check has returned its verdict.
      await act(async () => {
        await verifications.mock.results[0]?.value;
      });
      const ownerRead = [
        [{ kinds: [0], authors: [owner.pubkey], limit: 500 }],
        expect.objectContaining({ priority: "background" }),
      ];
      if (label) {
        await waitFor(() =>
          expect(view.container).toHaveTextContent(`Quinn· ${label}`),
        );
        expect(read).toHaveBeenCalledWith(...ownerRead);
      } else if (viewer === "owner") {
        await expect(verifications.mock.results[0]?.value).resolves.toBe(
          owner.pubkey,
        );
        // Barrier: the owner's name has loaded, so a label would show now.
        await waitFor(() =>
          expect(directory.queries.snapshot().has(owner.pubkey)).toBe(true),
        );
        expect(view.container).not.toHaveTextContent("agent");
      } else {
        await expect(verifications.mock.results[0]?.value).resolves.toBe(
          undefined,
        );
        expect(view.container).not.toHaveTextContent("agent");
        expect(read).not.toHaveBeenCalled();
      }
    } finally {
      view.unmount();
      directory.dispose();
    }
  },
);

it("shows no agent mark or owner for a person", () => {
  const event = vi.fn();
  const subscribe = () => () => {};
  const none = new Map();
  const session = {
    channels: { list: () => listed, subscribeList: subscribe },
    messages: {},
    profiles: { snapshot: () => none, subscribe, event, ensure: vi.fn() },
  } as unknown as RelaySession;
  const view = renderMessage({ session, profile: { name: "Ana" } });
  try {
    expect(
      view.container
        .querySelector("strong")
        ?.parentElement?.querySelector("svg"),
    ).toBeNull();
    expect(event).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("marks an edited body after its last line, and leaves an unedited one unmarked", () => {
  const render = (content: string, edited: boolean) =>
    renderDom(
      <MessageRow
        row={{ ...row, content, ...(edited ? { edited: true as const } : {}) }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
  try {
    render("First\n\nHi how are ya.", true);
    const inline = screen.getByText("(edited)");
    expect(inline.parentElement?.tagName).toBe("P");
    expect(inline.parentElement).toHaveTextContent("Hi how are ya. (edited)");
    expect(inline.parentElement?.nextElementSibling).toBeNull();
    cleanup();

    render("Intro\n\n```\ncode\n```", true);
    const block = screen.getByText("(edited)");
    expect(block.previousElementSibling?.tagName).toBe("PRE");
    expect(block.closest("pre, p")).toBeNull();
    cleanup();

    render("See the note.[^1]\n\n[^1]: Footnote text.", true);
    expect(screen.getByText("(edited)").previousElementSibling?.tagName).toBe(
      "SECTION",
    );
    cleanup();

    render("Read [the doc][d].\n\n[d]: https://example.com", true);
    expect(screen.getByText("(edited)").parentElement?.tagName).toBe("P");
    cleanup();

    render("- one\n- two", true);
    const item = screen.getByText("(edited)").parentElement;
    expect(item?.tagName).toBe("LI");
    expect(item).toHaveTextContent("two (edited)");
    cleanup();

    render("> quoted line", true);
    const quoted = screen.getByText("(edited)").parentElement;
    expect(quoted?.tagName).toBe("P");
    expect(quoted?.parentElement?.tagName).toBe("BLOCKQUOTE");
    cleanup();

    // The unboxed table styling selects `table:first-child + .edited:last-child`.
    render("| Day | Room |\n| --- | --- |\n| Thu | 4B |", true);
    const afterTable = screen.getByText("(edited)");
    expect(afterTable.previousElementSibling?.tagName).toBe("TABLE");
    expect(afterTable.parentElement?.firstElementChild?.tagName).toBe("TABLE");
    expect(afterTable.nextElementSibling).toBeNull();
    cleanup();

    render("🎉", true);
    expect(screen.getByText("(edited)").parentElement).toHaveAttribute(
      "data-single-emoji",
    );
    cleanup();

    renderDom(
      <MessageRow
        row={{
          ...row,
          content: "",
          edited: true,
          attachments: [
            { url: "https://example.com/notes.txt", kind: "file" as const },
          ],
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(screen.getByText("(edited)").previousElementSibling).toHaveAttribute(
      "data-message-attachments",
    );
    cleanup();

    renderDom(
      <MessageRow
        row={{
          ...row,
          content: "+changed",
          edited: true,
          diff: { filePath: "a.ts", truncated: false },
        }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(screen.getByText("(edited)").closest("pre")).toBeNull();
    cleanup();

    renderDom(
      <MessageRow
        row={{ ...row, content: "Done", edited: true, audience: "agents" }}
        profile={{ name: "Morgarita" }}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    const line = screen.getByRole("button", {
      name: "Morgarita: Done (edited)",
    });
    expect(within(line).getByText("(edited)")).toBeInTheDocument();
    fireEvent.click(line);
    expect(screen.getAllByText("(edited)")).toHaveLength(1);
    expect(line).not.toContainElement(screen.getByText("(edited)"));
    cleanup();

    const none: never[] = [];
    const cards = [
      {
        id: "card",
        title: "Card",
        key: "fixture.card:card",
        pluginId: "fixture.card",
        revision: "one",
        matches: () => true,
        component: () => <p>Plugin card</p>,
      },
    ];
    renderDom(
      <MessageRow
        row={{ ...row, content: "Card body", edited: true }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={{
          tools: { snapshot: () => none, subscribe: () => () => {} },
          inline: { snapshot: () => none, subscribe: () => () => {} },
          messages: { snapshot: () => cards, subscribe: () => () => {} },
        }}
      />,
    );
    // Inside the card's bubble, so above any reactions it holds.
    expect(screen.getByText("(edited)").parentElement).toBe(
      screen.getByText("Plugin card").closest("[data-message-action-anchor]"),
    );
    cleanup();

    render("Hi how are ya.", false);
    expect(screen.queryByText("(edited)")).toBeNull();
  } finally {
    cleanup();
  }
});

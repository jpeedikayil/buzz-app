import { huddleDescription } from "../huddle/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import type {
  SidebarDecoder,
  SidebarMuteMutator,
} from "../relay/sidebar-preferences";
import {
  keypair,
  metadata,
  message,
  profile,
  roster,
  signed,
  flush,
} from "../relay/testing";
import { cleanups, setup } from "./messages-testing";

afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
});
it("does not notify workflow owners for another recipient, but still notifies explicit owner mentions", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
  const h = await setup();
  const tags = [
    ["p", h.viewer.pubkey],
    ["p", h.peer.pubkey],
    ["buzz:workflow", "true"],
    ["buzz:workflow-owner", h.viewer.pubkey],
    ["buzz:workflow-mention", h.peer.pubkey],
  ];
  const output = message(
    h.relay,
    "room",
    "@Westie do the work",
    1_780_000_000,
    tags,
  );
  h.emit([output], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  const explicit = message(
    h.relay,
    "room",
    "@Wes review the result",
    1_780_000_000,
    [...tags, ["buzz:workflow-mention", h.viewer.pubkey]],
  );
  h.emit([explicit], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("@Wes review the result");
  h.click();
  expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
    messageId: explicit.id,
  });
});

it("lets local Solo completion feedback replace the agent reply's mention alert", async () => {
  const h = await setup();
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
    conversationName: "Planning",
  });
  run.started();
  const reply = h.make("Done");
  const sent = run.sending();
  h.emit([reply], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  run.reply(reply.id);
  sent();

  run.finish({ ok: true });
  h.emit([h.make("A later message")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("defers progress and final echoes until each publish is correlated", async () => {
  const h = await setup();
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
    conversationName: "Planning",
  });
  run.started();
  for (const text of ["Working", "Done"]) {
    const reply = h.make(text);
    const sent = run.sending();
    h.emit([reply], "live");
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    run.reply(reply.id);
    sent();
    await flush();
    expect(h.show).not.toHaveBeenCalled();
  }
  run.finish({ ok: true });
  h.emit([h.make("Unrelated later message")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("releases a same-agent message that does not match the in-flight publish", async () => {
  const h = await setup();
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
  });
  run.started();
  const unrelated = h.make("Unrelated while publishing");
  const sent = run.sending();
  h.emit([unrelated], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  run.reply(h.make("Actual reply").id);
  sent();
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("Unrelated while publishing");
});

it("suppresses the correlated final reply when it arrives just after local completion", async () => {
  const h = await setup();
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
    conversationName: "Planning",
  });
  run.started();
  const reply = h.make("Done after settlement");
  run.reply(reply.id);
  run.finish({ ok: true });
  h.emit([reply], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();

  h.emit([h.make("Unrelated later message")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("suppresses an earlier locally published reply after a later reply is recorded", async () => {
  const startedAt = 1_780_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(startedAt);
  const h = await setup();
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
    conversationName: "Planning",
  });
  run.started();
  const progress = h.make("Working");
  run.reply(progress.id);
  for (let i = 0; i < 40; i++) run.reply(h.make(`Update ${i}`).id);
  run.finish({ ok: true });

  vi.mocked(Date.now).mockReturnValue(startedAt + 5_000);
  h.emit([progress], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();

  h.emit([h.make("Unrelated later message")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("keeps thread replies from the same agent during local Solo work", async () => {
  const h = await setup();
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
    conversationName: "Planning",
  });
  run.started();
  const now = Math.floor(Date.now() / 1000);
  const root = message(h.viewer, "room", "Own thread", now - 1);
  h.emit([root], "replay");
  h.emit(
    [
      message(h.peer, "room", "Thread reply", now, [
        ["e", root.id, "", "reply"],
      ]),
    ],
    "live",
  );
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].title).toContain("replied in");
});

it("keeps ordinary mentions from the same agent when the local work is not confirmed Solo", async () => {
  const h = await setup();
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
  });
  run.started();
  h.emit([h.make("Review this")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("does not suppress a same-channel agent mention from another community", async () => {
  const h = await setup();
  const run = h.activity.begin({
    scope: `https://other.example:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
    conversationName: "Elsewhere",
  });
  run.started();
  h.emit([h.make("Mention in this community")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("never alerts for coordination between agents, even when it mentions the viewer", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
  const h = await setup();
  const tags = [["p", h.viewer.pubkey]];
  h.emit(
    [
      message(h.relay, "room", "@Wes run the suite", 1_780_000_000, [
        ...tags,
        ["audience", "agents"],
      ]),
    ],
    "live",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.emit(
    [message(h.relay, "room", "@Wes the suite passed", 1_780_000_000, tags)],
    "live",
  );
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("@Wes the suite passed");
});

it.each([9, 40002])(
  "only production live kind-%s traffic can notify, never history/replay/local observation",
  async (kind) => {
    // Keep second-rounded fixtures outside the cutoff while signing/admitting.
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const h = await setup();
    const original = h.make;
    h.make = (text, age = 0, author = h.peer) =>
      signed(author, { ...original(text, age, author), kind });
    const historic = h.make("finite");
    h.query.mockResolvedValueOnce([historic]);
    await h.owner.session.read([{ ids: [historic.id], limit: 1 }]);
    h.emit([historic], "live");
    h.emit([h.make("legacy")]);
    h.emit([h.make("replay")], "replay");
    h.emit([h.make("wrong route")], "live", "elsewhere");
    h.emit(
      [h.make("stale", 121), h.make("future", -31), h.make("own", 0, h.viewer)],
      "live",
    );
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    const fresh = h.make("fresh");
    h.emit([fresh, fresh], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
    h.click();
    expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
      messageId: fresh.id,
    });
    expect(h.owner.session.unread.attention("room", fresh.id).unread).toBe(
      true,
    );
  },
);
it.each(
  [9, 40002].flatMap((kind) =>
    [
      { age: -30001, allowed: false },
      { age: -30000, allowed: true },
      { age: 120000, allowed: true },
      { age: 120001, allowed: false },
    ].map((boundary) => ({ kind, ...boundary })),
  ),
)(
  "live kind-$kind at age $age ms: notification allowed=$allowed",
  async ({ kind, age, allowed }) => {
    const createdAt = 1_780_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt * 1000 + age);
    const h = await setup();
    h.emit(
      [
        signed(h.peer, {
          kind,
          created_at: createdAt,
          content: "boundary",
          tags: [
            ["h", "room"],
            ["p", h.viewer.pubkey],
          ],
        }),
      ],
      "live",
    );
    await flush();
    expect(h.show).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);
it("live membership activity and observer telemetry never become message notifications", async () => {
  const h = await setup();
  h.emit(
    [
      signed(h.relay, {
        kind: 40099,
        content: JSON.stringify({
          type: "member_joined",
          actor: h.viewer.pubkey,
          target: h.peer.pubkey,
        }),
        tags: [
          ["h", "room"],
          ["p", h.viewer.pubkey],
        ],
      }),
      signed(h.peer, {
        kind: 24200,
        content: "opaque",
        tags: [
          ["h", "room"],
          ["p", h.viewer.pubkey],
        ],
      }),
    ],
    "live",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.emit([h.make("fresh after activity")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
});

it("viewing suppression uses the shared lease, and suppressed candidates never become delayed alerts", async () => {
  const h = await setup();
  const row = h.make("visible");
  const lease = h.owner.session.unread.reading("room");
  const view = h.owner.session.observe([
    { kinds: [9], "#h": ["room"], limit: 50 },
  ]);
  view.subscribe(() => lease.view([row.id], () => true));
  h.emit([row], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  lease.dispose();
  await h.notifications.requestPermission();
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.notifications.updatePreferences({ notifyWhileViewing: true });
  const next = h.make("visible allowed");
  const visible = h.owner.session.unread.reading("room");
  view.subscribe(() => visible.view([next.id], () => true));
  h.emit([next], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  visible.dispose();
  view.dispose();
});
it("community switching stops new production but keeps prior scoped click intent", async () => {
  const h = await setup();
  const row = h.make("fresh");
  h.emit([row], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  h.deselect();
  h.click();
  // The real host navigation will select/check the target community and channel;
  // this service must not silently discard it because another community is selected.
  expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
    kind: "conversation",
    messageId: row.id,
    scope: { viewer: h.viewer.pubkey },
  });
  h.emit([h.make("unselected")], "live");
  await flush();
  expect(h.show).toHaveBeenCalledTimes(1);
});
it("authorized deletions in the same live batch cannot generate an alert", async () => {
  const h = await setup();
  const row = h.make("deleted");
  h.emit(
    [
      row,
      signed(h.peer, {
        kind: 5,
        tags: [["e", row.id]],
        content: "",
        created_at: row.created_at,
      }),
    ],
    "live",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
});

it("review: fresh incoming alert waits for initial unread readiness rather than becoming permanently quiet", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(ready);
  try {
    expect(h.owner.session.unread.sync().status).toBe("loading");
    const row = h.make("arrived during startup");
    h.emit([row], "live");
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    release();
    await flush();
    expect(h.owner.session.unread.sync().status).toBe("local");
    expect(h.owner.session.unread.attention("room", row.id)).toMatchObject({
      status: "eligible",
      unread: true,
    });
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  } finally {
    release();
  }
});

it.each([
  "already-read",
  "expired",
  "revoked",
  "muted",
  "viewed",
  "switched",
] as const)(
  "a loading live candidate stays quiet after readiness when %s",
  async (condition) => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const now = Date.now();
    const h = await setup(
      barrier,
      condition === "already-read" ? Math.floor(now / 1000) + 10 : undefined,
    );
    try {
      const row = h.make("pending at startup");
      h.emit([row], "live");
      await flush();
      if (condition === "expired")
        vi.spyOn(Date, "now").mockReturnValue(now + 121000);
      if (condition === "revoked")
        h.emit([roster(h.relay, "room", [], Math.floor(now / 1000))]);
      if (condition === "muted")
        h.notifications.updatePreferences({ enabled: false });
      if (condition === "switched") h.deselect();
      if (condition === "viewed") {
        const lease = h.owner.session.unread.reading("room");
        lease.view([row.id], () => true);
        cleanups.push(lease.dispose);
      }
      release();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      await h.notifications.requestPermission();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);

it("review: channel revoke/regrant plus history restoration must not revive a pending live alert", async () => {
  const h = await setup();
  let finish!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const row = h.make("pending before access removal");
  h.emit([row], "live");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const now = Math.floor(Date.now() / 1000);
  h.emit([roster(h.relay, "room", [], now + 1)]);
  h.emit([roster(h.relay, "room", [h.viewer.pubkey], now + 2)]);
  h.query.mockResolvedValueOnce([row]);
  await h.owner.session.read([{ ids: [row.id], limit: 1 }]);
  expect(h.owner.session.unread.attention("room", row.id)).toMatchObject({
    status: "eligible",
    unread: true,
  });
  finish("granted");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
});

it("live message wiring supplies the signed author and body, resolving names at delivery without extra reads", async () => {
  const h = await setup();
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const row = h.make("**Hello** [Wes](https://example.com/private)");
  h.emit([row], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  // Profile can arrive from the existing shared stream while permission is pending.
  h.emit([profile(h.peer, { display_name: "Pinky" })]);
  release("granted");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0]).toMatchObject({
    title: "Pinky mentioned you in #Room",
    body: "Hello Wes",
  });
  expect(h.query.mock.calls.map(([filters]) => filters)).toEqual([
    [{ authors: [h.viewer.pubkey], kinds: [30175, 30177], limit: 200 }],
  ]);
});

it.each([
  [9, "direct"],
  [9, "thread"],
  [40002, "direct"],
  [40002, "thread"],
] as const)(
  "live kind-%s %s messages carry the correct title and preview",
  async (kind, category) => {
    const h = await setup();
    h.emit([profile(h.peer, { name: "Pinky" })]);
    const now = Math.floor(Date.now() / 1000);
    const root = message(h.viewer, "room", "Own thread", now - 1);
    if (category === "direct") {
      h.emit([
        signed(h.relay, {
          kind: 39000,
          content: JSON.stringify({
            name: "internal-dm-id",
            channel_type: "dm",
          }),
          tags: [
            ["d", "room"],
            ["name", "internal-dm-id"],
            ["t", "dm"],
          ],
          created_at: now,
        }),
      ]);
    } else h.emit([root], "replay");
    const row = signed(h.peer, {
      kind,
      content:
        kind === 40002
          ? JSON.stringify({ content: "A **new** reply" })
          : "A **new** reply",
      created_at: now,
      tags: [
        ["h", "room"],
        ...(category === "thread" ? [["e", root.id, "", "reply"]] : []),
      ],
    });
    h.emit([row], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0]).toMatchObject({
      title:
        category === "direct"
          ? "Pinky sent you a direct message"
          : "Pinky replied in #Room",
      body: "A new reply",
    });
  },
);

it("classifies p-tagged DM messages as direct, not mention", async () => {
  const h = await setup();
  h.emit([profile(h.peer, { name: "Pinky" })]);
  const now = Math.floor(Date.now() / 1000);
  h.emit([
    signed(h.relay, {
      kind: 39000,
      content: JSON.stringify({ name: "internal-dm-id", channel_type: "dm" }),
      tags: [
        ["d", "room"],
        ["name", "internal-dm-id"],
        ["t", "dm"],
      ],
      created_at: now,
    }),
  ]);
  // Agent and CLI DM traffic p-tags the recipient; that must not reroute the
  // message to the mention category (label, sound, and preference toggle).
  h.emit([h.make("hello")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].title).toBe(
    "Pinky sent you a direct message",
  );
});

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([
  ["bounded", false],
  ["bounded", true],
  ["snapshot", false],
  ["snapshot", true],
] as const)(
  "waits for %s remote marker merge (Channels consumer=%s), then revalidates retained live candidates",
  async (observation, channelsMounted) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const marker = deferred(),
      merge = deferred();
    const h = await setup(Promise.resolve(), undefined, {
      observation,
      channelsMounted,
      barrier: marker.promise,
      decodeBarrier: merge.promise,
      frontier: Math.floor(Date.now() / 1000) - 1,
    });
    try {
      // Without Channels this must be initiated by the actual app-global binding.
      await vi.waitFor(() => expect(h.markerQuery).toHaveBeenCalledOnce());
      expect(h.owner.session.unread.sync()).toMatchObject({
        status: "local",
        completeness: "unknown",
      });
      const read = h.make("already read on another device", 1),
        unread = h.make("genuinely unread");
      h.emit([read, unread], "live");
      await flush();
      expect(h.owner.session.unread.attention("room", read.id).unread).toBe(
        true,
      );
      expect(h.show).not.toHaveBeenCalled();
      marker.release();
      await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce());
      await flush();
      expect(h.show).not.toHaveBeenCalled(); // Response alone is not a merged frontier.
      merge.release();
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
      expect(h.owner.session.unread.sync()).toMatchObject({
        status: "reconciled",
        completeness: observation,
      });
      expect(h.owner.session.unread.attention("room", read.id).unread).toBe(
        false,
      );
      expect(h.show.mock.calls[0]?.[0]).toMatchObject({
        body: "genuinely unread",
      });
      expect(h.markerQuery).toHaveBeenCalledOnce(); // Shared with Channels, not a second observation.
    } finally {
      marker.release();
      merge.release();
    }
  },
);

it.each(["failed", "cancelled", "switched", "disposed"] as const)(
  "remote marker observation keeps candidates quiet when %s",
  async (condition) => {
    const marker = deferred();
    const h = await setup(Promise.resolve(), undefined, {
      observation: "bounded",
      barrier: marker.promise,
      frontier: 0,
    });
    try {
      await vi.waitFor(() => expect(h.markerQuery).toHaveBeenCalledOnce());
      h.emit([h.make("pending remote state")], "live");
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      if (condition === "failed" || condition === "cancelled")
        h.decode.mockRejectedValueOnce(
          condition === "failed"
            ? new Error("decode unavailable")
            : new DOMException("cancelled", "AbortError"),
        );
      if (condition === "switched") h.deselect();
      if (condition === "disposed") h.stop();
      marker.release();
      await vi.waitFor(() =>
        expect(h.owner.session.unread.sync().status).toBe(
          condition === "failed" || condition === "cancelled"
            ? "error"
            : "reconciled",
        ),
      );
      await h.notifications.requestPermission();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      expect(h.markerQuery).toHaveBeenCalledOnce();
    } finally {
      marker.release();
    }
  },
);

it.each([
  [
    JSON.stringify({ content: "**Decoded** preview", extra: "not displayed" }),
    "Decoded preview",
  ],
  [
    JSON.stringify({
      extra: "x".repeat(5000),
      content: "Text after envelope metadata",
    }),
    "Text after envelope metadata",
  ],
  [JSON.stringify({ content: "Long ".repeat(1000) }), null],
  ["Plain text fallback", "Plain text fallback"],
  [JSON.stringify({ content: "" }), "New message"],
])(
  "kind-40002 mentions decode their envelope before bounding the preview (case %#)",
  async (content, body) => {
    const h = await setup();
    const event = signed(h.peer, { ...h.make(content), kind: 40002 });
    h.emit([event], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    const shown = h.show.mock.calls[0]?.[0];
    if (body !== null) expect(shown.body).toBe(body);
    else {
      expect([...shown.body].length).toBeLessThanOrEqual(200);
      expect(shown.body.startsWith("Long Long")).toBe(true);
    }
  },
);

it("notification startup waits for the roster without consuming the shared evidence repair early", async () => {
  const h = await setup(Promise.resolve(), undefined, {
    observation: "bounded",
    barrier: Promise.resolve(),
    frontier: 0,
    deferRoster: true,
  });
  expect(h.markerQuery).not.toHaveBeenCalled();
  expect(h.query.mock.calls.map(([filters]) => filters)).toEqual([
    [{ authors: [h.viewer.pubkey], kinds: [30175, 30177], limit: 200 }],
  ]);
  h.discover();
  await h.owner.session.unread.ensure();
  expect(h.markerQuery).toHaveBeenCalledOnce();
  const evidence = () =>
    h.query.mock.calls.filter(([filters]) => filters[0]?.kinds?.includes(9));
  // One repair: the windows' request and the roster sample behind it.
  expect(evidence()).toHaveLength(2);
  expect(evidence()[0]?.[0]).toContainEqual(
    expect.objectContaining({ "#h": ["room"], since: expect.any(Number) }),
  );
  expect(evidence()[1]?.[0]).toEqual([
    expect.objectContaining({ "#h": ["room"], limit: 500 }),
  ]);
  h.discover();
  await h.owner.session.unread.ensure();
  expect(h.markerQuery).toHaveBeenCalledOnce();
  expect(evidence()).toHaveLength(2);
});

it("scopes notification author collisions to the message channel", async () => {
  const h = await setup();
  const stranger = keypair();
  h.emit([
    profile(h.peer, { name: "Pinky" }),
    profile(stranger, { name: "Pinky" }),
  ]);
  h.emit([h.make("first scoped notification")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  expect(h.show.mock.calls[0]?.[0].title).toContain("Pinky");
  expect(h.show.mock.calls[0]?.[0].title).not.toContain(" · ");
  h.emit([
    roster(
      h.relay,
      "room",
      [h.viewer.pubkey, h.peer.pubkey, stranger.pubkey],
      Math.floor(Date.now() / 1000) + 1,
    ),
  ]);
  h.emit([h.make("second scoped notification")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  expect(h.show.mock.calls[1]?.[0].title).toContain("Pinky · ");
});

it.each(["direct", "thread"] as const)(
  "confirmed mute suppresses %s alerts but preserves unread and explicit mentions",
  async (category) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const write = vi.fn<SidebarMuteMutator>(async ({ muted }) =>
      muted ? ["room"] : [],
    );
    const h = await setup(Promise.resolve(), undefined, undefined, {
      decode: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
      }),
      write,
    });
    await h.owner.session.sidebarPreferences.ensure();
    const root = message(h.viewer, "room", "root", 1_779_999_999);
    if (category === "direct")
      h.emit([
        signed(h.relay, {
          kind: 39000,
          created_at: 1_780_000_000,
          content: JSON.stringify({ name: "Room", channel_type: "dm" }),
          tags: [
            ["d", "room"],
            ["name", "Room"],
            ["t", "dm"],
          ],
        }),
      ]);
    else h.emit([root], "replay");
    const make = (text: string) =>
      message(
        h.peer,
        "room",
        text,
        1_780_000_000,
        category === "thread" ? [["e", root.id, "", "reply"]] : [],
      );
    await h.owner.session.sidebarPreferences.setMute("room", true);
    const quiet = make("quiet");
    h.emit([quiet], "live");
    // Mention is an observable presentation barrier behind the muted candidate.
    h.emit([h.make("mention")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("mention");
    expect(h.owner.session.unread.attention("room", quiet.id).unread).toBe(
      true,
    );
    await h.owner.session.sidebarPreferences.setMute("room", false);
    h.emit([make("audible")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
    expect(h.show.mock.calls[1]?.[0].body).toBe("audible");
  },
);

it("a confirmed mute cancels an alert waiting on permission, even after unmute", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
  const h = await setup(Promise.resolve(), undefined, undefined, {
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    write: async ({ muted }) => (muted ? ["room"] : []),
  });
  await h.owner.session.sidebarPreferences.ensure();
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const root = message(h.viewer, "room", "root", 1_779_999_999);
  const reply = message(h.peer, "room", "cancelled reply", 1_780_000_000, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root], "replay");
  h.emit([reply], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  try {
    await h.owner.session.sidebarPreferences.setMute("room", true);
    await h.owner.session.sidebarPreferences.setMute("room", false);
  } finally {
    release("granted");
  }
  // A fresh candidate drains the presentation turn after permission resolves.
  h.emit([h.make("fresh mention")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("fresh mention");
  expect(h.owner.session.unread.attention("room", reply.id).unread).toBe(true);
});

it.each([true, false])(
  "initial mute read failure holds ordinary alerts until explicit retry (muted=%s), without Channels mounted",
  async (muted) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const decode = vi
      .fn<SidebarDecoder>()
      .mockRejectedValueOnce(new Error("preferences unavailable"))
      .mockResolvedValue({
        sections: [],
        assignments: {},
        starred: [],
        muted: muted ? ["room"] : [],
      });
    const h = await setup(Promise.resolve(), undefined, undefined, { decode });
    await h.owner.session.sidebarPreferences.ensure();
    expect(h.owner.session.sidebarPreferences.snapshot().status).toBe("error");
    const root = message(h.viewer, "room", "root", 1_779_999_999);
    h.emit([root], "replay");
    const reply = message(h.peer, "room", "waiting", 1_780_000_000, [
      ["e", root.id, "", "reply"],
    ]);
    h.emit([reply], "live");
    // A mention bypasses only mute readiness, not existing read/permission policy.
    h.emit([h.make("mention")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("mention");
    await h.owner.session.sidebarPreferences.refresh();
    if (!muted) await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
    else {
      h.emit([h.make("second mention")], "live");
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
      expect(h.show.mock.calls[1]?.[0].body).toBe("second mention");
    }
    expect(decode).toHaveBeenCalledTimes(2);
  },
);

it.each([true, false])(
  "a live reply whose parent is outside the window waits for its conversation lookup (viewer's parent=%s)",
  async (own) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const h = await setup();
    const parent = message(
      own ? h.viewer : h.peer,
      "room",
      "old",
      1_700_000_000,
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = h.query.getMockImplementation();
    h.query.mockImplementation(async (filters, ...rest) => {
      if (filters[0]?.ids?.includes(parent.id)) {
        await held;
        return [parent];
      }
      return (await base?.(filters, ...rest)) ?? [];
    });
    const reply = message(h.peer, "room", "answer", 1_780_000_000, [
      ["e", parent.id, "", "reply"],
    ]);
    h.emit([reply], "live");
    await flush();
    expect(h.owner.session.unread.attention("room", reply.id)).toMatchObject({
      status: "unknown",
      pending: true,
    });
    expect(h.show).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() =>
      expect(
        h.owner.session.unread.attention("room", reply.id).pending,
      ).toBeUndefined(),
    );
    await flush();
    if (own) await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    else expect(h.show).not.toHaveBeenCalled();
  },
);

it("explicit thread choices decide reply alerts; mentions still alert", async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  try {
    const h = await setup();
    const now = Math.floor(Date.now() / 1000);
    const followed = message(h.peer, "room", "Their thread", now - 2);
    const mine = message(h.viewer, "room", "My thread", now - 1);
    h.emit([followed, mine], "replay");
    h.owner.session.unread.follow("room", followed.id, true);
    h.owner.session.unread.follow("room", mine.id, false);
    const answer = (root: typeof mine, text: string, tags: string[][] = []) =>
      signed(h.peer, {
        kind: 9,
        content: text,
        created_at: now,
        tags: [
          ["h", "room"],
          ["e", root.id, "", "root"],
          ["e", root.id, "", "reply"],
          ...tags,
        ],
      });
    h.emit([answer(mine, "muted")], "live");
    h.emit([answer(followed, "followed")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    h.emit([answer(mine, "mention", [["p", h.viewer.pubkey]])], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
    expect(h.show.mock.calls.map(([alert]) => alert.body)).toEqual([
      "followed",
      "mention",
    ]);
    expect([...saved.values()]).toEqual([
      JSON.stringify([
        [`room:${followed.id}`, true],
        [`room:${mine.id}`, false],
      ]),
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("suppresses ordinary notifications after a channel is marked as a Huddle", async () => {
  const h = await setup();
  h.emit([h.make("ordinary mention")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  h.emit([
    metadata(h.relay, "room", "Huddle", Math.floor(Date.now() / 1000), [
      ["private"],
      ["P", h.peer.pubkey],
      ["about", huddleDescription("00000000-0000-4000-8000-000000000001")],
    ]),
    signed(h.peer, {
      kind: 9007,
      created_at: 10,
      content: "",
      tags: [
        ["h", "room"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["about", huddleDescription("00000000-0000-4000-8000-000000000001")],
      ],
    }),
  ]);
  h.emit([h.make("private mention")], "live");
  await flush();
  expect(h.show).toHaveBeenCalledOnce();
  expect(
    h.owner.session.channels
      .list()
      .channels.find((channel) => channel.id === "room")?.huddle,
  ).toBe(true);
});

it("withholds unclassified room notifications and allows new messages after ordinary metadata arrives", async () => {
  const h = await setup();
  h.emit([roster(h.relay, "pending", [h.viewer.pubkey])]);
  const make = (text: string) =>
    message(h.peer, "pending", text, Math.floor(Date.now() / 1000), [
      ["p", h.viewer.pubkey],
    ]);
  h.emit([make("unclassified mention")], "live", "pending");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.emit([metadata(h.relay, "pending", "Ordinary")]);
  h.emit([make("ordinary mention")], "live", "pending");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("cancels a pending thread notification when metadata marks its room as a Huddle", async () => {
  const h = await setup();
  let release: (value: "granted") => void = () => {};
  let started = false;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
        started = true;
      }),
  );
  const now = Math.floor(Date.now() / 1000);
  const root = message(h.viewer, "room", "root", now - 1);
  const reply = message(h.peer, "room", "private reply", now, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root], "replay");
  h.emit([reply], "live");
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    h.emit([
      metadata(h.relay, "room", "Huddle", now, [
        ["private"],
        ["P", h.peer.pubkey],
        ["about", huddleDescription("00000000-0000-4000-8000-000000000001")],
      ]),
      signed(h.peer, {
        kind: 9007,
        created_at: 10,
        content: "",
        tags: [
          ["h", "room"],
          ["visibility", "private"],
          ["channel_type", "stream"],
          ["about", huddleDescription("00000000-0000-4000-8000-000000000001")],
        ],
      }),
    ]);
  } finally {
    release("granted");
  }
  await flush();
  expect(h.show).not.toHaveBeenCalled();
});

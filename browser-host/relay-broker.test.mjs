import { test } from "vitest";
import assert from "node:assert/strict";
import {
  createUpstream,
  validFilters,
  validMessageTemplate,
} from "./relay-broker.mjs";

test("read broker accepts non-channel finite reads without relaxing filter budgets", () => {
  for (const filter of [
    { kinds: [13534], limit: 1 },
    { kinds: [30078], authors: ["viewer"], "#d": ["channel-stars"], limit: 1 },
    { kinds: [1621], "#a": ["30617:owner:repo"], limit: 200 },
    { ids: ["event"], limit: 1 },
    { kinds: [9], search: "design", limit: 20 },
    { kinds: [9], "#e": ["root"], depth_limit: 10, limit: 80 },
  ])
    assert.equal(validFilters([filter]), true);
  for (const filters of [
    [],
    Array(5).fill({ kinds: [0], limit: 1 }),
    [{ kinds: [0], limit: 501 }],
    [{ kinds: [0], limit: 0 }],
    [{ kinds: [-1], limit: 1 }],
    [{ kinds: [65536], limit: 1 }],
    [{ kinds: [], limit: 1 }],
    [{ limit: 1 }],
  ])
    assert.equal(validFilters(filters), false);
});

test("broker signing is limited to bounded channel messages and canonical direct and nested replies", () => {
  const message = {
    kind: 9,
    content: "hello",
    created_at: 1788810000,
    tags: [
      ["h", "channel"],
      ["client-id", "unique"],
    ],
  };
  assert.equal(validMessageTemplate(message), true);
  const reply = ["e", "a".repeat(64), "", "reply"];
  assert.equal(
    validMessageTemplate({ ...message, tags: [...message.tags, reply] }),
    true,
  );
  const root = ["e", "b".repeat(64), "", "root"];
  assert.equal(
    validMessageTemplate({ ...message, tags: [...message.tags, root, reply] }),
    true,
  );
  for (const references of [
    [reply, root],
    [root, root],
    [root, ["e", root[1], "", "reply"]],
    [root, reply, reply],
    [[...root, "extra"], reply],
    [["e", "B".repeat(64), "", "root"], reply],
    [["e", root[1], "relay", "root"], reply],
    [["e", "a".repeat(64)]],
    [["e", "a".repeat(64), "", "root"]],
    [["e", "invalid", "", "reply"]],
    [["e", "a".repeat(64), "untrusted relay", "reply"]],
    [[...reply, "extra"]],
    [reply, reply],
  ])
    assert.equal(
      validMessageTemplate({
        ...message,
        tags: [...message.tags, ...references],
      }),
      false,
    );
  for (const invalid of [
    { ...message, kind: 9005 },
    { ...message, content: " " },
    { ...message, content: "x".repeat(33000) },
    { ...message, tags: [] },
    {
      ...message,
      tags: [
        ["h", "channel"],
        ["e", "thread"],
      ],
    },
    {
      ...message,
      tags: [
        ["h", "channel"],
        ["h", "other"],
      ],
    },
  ])
    assert.equal(validMessageTemplate(invalid), false);
});

test("the upstream pool reuses warm connections and reports only new connects", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => res.end("{}"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upstream = createUpstream(base);
  const request = () =>
    upstream
      .fetch(`${base}/query`, { method: "POST", body: "[]" })
      .then((response) => response.text());
  try {
    const before = upstream.connects();
    await upstream.warm();
    assert.equal(upstream.connects(), before + 1);
    assert.match(upstream.connectTiming(before)[0], /^connect;dur=[\d.]+$/);
    // The pool may open a second socket while the first is being released.
    await request();
    await request();
    const warmed = upstream.connects();
    assert.ok(warmed <= before + 2);
    await request();
    assert.equal(upstream.connects(), warmed);
    assert.deepEqual(upstream.connectTiming(warmed), []);
  } finally {
    await upstream.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("broker permits bounded replacement edits with exactly one canonical target", () => {
  const edit = {
    kind: 40003,
    content: "edited Markdown **body**",
    created_at: 1788810000,
    tags: [
      ["h", "channel"],
      ["e", "a".repeat(64)],
      ["client-id", "unique"],
    ],
  };
  assert.equal(validMessageTemplate(edit), true);
  for (const invalid of [
    { ...edit, content: " " },
    { ...edit, content: "x".repeat(32001) },
    { ...edit, content: " padded " },
    { ...edit, created_at: NaN },
    { ...edit, kind: 5 },
    { ...edit, tags: [["h", "channel"]] },
    { ...edit, tags: [["e", "a".repeat(64)]] },
    {
      ...edit,
      tags: [
        ["h", "channel"],
        ["e", "invalid"],
      ],
    },
    {
      ...edit,
      tags: [
        ["h", "channel"],
        ["e", "a".repeat(64), "", "reply"],
      ],
    },
    { ...edit, tags: [...edit.tags, ["e", "b".repeat(64)]] },
    { ...edit, tags: [...edit.tags, ["h", "other"]] },
    { ...edit, tags: [...edit.tags, ["e", 42]] },
  ])
    assert.equal(validMessageTemplate(invalid), false);
});

test("edits admit one exact target without new notification recipients or arbitrary references", () => {
  const edit = {
    kind: 40003,
    content: "corrected",
    created_at: 1788810000,
    tags: [
      ["h", "channel"],
      ["e", "a".repeat(64)],
      ["client-id", "unique"],
    ],
  };
  assert.equal(validMessageTemplate(edit), true);
  assert.equal(
    validMessageTemplate({
      ...edit,
      tags: [
        ...edit.tags,
        [
          "imeta",
          "url https://example.com/image.png",
          "m image/png",
          "dim 320x200",
        ],
      ],
    }),
    true,
  );
  for (const tags of [
    [["h", "channel"]],
    [...edit.tags, ["e", "b".repeat(64)]],
    [
      ["h", "channel"],
      ["e", "a".repeat(64), "", "reply"],
    ],
    [...edit.tags, ["p", "b".repeat(64)]],
    [...edit.tags, ["imeta", 42]],
    [...edit.tags, ["unknown", "value"]],
  ])
    assert.equal(validMessageTemplate({ ...edit, tags }), false);
  assert.equal(validMessageTemplate({ ...edit, content: " " }), false);
});

test("unread repair batches may exceed four filters: windows, the authored page, thread reads and root IDs, 128 at most", () => {
  const kinds = [9, 40002, 40008];
  const root = "a".repeat(64);
  const batch = [
    { kinds, authors: ["b".repeat(64)], include_aux: true, limit: 100 },
    ...Array.from({ length: 125 }, (_, i) => ({
      kinds,
      "#h": [`room-${i}`],
      since: 1000,
      include_aux: true,
      limit: 24,
    })),
    { kinds, "#h": ["room-200"], "#e": [root], include_aux: true, limit: 200 },
    { kinds, ids: [root], include_aux: true, limit: 1 },
  ];
  assert.equal(validFilters(batch), true);
  for (const invalid of [
    [...batch, { ...batch[1], "#h": ["room-300"] }],
    batch.map((f) => ({ ...f, kinds: [9] })),
    batch.map((f) => ({ ...f, include_aux: undefined })),
    batch.map((f) => ("since" in f ? { ...f, since: undefined } : f)),
    batch.map((f) => ("since" in f ? { ...f, "#h": ["room-1"] } : f)),
    batch.map((f) => ("since" in f ? { ...f, until: 2000 } : f)),
    batch.map((f) => ("since" in f ? { ...f, limit: 501 } : f)),
    [...batch.slice(1), batch[0], batch[0]],
    batch.map((f) => ("ids" in f ? { ...f, limit: 2 } : f)),
    [...batch.slice(0, 5), null],
  ])
    assert.equal(validFilters(invalid), false);
});

test("workflow list batches alone may exceed four filters, with 128 unique channels at most", () => {
  const batch = Array.from({ length: 128 }, (_, i) => ({
    kinds: [30620],
    "#h": [`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`],
    limit: 100,
  }));
  assert.equal(validFilters(batch), true);
  for (const invalid of [
    [...batch, batch[0]],
    batch.map((f) => ({ ...f, kinds: [9] })),
    batch.map((f) => ({ ...f, limit: 500 })),
    batch.map((f) => ({ ...f, search: "anything" })),
    batch.map((f) => ({ ...f, "#h": ["invalid"] })),
    Array(5).fill(batch[0]),
    batch.map((f) => ({
      ...f,
      "#h": [...f["#h"], "00000000-0000-4000-8000-000000000999"],
    })),
    [...batch.slice(0, 5), null],
  ])
    assert.equal(validFilters(invalid), false);
});

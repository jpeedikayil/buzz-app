import { assert, describe, expect, it } from "vitest";
import { parseAttachments } from "./fold";
import { foldMessages } from "./fold";
import { mentionConformance } from "../../bundled/mentions/mention-rules.conformance";
import { shareMessageRows } from "./row-identity";
import { foldProfiles } from "./profiles";
import { DiscoveryState } from "./discovery";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
  summary,
} from "./testing";

const relay = keypair(),
  alice = keypair(),
  bob = keypair(),
  carol = keypair(),
  dave = keypair();
const channel = "chan-1";

describe("message fold", () => {
  it("preserves diff patch bytes and signed metadata without Markdown attachment projection", () => {
    const content =
      "@@ -1 +1 @@\n-![old](https://example.com/old.png)\n+<script>alert(1)</script>  \n";
    const event = signed(alice, {
      kind: 40008,
      content,
      tags: [
        ["h", channel],
        ["file", "README.md"],
        ["repo", "javascript:alert(1)"],
        ["commit", "abcdef0"],
        ["description", "Raw <code>"],
        ["truncated", "true"],
      ],
    });
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row).toMatchObject({
      content,
      attachments: [],
      diff: {
        filePath: "README.md",
        repoUrl: "javascript:alert(1)",
        commitSha: "abcdef0",
        description: "Raw <code>",
        truncated: true,
      },
    });
    expect(row?.attachmentSeams).toBeUndefined();
    expect(Object.isFrozen(row?.diff)).toBe(true);
    const untagged = signed(alice, {
      kind: 40008,
      content,
      tags: [["h", channel]],
    });
    expect(
      foldMessages(channel, relay.pubkey, [untagged])[0]?.diff,
    ).toMatchObject({ truncated: false });
  });
  it("orders rows chronologically with id tiebreak and excludes other channels and non-broadcast replies", () => {
    const a = message(alice, channel, "a", 20),
      b = message(bob, channel, "b", 10),
      same = message(bob, channel, "c", 10);
    const other = message(alice, "chan-2", "elsewhere", 30);
    const reply = message(bob, channel, "reply", 25, [
      ["e", a.id, "", "reply"],
    ]);
    const broadcast = message(bob, channel, "broadcast", 26, [
      ["e", a.id, "", "reply"],
      ["broadcast", "1"],
    ]);
    const rootOnly = message(bob, channel, "root marker only", 27, [
      ["e", a.id, "", "root"],
    ]);
    const rows = foldMessages(channel, relay.pubkey, [
      a,
      b,
      same,
      other,
      reply,
      broadcast,
      rootOnly,
    ]);
    const expectedTen = [b, same]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((event) => event.id);
    expect(rows.map((row) => row.id)).toEqual([
      ...expectedTen,
      a.id,
      broadcast.id,
      rootOnly.id,
    ]);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(rows.find((row) => row.id === broadcast.id)?.threadRootId).toBe(
      a.id,
    );
    expect(rows.find((row) => row.id === broadcast.id)?.replyParentId).toBe(
      a.id,
    );
    expect(
      rows.find((row) => row.id === rootOnly.id)?.replyParentId,
    ).toBeUndefined();
    expect(rows.find((row) => row.id === a.id)?.threadRootId).toBeUndefined();
    expect(
      rows.find((row) => row.id === rootOnly.id)?.threadRootId,
    ).toBeUndefined();
  });
  it("applies author-only deletes and latest author edit, collects reactions and signed mentions", () => {
    const a = message(alice, channel, `hello @bob`, 10, [
      ["p", bob.pubkey],
      ["p", "not-a-key"],
    ]);
    const gone = message(alice, channel, "deleted", 11);
    const spoofed = message(alice, channel, "still here", 12);
    const events = [
      a,
      gone,
      spoofed,
      signed(alice, {
        kind: 5,
        content: "",
        created_at: 12,
        tags: [["e", gone.id]],
      }),
      signed(bob, {
        kind: 5,
        content: "",
        created_at: 12,
        tags: [["e", spoofed.id]],
      }),
      signed(alice, {
        kind: 40003,
        content: "edit one",
        created_at: 13,
        tags: [["e", a.id]],
      }),
      signed(alice, {
        kind: 40003,
        content: "edit two",
        created_at: 14,
        tags: [["e", a.id]],
      }),
      signed(bob, {
        kind: 40003,
        content: "not my message",
        created_at: 15,
        tags: [["e", a.id]],
      }),
      signed(bob, {
        kind: 7,
        content: "👍",
        created_at: 15,
        tags: [["e", a.id]],
      }),
      signed(alice, {
        kind: 7,
        content: "👍",
        created_at: 16,
        tags: [["e", a.id]],
      }),
      signed(bob, {
        kind: 7,
        content: "🎉",
        created_at: 16,
        tags: [["e", a.id]],
      }),
    ];
    const rows = foldMessages(channel, relay.pubkey, events);
    expect(rows.map((row) => row.id)).toEqual([a.id, spoofed.id]);
    expect(rows[0]).toMatchObject({
      content: "edit two",
      mentions: [bob.pubkey],
      reactions: [{ content: "👍" }, { content: "🎉" }],
      replyCount: 0,
      participants: [],
    });
  });
  it("attributes relay-signed workflow output to its owner, never another signer's claim", () => {
    const tags = (author: string) => [
      ["p", author],
      ["h", channel],
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", author],
    ];
    const run = signed(relay, {
      kind: 9,
      content: "scheduled",
      created_at: 10,
      tags: tags(alice.pubkey),
    });
    const actor = signed(relay, {
      kind: 9,
      content: "acted",
      created_at: 11,
      tags: [
        ["h", channel],
        ["actor", bob.pubkey],
        ["p", alice.pubkey],
      ],
    });
    const notLeading = signed(relay, {
      kind: 9,
      content: "system",
      created_at: 12,
      tags: [
        ["h", channel],
        ["p", alice.pubkey],
      ],
    });
    const spoofed = signed(bob, {
      kind: 9,
      content: "spoof",
      created_at: 13,
      tags: tags(alice.pubkey),
    });
    const events = [
      run,
      actor,
      notLeading,
      spoofed,
      signed(alice, {
        kind: 40003,
        content: "edited by owner",
        created_at: 14,
        tags: [["e", run.id]],
      }),
      signed(bob, {
        kind: 40003,
        content: "not the owner",
        created_at: 15,
        tags: [["e", notLeading.id]],
      }),
    ];
    const rows = foldMessages(channel, relay.pubkey, events, {
      signingAuthority: relay.pubkey,
    });
    expect(rows.map(({ authorId, content }) => [authorId, content])).toEqual([
      [alice.pubkey, "edited by owner"],
      [bob.pubkey, "acted"],
      [relay.pubkey, "system"],
      [bob.pubkey, "spoof"],
    ]);
    // Without an explicit NIP-11 self (e.g. a contact-key fallback), the signer
    // stays the author and gains no delegated edit authority.
    expect(
      foldMessages(channel, relay.pubkey, events).map(
        ({ authorId, content }) => [authorId, content],
      ),
    ).toEqual([
      [relay.pubkey, "scheduled"],
      [relay.pubkey, "acted"],
      [relay.pubkey, "system"],
      [bob.pubkey, "spoof"],
    ]);
  });
  it("applies relay-authorized agent message deletes but not owner deletes of agent reactions", () => {
    const agentMessage = message(alice, channel, "agent message", 10);
    const agentReaction = signed(alice, {
      kind: 7,
      content: "👍",
      created_at: 11,
      tags: [["e", agentMessage.id]],
    });
    const ownerDeleteReaction = signed(bob, {
      kind: 5,
      content: "",
      created_at: 12,
      tags: [
        ["e", agentReaction.id],
        ["k", "7"],
      ],
    });
    const ownerDeleteMessage = signed(bob, {
      kind: 5,
      content: "",
      created_at: 13,
      tags: [
        ["e", agentMessage.id],
        ["k", "9"],
      ],
    });
    expect(
      foldMessages(channel, relay.pubkey, [
        agentMessage,
        agentReaction,
        ownerDeleteReaction,
      ])[0]?.reactions,
    ).toHaveLength(1);
    expect(
      foldMessages(channel, relay.pubkey, [
        agentMessage,
        agentReaction,
        ownerDeleteMessage,
      ]),
    ).toHaveLength(0);
  });

  it("reads relay-signed thread summaries only and tolerates malformed ones", () => {
    const a = message(alice, channel, "a", 10),
      b = message(alice, channel, "b", 11),
      c = message(alice, channel, "c", 12);
    const rows = foldMessages(channel, relay.pubkey, [
      a,
      b,
      c,
      summary(relay, channel, a.id, {
        reply_count: 4,
        descendant_count: 7,
        participants: [bob.pubkey, bob.pubkey, "junk"],
      }),
      summary(bob, channel, b.id, { reply_count: 99, participants: [] }),
      signed(relay, {
        kind: 39005,
        content: "{not json",
        tags: [
          ["e", c.id],
          ["d", c.id],
          ["h", channel],
        ],
      }),
    ]);
    expect(rows.map((row) => [row.replyCount, row.participants])).toEqual([
      [7, [bob.pubkey]],
      [0, []],
      [0, []],
    ]);
  });
  it.each([
    [0, 0],
    [undefined, 1],
    [-1, 1],
    [1.5, 1],
    ["3", 1],
  ])(
    "projects descendant count %s with a validated direct-count fallback",
    (total, expected) => {
      const root = message(alice, channel, "root", 10);
      const rows = foldMessages(channel, relay.pubkey, [
        root,
        summary(relay, channel, root.id, {
          reply_count: 1,
          descendant_count: total,
          participants: [],
        }),
      ]);
      expect(rows[0]?.replyCount).toBe(expected);
    },
  );
  it("layers pending replies on their root's summary and leads participants with their authors", () => {
    const root = message(alice, channel, "root", 10);
    const reply = (key: typeof bob, at: number, channelId = channel) =>
      message(key, channelId, "re", at, [["e", root.id, "", "reply"]]);
    const first = reply(bob, 11),
      second = reply(alice, 12),
      elsewhere = reply(bob, 14, "elsewhere");
    const count = (body: Record<string, unknown>) =>
      summary(relay, channel, root.id, body);
    const fold = (
      events: Parameters<typeof foldMessages>[2],
      pending: readonly string[] = [first.id, second.id, elsewhere.id],
      options: Parameters<typeof foldMessages>[3] = {},
    ) =>
      foldMessages(channel, relay.pubkey, [root, ...events], {
        pendingReplies: new Set(pending),
        ...options,
      }).map((row) => [row.replyCount, row.participants]);
    expect(fold([first])).toEqual([[1, [bob.pubkey]]]);
    expect(
      fold([
        first,
        count({ descendant_count: 3, participants: [carol.pubkey] }),
      ]),
    ).toEqual([[4, [bob.pubkey, carol.pubkey]]]);
    expect(
      fold([
        first,
        second,
        count({ descendant_count: 1, participants: [bob.pubkey] }),
      ]),
    ).toEqual([[3, [bob.pubkey, alice.pubkey]]]);
    // Replies the summary counted stand only through the summary.
    expect(
      fold(
        [first, count({ descendant_count: 3, participants: [carol.pubkey] })],
        [],
      ),
    ).toEqual([[3, [carol.pubkey]]]);
    expect(fold([first], [])).toEqual([[0, []]]);
    expect(fold([first], [first.id], { includeReplies: true })).toEqual([
      [0, []],
      [0, []],
    ]);
    const remove = signed(bob, {
      kind: 5,
      content: "",
      created_at: 13,
      tags: [["e", first.id]],
    });
    expect(fold([first, second, remove])).toEqual([[1, [alice.pubkey]]]);
    expect(fold([elsewhere])).toEqual([[0, []]]);
    // A new replier stays within the three visible avatars.
    expect(
      fold([
        first,
        count({
          descendant_count: 3,
          participants: [alice.pubkey, carol.pubkey, dave.pubkey],
        }),
      ]),
    ).toEqual([[4, [bob.pubkey, alice.pubkey, carol.pubkey, dave.pubkey]]]);
    // So does a returning replier the summary lists after the visible three.
    expect(
      fold([
        first,
        count({
          descendant_count: 4,
          participants: [alice.pubkey, carol.pubkey, dave.pubkey, bob.pubkey],
        }),
      ]),
    ).toEqual([[5, [bob.pubkey, alice.pubkey, carol.pubkey, dave.pubkey]]]);
    // The relay lists a relay-signed workflow reply by its signer; the client
    // shows its author but adds no second identity next to that signer.
    const workflow = signed(relay, {
      kind: 9,
      content: "re",
      created_at: 15,
      tags: [
        ["p", bob.pubkey],
        ["h", channel],
        ["e", root.id, "", "reply"],
      ],
    });
    const relaySigned = { signingAuthority: relay.pubkey };
    expect(fold([workflow], [workflow.id], relaySigned)).toEqual([
      [1, [bob.pubkey]],
    ]);
    expect(
      fold(
        [
          workflow,
          count({ descendant_count: 1, participants: [relay.pubkey] }),
        ],
        [workflow.id],
        relaySigned,
      ),
    ).toEqual([[2, [relay.pubkey]]]);
  });
  it("folds the same rows without pending replies as with none layered", () => {
    const root = message(alice, channel, "root", 10);
    const reply = message(bob, channel, "re", 11, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ]);
    const shared = message(bob, channel, "shared", 12, [
      ["e", root.id, "", "reply"],
      ["broadcast", "1"],
    ]);
    const elsewhere = message(bob, "elsewhere", "re", 13, [
      ["e", root.id, "", "reply"],
    ]);
    const events = [
      root,
      reply,
      shared,
      elsewhere,
      summary(relay, channel, root.id, {
        descendant_count: 2,
        participants: [bob.pubkey],
      }),
      signed(alice, {
        kind: 40003,
        content: "root, edited",
        created_at: 14,
        tags: [["e", root.id]],
      }),
      signed(bob, {
        kind: 5,
        content: "",
        created_at: 15,
        tags: [["e", shared.id]],
      }),
      signed(carol, {
        kind: 7,
        content: "+",
        created_at: 16,
        tags: [["e", root.id]],
      }),
    ];
    for (const includeReplies of [false, true]) {
      const rows = foldMessages(channel, relay.pubkey, events, {
        includeReplies,
      });
      expect(rows.map((row) => row.id)).toEqual(
        includeReplies ? [root.id, reply.id] : [root.id],
      );
      // The summary alone: no reply is pending.
      expect(rows[0]).toMatchObject({
        content: "root, edited",
        replyCount: 2,
        participants: [bob.pubkey],
      });
      // An empty set, or one naming no reply of this channel, layers nothing.
      for (const pending of [[], [root.id, elsewhere.id]])
        expect(
          foldMessages(channel, relay.pubkey, events, {
            includeReplies,
            pendingReplies: new Set(pending),
          }),
        ).toEqual(rows);
    }
  });
  it("does not exhaust the call stack while projecting deeply nested untrusted Markdown", () => {
    const nested = message(
      alice,
      channel,
      `${"> ".repeat(10_000)}![deep](https://x.test/deep.png)`,
      10,
    );
    const [row] = foldMessages(channel, relay.pubkey, [nested]);
    assert.exists(row);
    expect(row.content).toContain("![deep](https://x.test/deep.png)");
    expect(row.attachments).toEqual([]);
  });

  it("projects extensionless markdown images as image attachments", () => {
    const hash = "a".repeat(64);
    const event = message(
      alice,
      channel,
      `See ![relay image](https://relay.test/files/${hash}) now`,
      10,
    );
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe("See  now");
    expect(row?.sourceContent).toBe(event.content);
    expect(row?.attachments).toEqual([
      { url: `https://relay.test/files/${hash}`, kind: "image" },
    ]);
  });

  it.each([9, 40002])(
    "preserves code indentation when projecting images in kind %s",
    (kind) => {
      const content = "    @Mic\n\n![image](https://x.test/image.png)";
      const event = signed(alice, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", channel],
          ["p", bob.pubkey],
        ],
      });
      const [row] = foldMessages(channel, relay.pubkey, [event]);
      expect(row?.content).toBe("    @Mic");
      expect(row?.attachments).toEqual([
        { url: "https://x.test/image.png", kind: "image" },
      ]);
    },
  );

  it.each([
    [9, "Plain message"],
    [9, JSON.stringify({ content: "Envelope-looking prose", is_agent: true })],
    [40002, JSON.stringify({ content: "Agent message" })],
    [40002, "Malformed envelope"],
  ])(
    "keeps the original kind %s display hint independent of body and edits (%s)",
    (kind, content) => {
      const original = signed(alice, {
        kind,
        content,
        created_at: 10,
        tags: [["h", channel]],
      });
      const hint = kind === 40002 ? true : undefined;
      expect(
        foldMessages(channel, relay.pubkey, [original])[0]?.agentEnvelope,
      ).toBe(hint);
      for (const replacement of [
        "Plain edit",
        JSON.stringify({ content: "Envelope edit" }),
      ]) {
        const edit = signed(alice, {
          kind: 40003,
          content: replacement,
          created_at: 11,
          tags: [["e", original.id]],
        });
        const [row] = foldMessages(channel, relay.pubkey, [original, edit]);
        expect(row?.edited).toBe(true);
        expect(row?.agentEnvelope).toBe(hint);
        expect(row?.content).toBe(
          kind === 40002 && replacement.startsWith("{")
            ? "Envelope edit"
            : replacement,
        );
      }
    },
  );

  it("projects attachment markdown links as file names without rendering duplicate links", () => {
    const url =
      "https://relay.test/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf";
    const event = message(
      alice,
      channel,
      `See [Aidys Cap - EU.bebe5b6f.pdf](${url}) now`,
      10,
      [["imeta", `url ${url}`, "m application/pdf", "size 1536"]],
    );
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe("See  now");
    expect(row?.attachments).toEqual([
      {
        url,
        kind: "file",
        mime: "application/pdf",
        size: 1536,
        name: "Aidys Cap - EU.bebe5b6f.pdf",
      },
    ]);
    expect(row?.attachmentSeams).toEqual([4]);
  });

  it("projects attachment link references as file names", () => {
    const url = "https://relay.test/media/file.pdf";
    const event = message(
      alice,
      channel,
      `Download [Quarterly Summary][file].\n\n[file]: ${url}`,
      10,
      [["imeta", `url ${url}`, "m application/pdf"]],
    );
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe(`Download .\n\n[file]: ${url}`);
    expect(row?.attachments).toEqual([
      { url, kind: "file", mime: "application/pdf", name: "Quarterly Summary" },
    ]);
  });

  it("strips attachment autolinks while rejecting hash-shaped URL labels", () => {
    const url =
      "https://relay.test/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf";
    const event = message(alice, channel, `<${url}>`, 10, [
      ["imeta", `url ${url}`, "m application/pdf"],
    ]);
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe("");
    expect(row?.attachments).toEqual([
      { url, kind: "file", mime: "application/pdf" },
    ]);
  });

  it("leaves non-attachment markdown links untouched", () => {
    const attached = "https://relay.test/media/file.pdf";
    const linked = "https://relay.test/docs/file.pdf";
    const event = message(alice, channel, `[Public copy](${linked})`, 10, [
      ["imeta", `url ${attached}`, "m application/pdf"],
    ]);
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe(`[Public copy](${linked})`);
    expect(row?.attachments).toEqual([
      {
        url: attached,
        kind: "file",
        mime: "application/pdf",
        name: "file.pdf",
      },
    ]);
  });

  it("ignores empty attachment link labels and preserves URL-derived names", () => {
    const url = "https://relay.test/media/report.pdf";
    const event = message(alice, channel, `[](${url})`, 10, [
      ["imeta", `url ${url}`, "m application/pdf"],
    ]);
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe("");
    expect(row?.attachments).toEqual([
      { url, kind: "file", mime: "application/pdf", name: "report.pdf" },
    ]);
  });

  it("keeps URL-derived names for attachment autolinks with ordinary basenames", () => {
    const url = "https://relay.test/media/report.pdf";
    const event = message(alice, channel, `<${url}>`, 10, [
      ["imeta", `url ${url}`, "m application/pdf"],
    ]);
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe("");
    expect(row?.attachments).toEqual([
      { url, kind: "file", mime: "application/pdf", name: "report.pdf" },
    ]);
  });

  it("rejects hash-shaped attachment link labels", () => {
    const hash = "a".repeat(64);
    const url = `https://relay.test/media/${hash}.pdf`;
    const event = message(alice, channel, `[${hash}.pdf](${url})`, 10, [
      ["imeta", `url ${url}`, "m application/pdf"],
    ]);
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe("");
    expect(row?.attachments).toEqual([
      { url, kind: "file", mime: "application/pdf" },
    ]);
  });

  it.each([
    ["RLO", "report\u202eexe.pdf"],
    ["newline", "report\nfinal.pdf"],
  ])("rejects %s attachment link labels", (_case, label) => {
    const url = "https://relay.test/media/file.pdf";
    const event = message(alice, channel, `[${label}](${url})`, 10, [
      ["imeta", `url ${url}`, "m application/pdf"],
    ]);
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe("");
    expect(row?.attachments).toEqual([
      { url, kind: "file", mime: "application/pdf", name: "file.pdf" },
    ]);
  });

  it("accepts ordinary unicode attachment link labels", () => {
    const url = "https://relay.test/media/file.pdf";
    const event = message(alice, channel, `[résumé-月報.pdf](${url})`, 10, [
      ["imeta", `url ${url}`, "m application/pdf"],
    ]);
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.attachments).toEqual([
      { url, kind: "file", mime: "application/pdf", name: "résumé-月報.pdf" },
    ]);
  });

  it("caps over-length attachment link names", () => {
    const url = "https://relay.test/media/file.pdf";
    const label = "n".repeat(300);
    const event = message(alice, channel, `[${label}](${url})`, 10, [
      ["imeta", `url ${url}`, "m application/pdf"],
    ]);
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.attachments).toEqual([
      {
        url,
        kind: "file",
        mime: "application/pdf",
        name: "n".repeat(256),
      },
    ]);
  });

  it("uses the first projected name when multiple links target the same attachment", () => {
    const url = "https://relay.test/media/file.pdf";
    const event = message(
      alice,
      channel,
      `[First name](${url}) and [Second name](${url})`,
      10,
      [["imeta", `url ${url}`, "m application/pdf"]],
    );
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe(" and");
    expect(row?.attachments).toEqual([
      { url, kind: "file", mime: "application/pdf", name: "First name" },
    ]);
  });

  it("preserves surrounding prose when a stripped attachment link wraps an image", () => {
    const fileUrl = "https://relay.test/media/file.pdf";
    const imageUrl = "https://relay.test/i.png";
    const event = message(
      alice,
      channel,
      `Please see [![thumb](${imageUrl})](${fileUrl}) before Friday.`,
      10,
      [["imeta", `url ${fileUrl}`, "m application/pdf"]],
    );
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe("Please see  before Friday.");
    expect(row?.attachments).toEqual([
      { url: fileUrl, kind: "file", mime: "application/pdf", name: "file.pdf" },
      { url: imageUrl, kind: "image" },
    ]);
  });

  it("keeps a non-attachment link shell when projecting an image in its label", () => {
    const imageUrl = "https://relay.test/i.png";
    const linkUrl = "https://relay.test/docs/public";
    const event = message(
      alice,
      channel,
      `Please see [![thumb](${imageUrl})](${linkUrl}) before Friday.`,
      10,
    );
    const [row] = foldMessages(channel, relay.pubkey, [event]);
    expect(row?.content).toBe(`Please see [](${linkUrl}) before Friday.`);
    expect(row?.attachments).toEqual([{ url: imageUrl, kind: "image" }]);
  });

  it("unwraps agent envelopes and projects valid CommonMark images through one safe URL policy", () => {
    const agent = signed(bob, {
      kind: 40002,
      content: JSON.stringify({
        content: `See ![shot](https://x.test/a.png "title"), ![clip](<https://x.test/b.mp4>), and ![reference][image].

![blocked](https://user:secret@x.test/private.png)

[image]: https://x.test/reference.jpg`,
      }),
      created_at: 10,
      tags: [
        ["h", channel],
        [
          "imeta",
          "url https://x.test/c.jpg",
          "m image/jpeg",
          "dim 1280x720",
          "image https://x.test/c-poster.jpg",
        ],
        ["imeta", "url http://insecure.test/d.jpg"],
        ["imeta", "url https://user:secret@x.test/e.jpg"],
      ],
    });
    const [row] = foldMessages(channel, relay.pubkey, [agent]);
    assert.exists(row);
    expect(row.content).toBe(`See , , and .



[image]: https://x.test/reference.jpg`);
    expect(row.attachments).toEqual([
      {
        url: "https://x.test/c.jpg",
        kind: "image",
        mime: "image/jpeg",
        name: "c.jpg",
        dimensions: { width: 1280, height: 720 },
        previewUrl: "https://x.test/c-poster.jpg",
      },
      { url: "https://x.test/a.png", kind: "image" },
      { url: "https://x.test/b.mp4", kind: "video" },
      { url: "https://x.test/reference.jpg", kind: "image" },
    ]);
  });
});

describe("profiles", () => {
  it("keeps the latest self-authored kind 0 and only https pictures", () => {
    const profiles = foldProfiles([
      profile(alice, { name: "old", picture: "https://x.test/old.png" }, 1),
      profile(
        alice,
        { display_name: "Alice", picture: "http://x.test/new.png" },
        2,
      ),
      profile(bob, { name: "   " }),
      signed(relay, { kind: 0, content: "broken", tags: [] }),
    ]);
    expect(profiles.get(alice.pubkey)).toEqual({ name: "Alice" });
    expect(profiles.get(bob.pubkey)).toEqual({
      name: bob.pubkey.slice(0, 10),
      nameIsFallback: true,
    });
    expect(profiles.get(relay.pubkey)).toEqual({
      name: relay.pubkey.slice(0, 10),
      nameIsFallback: true,
    });
  });
});

describe("discovery", () => {
  it("lists only relay-authored rosters that include the viewer, newest metadata wins, sorted by name", () => {
    const state = new DiscoveryState(alice.pubkey, relay.pubkey);
    expect(state.accept(roster(relay, "zeta", [alice.pubkey]))).toBe(true);
    expect(
      state.accept(roster(relay, "alpha", [alice.pubkey, bob.pubkey])),
    ).toBe(true);
    expect(state.accept(roster(relay, "private", [bob.pubkey]))).toBe(true);
    expect(state.accept(roster(bob, "forged", [alice.pubkey]))).toBe(false);
    expect(state.accept(metadata(relay, "alpha", "Old name", 1))).toBe(true);
    expect(state.accept(metadata(relay, "alpha", "Alpha", 2))).toBe(true);
    expect(state.accept(metadata(relay, "alpha", "Older replay", 1))).toBe(
      false,
    );
    expect(state.channels()).toEqual([
      {
        id: "alpha",
        name: "Alpha",
        description: "",
        visibility: undefined,
        joinRole: "member",
        members: [alice.pubkey, bob.pubkey].sort(),
      },
      { id: "zeta", name: "zeta".slice(0, 8), members: [alice.pubkey] },
    ]);
    expect(
      state.accept(roster(relay, "alpha", [bob.pubkey], 1_700_000_001)),
    ).toBe(true);
    expect(state.channels().map((channel) => channel.id)).toEqual(["zeta"]);
  });
});

it("marks same-label identity replacement as edited without changing notification recipients", () => {
  const original = message(alice, channel, "Hello @Mic", 10, [
    ["p", bob.pubkey],
  ]);
  const replacement = signed(alice, {
    kind: 40003,
    content: "Hello @Mic",
    created_at: 11,
    tags: [
      ["h", channel],
      ["e", original.id],
      ["buzz:mention-snapshot", "1"],
      ["mention", relay.pubkey, "Mic"],
    ],
  });
  const [edited] = foldMessages(channel, relay.pubkey, [original, replacement]);
  expect(edited?.edited).toBe(true);
  expect(edited?.mentions).toEqual([bob.pubkey]);
  expect(
    foldMessages(channel, relay.pubkey, [original])[0]?.edited,
  ).toBeUndefined();
});

it("classifies generic imeta files and validates file metadata", () => {
  const hash = `${"a".repeat(64)}.pdf`;
  const badName = "%zz";
  const event = message(keypair(), "channel", "", 1, [
    [
      "imeta",
      "url https://x.test/docs/report.pdf",
      "m application/pdf",
      "size 1536",
    ],
    ["imeta", "url https://x.test/audio.mp3", "m audio/mpeg"],
    [
      "imeta",
      `url https://x.test/relay/${hash}`,
      "m application/pdf",
      "size 0",
    ],
    [
      "imeta",
      "url https://x.test/broken.bin",
      "m application/octet-stream",
      "size 1.5",
    ],
    [
      "imeta",
      "url https://x.test/oversized.dat",
      "m application/octet-stream",
      `size ${"9".repeat(20)}`,
    ],
    ["imeta", `url https://x.test/${badName}`, "m application/octet-stream"],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    {
      url: "https://x.test/docs/report.pdf",
      kind: "file",
      mime: "application/pdf",
      size: 1536,
      name: "report.pdf",
    },
    {
      url: "https://x.test/audio.mp3",
      kind: "audio",
      mime: "audio/mpeg",
      name: "audio.mp3",
    },
    {
      url: `https://x.test/relay/${hash}`,
      kind: "file",
      mime: "application/pdf",
    },
    {
      url: "https://x.test/broken.bin",
      kind: "file",
      mime: "application/octet-stream",
      name: "broken.bin",
    },
    {
      url: "https://x.test/oversized.dat",
      kind: "file",
      mime: "application/octet-stream",
      name: "oversized.dat",
    },
    {
      url: `https://x.test/${badName}`,
      kind: "file",
      mime: "application/octet-stream",
      name: badName,
    },
  ]);
});

it("classifies imeta media mime types case-insensitively", () => {
  const event = message(keypair(), "channel", "", 1, [
    ["imeta", "url https://x.test/photo", "m Image/PNG"],
    ["imeta", "url https://x.test/movie", "m Video/MP4"],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    {
      url: "https://x.test/photo",
      kind: "image",
      mime: "Image/PNG",
      name: "photo",
    },
    {
      url: "https://x.test/movie",
      kind: "video",
      mime: "Video/MP4",
      name: "movie",
    },
  ]);
});

it("classifies legacy extension attachments without a mime type", () => {
  const event = message(keypair(), "channel", "", 1, [
    ["imeta", "url https://x.test/photo.avif"],
    ["imeta", "url https://x.test/movie.webm"],
    ["imeta", "url https://x.test/archive"],
    ["imeta", "url https://x.test/archive.bin"],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    { url: "https://x.test/photo.avif", kind: "image", name: "photo.avif" },
    { url: "https://x.test/movie.webm", kind: "video", name: "movie.webm" },
    { url: "https://x.test/archive", kind: "file", name: "archive" },
    { url: "https://x.test/archive.bin", kind: "file", name: "archive.bin" },
  ]);
});

it.each([["RLO", "report%E2%80%AEexe.pdf"]])(
  "rejects %s URL-derived attachment names",
  (_case, segment) => {
    const event = message(keypair(), "channel", "", 1, [
      ["imeta", `url https://x.test/${segment}`, "m application/pdf"],
    ]);
    expect(parseAttachments(event, [])).toEqual([
      {
        url: `https://x.test/${segment}`,
        kind: "file",
        mime: "application/pdf",
      },
    ]);
  },
);

it("accepts ordinary unicode URL-derived attachment names", () => {
  const event = message(keypair(), "channel", "", 1, [
    [
      "imeta",
      "url https://x.test/r%C3%A9sum%C3%A9-%E6%9C%88%E5%A0%B1.pdf",
      "m application/pdf",
    ],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    {
      url: "https://x.test/r%C3%A9sum%C3%A9-%E6%9C%88%E5%A0%B1.pdf",
      kind: "file",
      mime: "application/pdf",
      name: "résumé-月報.pdf",
    },
  ]);
});

it.each([
  ["700x900", { width: 700, height: 900 }],
  ["1x999999", { width: 1, height: 999999 }],
  [undefined, undefined],
  ["0x900", undefined],
  ["700x0", undefined],
  ["1x2px", undefined],
  ["1000000x2", undefined],
  ["1x2x3", undefined],
])("validates attachment layout dimensions %s", (dim, dimensions) => {
  const event = message(keypair(), "channel", "", 1, [
    [
      "imeta",
      "url https://x.test/image.png",
      "m image/png",
      ...(dim ? [`dim ${dim}`] : []),
    ],
  ]);
  const attachments = parseAttachments(event, [
    "https://x.test/image.png",
    "https://x.test/legacy.png",
  ]);
  expect(attachments).toEqual([
    {
      url: "https://x.test/image.png",
      kind: "image",
      mime: "image/png",
      name: "image.png",
      ...(dimensions ? { dimensions } : {}),
    },
    { url: "https://x.test/legacy.png", kind: "image" },
  ]);
});

it.each([
  "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  "000000", // 1x1
  `|000${"00".repeat(81)}`, // maximum 9x9
  undefined,
  "short",
  "LEHV6nWB2yk8pyo0adR*.7kCMdn!", // invalid alphabet
  "LEHV6nWB2yk8pyo0adR*.7kCMdn", // truncated
  `~000${"00".repeat(18)}`, // illegal size flag, despite matching length
  "0".repeat(10000),
])("preserves only bounded valid attachment blurhash: %s", (hash) => {
  const valid =
    hash === "LEHV6nWB2yk8pyo0adR*.7kCMdnj" ||
    hash === "000000" ||
    hash?.startsWith("|");
  const event = message(keypair(), "channel", "", 1, [
    [
      "imeta",
      "url https://x.test/original.png",
      "m image/png",
      "thumb https://x.test/thumbnail.png",
      ...(hash === undefined ? [] : [`blurhash ${hash}`]),
    ],
  ]);
  expect(parseAttachments(event, ["https://x.test/legacy.png"])).toEqual([
    {
      url: "https://x.test/original.png",
      kind: "image",
      mime: "image/png",
      name: "original.png",
      ...(valid ? { blurhash: hash } : {}),
      previewUrl: "https://x.test/thumbnail.png",
    },
    { url: "https://x.test/legacy.png", kind: "image" },
  ]);
});

it("classifies voice-note mp4 metadata as audio with validated duration and filename", () => {
  const url = "https://x.test/media/hash";
  const event = message(keypair(), "channel", "", 1, [
    [
      "imeta",
      `url ${url}`,
      "m video/mp4",
      "filename voice-note-1.mp4",
      "duration 12.3",
    ],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    {
      url,
      kind: "audio",
      mime: "video/mp4",
      name: "voice-note-1.mp4",
      voiceNote: true,
      duration: 12.3,
    },
  ]);
});

it.each([
  ["Video/MP4", "Voice-Note-1.MP4"],
  ['video/mp4; codecs="avc1.42E01E,mp4a.40.2"', "voice-note-parameterized.mp4"],
])("classifies voice-note mp4 metadata as audio for mime %s", (mime, name) => {
  const url = "https://x.test/media/hash";
  const event = message(keypair(), "channel", "", 1, [
    ["imeta", `url ${url}`, `m ${mime}`, `filename ${name}`],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    {
      url,
      kind: "audio",
      mime,
      name,
      voiceNote: true,
    },
  ]);
});

it("detects legacy voice-note mp4s from the link label when filename is absent", () => {
  const url = "https://x.test/media/hash";
  const event = message(keypair(), "channel", `[voice-note-2.mp4](${url})`, 1, [
    ["imeta", `url ${url}`, "m video/mp4"],
  ]);
  const [row] = foldMessages("channel", relay.pubkey, [event]);
  expect(row?.attachments).toEqual([
    {
      url,
      kind: "audio",
      mime: "video/mp4",
      name: "voice-note-2.mp4",
      voiceNote: true,
    },
  ]);
});

it("keeps video/mp4V-ES voice-note-shaped attachments classified as video", () => {
  const event = message(keypair(), "channel", "", 1, [
    [
      "imeta",
      "url https://x.test/voice-note-fallback.mp4",
      "m video/mp4V-ES",
      "filename voice-note-1.mp4",
    ],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    {
      url: "https://x.test/voice-note-fallback.mp4",
      kind: "video",
      mime: "video/mp4V-ES",
      name: "voice-note-1.mp4",
    },
  ]);
});

it("accepts maximum bounded attachment duration", () => {
  const event = message(keypair(), "channel", "", 1, [
    ["imeta", "url https://x.test/song.mp3", "m audio/mpeg", "duration 86400"],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    {
      url: "https://x.test/song.mp3",
      kind: "audio",
      mime: "audio/mpeg",
      name: "song.mp3",
      duration: 86400,
    },
  ]);
});

it.each(["0", " 12 ", "0x10", "86400.1"])(
  "rejects invalid attachment duration %s",
  (duration) => {
    const event = message(keypair(), "channel", "", 1, [
      [
        "imeta",
        "url https://x.test/song.mp3",
        "m audio/mpeg",
        `duration ${duration}`,
      ],
    ]);
    expect(parseAttachments(event, [])).toEqual([
      {
        url: "https://x.test/song.mp3",
        kind: "audio",
        mime: "audio/mpeg",
        name: "song.mp3",
      },
    ]);
  },
);

it("rejects control characters in imeta filenames", () => {
  const event = message(keypair(), "channel", "", 1, [
    [
      "imeta",
      "url https://x.test/hash",
      "m application/pdf",
      "filename report\nfinal.pdf",
    ],
  ]);
  expect(parseAttachments(event, [])).toEqual([
    {
      url: "https://x.test/hash",
      kind: "file",
      mime: "application/pdf",
      name: "hash",
    },
  ]);
});

it("uses attachment name precedence link label before filename before basename", () => {
  const event = message(
    keypair(),
    "channel",
    "[Link Name](https://x.test/one.pdf)",
    1,
    [
      [
        "imeta",
        "url https://x.test/one.pdf",
        "m application/pdf",
        "filename File Name.pdf",
      ],
      [
        "imeta",
        "url https://x.test/two.pdf",
        "m application/pdf",
        "filename File Name.pdf",
      ],
      ["imeta", "url https://x.test/three.pdf", "m application/pdf"],
    ],
  );
  const [row] = foldMessages("channel", relay.pubkey, [event]);
  expect(row?.attachments.map((attachment) => attachment.name)).toEqual([
    "Link Name",
    "File Name.pdf",
    "three.pdf",
  ]);
});

it("retains latest raw edit source through attachment projection and row sharing", () => {
  const url = "https://relay.test/media/report.pdf";
  const original = message(alice, channel, `Caption [Report](${url})`, 10, [
    ["imeta", `url ${url}`, "m application/pdf"],
  ]);
  const edit = (content: string, created_at: number) =>
    signed(alice, {
      kind: 40003,
      content,
      created_at,
      tags: [
        ["h", channel],
        ["e", original.id],
      ],
    });
  const first = edit(`Caption [Report](${url} "Old title")`, 11);
  const second = edit(`Caption [Report](${url} "New title")`, 12);
  const before = foldMessages(channel, relay.pubkey, [original, first]);
  const next = foldMessages(channel, relay.pubkey, [original, first, second]);
  expect(next[0]?.content).toBe(before[0]?.content);
  expect(next[0]?.attachments).toEqual(before[0]?.attachments);
  expect(next[0]?.sourceContent).toBe(second.content);
  expect(shareMessageRows(before, next)[0]).toBe(next[0]);
  expect(
    shareMessageRows(
      next,
      foldMessages(channel, relay.pubkey, [original, first, second]),
    ),
  ).toBe(next);
});

it("keeps signed reference identities separate from addressed recipients", () => {
  const event = message(alice, channel, "@Bob", 10, [
    ["mention", bob.pubkey],
    ["mention", bob.pubkey],
    ["mention", relay.pubkey, "agent-address"],
    ["mention", "invalid"],
  ]);
  const [row] = foldMessages(channel, relay.pubkey, [event]);
  expect(row?.mentions).toEqual([]);
  expect(row?.mentionReferences).toEqual([bob.pubkey]);
});

it.each(mentionConformance.tags.read)(
  "conforms to the portable mention tag reading contract: $name",
  (fixture) => {
    const [row] = foldMessages(channel, relay.pubkey, [
      message(alice, channel, "@Someone", 10, fixture.tags),
    ]);
    expect({
      mentions: row?.mentions,
      references: row?.mentionReferences,
    }).toEqual(fixture.expected);
  },
);

it("applies an agent owner's edit only with ownership evidence for that author", () => {
  const original = message(alice, channel, "Whole answer", 10);
  const edit = signed(bob, {
    kind: 40003,
    content: "Spoken prefix",
    created_at: 11,
    tags: [
      ["e", original.id],
      ["h", channel],
    ],
  });
  const fold = (owner: string | undefined) =>
    foldMessages(channel, relay.pubkey, [original, edit], {
      agentOwner: (pubkey: string) =>
        pubkey === alice.pubkey ? owner : undefined,
    } as never)[0]?.content;
  expect(fold(undefined)).toBe("Whole answer");
  expect(fold(relay.pubkey)).toBe("Whole answer");
  expect(fold(bob.pubkey)).toBe("Spoken prefix");
});

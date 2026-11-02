import { verifiedSymbol } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { EventData, RelayEvent } from "./events";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import { flush } from "./testing";
import { createUnread } from "./unread";

// What the unread owner hands `foldMessages` for each channel. With
// `previous` set, every call folds those events instead: all retained
// evidence, as each call did before the owner folded a channel's own.
const folds = vi.hoisted(() => ({
  calls: [] as { channelId: string; events: readonly EventData[] }[],
  previous: undefined as readonly EventData[] | undefined,
}));
vi.mock("./fold", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fold")>();
  return {
    ...actual,
    foldMessages: (
      ...[channelId, relayAuthor, events, options]: Parameters<
        typeof actual.foldMessages
      >
    ) => {
      folds.calls.push({ channelId, events });
      return actual.foldMessages(
        channelId,
        relayAuthor,
        folds.previous ?? events,
        options,
      );
    },
  };
});

// Events are marked verified instead of signed, as in unread-repair.test.ts.
let next = 0;
function event(
  kind: number,
  pubkey: string,
  created_at: number,
  tags: string[][],
  content = "",
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind,
    created_at,
    content,
    tags,
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const viewer = "a".repeat(64),
  alice = "b".repeat(64),
  bob = "c".repeat(64);
const post = (
  channelId: string,
  pubkey: string,
  at: number,
  content: string,
  tags: string[][] = [],
) => event(9, pubkey, at, [["h", channelId], ...tags], content);
const mention = (channelId: string, at: number, content: string) =>
  post(channelId, alice, at, content, [["p", viewer]]);
const reply = (
  channelId: string,
  root: RelayEvent,
  at: number,
  content: string,
  tags: string[][] = [],
) =>
  post(channelId, alice, at, content, [["e", root.id, "", "reply"], ...tags]);
const edit = (
  pubkey: string,
  target: RelayEvent,
  at: number,
  content: string,
  channelId?: string,
) =>
  event(
    40003,
    pubkey,
    at,
    [...(channelId ? [["h", channelId]] : []), ["e", target.id]],
    content,
  );
// With no `h`, as a deletion may be sent; the relay files it under its target.
const deletion = (target: RelayEvent, at: number) =>
  event(5, alice, at, [["e", target.id]]);

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  folds.calls = [];
  folds.previous = undefined;
});

async function setup(
  list: readonly Pick<ChannelSummary, "id" | "channelType">[],
) {
  let journal: ReadJournal | undefined = newReadJournal();
  const reader = { read: vi.fn(async () => [] as RelayEvent[]) };
  const reads = createReadState({
    viewer,
    reader,
    host: undefined,
    storage: {
      async update(change) {
        journal = readJournal(change(journal), viewer);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  const channels: ChannelQueries = {
    list: () => ({
      status: "ready" as const,
      channels: list.map((channel) => ({
        ...channel,
        name: channel.id,
        members: [viewer],
      })),
    }),
    subscribeList: () => () => {},
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  const owner = createUnread({ reads, channels, reader, viewer });
  owners.push(owner);
  return owner;
}

it("folding each channel's own evidence with the edits and deletions on it shows what folding every retained event did", async () => {
  const list = [
    { id: "room" },
    { id: "other" },
    { id: "dm", channelType: "dm" as const },
    { id: "solo", channelType: "solo" as const },
  ];
  const edited = mention("room", 100, "m1");
  const foreign = mention("room", 101, "m2");
  const gone = mention("room", 102, "m3");
  const restored = mention("room", 103, "m4");
  const restoredEdit = edit(alice, restored, 113, "m4 edit, deleted", "room");
  const elsewhere = mention("room", 104, "m5");
  const reacted = mention("room", 105, "m6");
  const root = post("room", viewer, 106, "my thread");
  const answers = [107, 108].map((at) => reply("room", root, at, `a${at}`));
  const last = answers[1] as RelayEvent;
  // A reply in another channel naming this thread's root.
  const crossing = reply("other", root, 200, "crossing", [["p", viewer]]);
  const direct = [
    post("dm", alice, 300, "hi", [["p", viewer]]),
    post("dm", alice, 301, "there"),
  ];
  const session = [
    post("solo", alice, 400, "s1"),
    mention("solo", 401, "s2"),
    // Not Inbox evidence, but the session row shows it as its newest.
    post("solo", alice, 402, "s3"),
  ];
  const reaction = event(7, bob, 120, [
    ["h", "room"],
    ["e", reacted.id],
  ]);
  const fixture = [
    edited,
    foreign,
    gone,
    restored,
    elsewhere,
    reacted,
    root,
    ...answers,
    crossing,
    ...direct,
    ...session,
    edit(alice, edited, 110, "m1 edited", "room"),
    // Another sender's edit, which the fold does not apply.
    edit(bob, foreign, 111, "m2 edited by bob", "room"),
    deletion(gone, 112),
    restoredEdit,
    deletion(restoredEdit, 114),
    // An edit naming another channel than its target's.
    edit(alice, elsewhere, 115, "m5 edited from other", "other"),
    edit(alice, last, 116, "a108 edited", "room"),
    edit(alice, crossing, 210, "crossing edited", "other"),
    edit(alice, direct[1] as RelayEvent, 310, "there!", "dm"),
    edit(alice, session[2] as RelayEvent, 410, "s3 edited", "solo"),
    reaction,
  ];
  const current = await setup(list),
    previous = await setup(list);
  current.accept(fixture);
  previous.accept(fixture);
  // Retained in admission order, which is what each call used to fold;
  // reactions are not unread evidence.
  const retained = fixture.filter((item) => previous.event(item.id));
  expect(retained).toEqual(fixture.filter((item) => item !== reaction));
  const look = (
    owner: ReturnType<typeof createUnread>,
    everything?: readonly RelayEvent[],
  ) => {
    folds.previous = everything;
    try {
      const { capability } = owner;
      return {
        inbox: capability.inbox(),
        channels: list.map(({ id }) => ({
          activity: capability.activity(id),
          snapshot: capability.snapshot({ kind: "channel", channelId: id }),
        })),
      };
    } finally {
      folds.previous = undefined;
    }
  };
  const shown = look(current);
  expect(
    Object.fromEntries(
      shown.inbox.items.map((item) => [item.previewMessageId, item.preview]),
    ),
  ).toEqual({
    [edited.id]: "m1 edited",
    [foreign.id]: "m2",
    [restored.id]: "m4",
    [elsewhere.id]: "m5 edited from other",
    [reacted.id]: "m6",
    [last.id]: "a108 edited",
    [crossing.id]: "crossing edited",
    [direct[1]?.id ?? ""]: "there!",
    [session[2]?.id ?? ""]: "s3 edited",
  });
  expect(shown.channels[0]?.activity.items).toEqual([
    expect.objectContaining({
      rootId: root.id,
      latestMessageId: last.id,
      preview: "a108 edited",
      unreadCount: 2,
    }),
  ]);
  expect(shown.channels.map(({ snapshot }) => snapshot.observedCount)).toEqual([
    7, 1, 2, 3,
  ]);
  expect(look(previous, retained)).toEqual(shown);
  // Again once the lookups the reads asked for have been answered.
  await flush();
  expect(look(previous, retained)).toEqual(look(current));
});

it("with 2,000 retained events across 80 channels, the Inbox folds each channel's own events and the edits and deletions on them", async () => {
  const ids = Array.from({ length: 80 }, (_, index) => `c${index}`);
  const owner = await setup(ids.map((id) => ({ id })));
  const expected = new Map<string, Set<RelayEvent>>();
  const fixture = ids.flatMap((id) => {
    const root = post(id, viewer, 1000, "my thread");
    const replies = Array.from({ length: 18 }, (_, index) =>
      reply(
        id,
        root,
        1001 + index,
        `${index}`,
        index % 3 ? [] : [["p", viewer]],
      ),
    );
    const top = mention(id, 1100, "top");
    const [first, second, third, removed] = replies as [
      RelayEvent,
      RelayEvent,
      RelayEvent,
      RelayEvent,
    ];
    const edits = [first, second, third].map((target, index) =>
      edit(alice, target, 1200 + index, "edited", id),
    );
    const overlays = [
      ...edits,
      deletion(removed, 1300),
      deletion(edits[0] as RelayEvent, 1301),
    ];
    const events = [root, ...replies, top, ...overlays];
    // The deleted reply and its deletion are no row and not folded.
    expect(events).toHaveLength(25);
    expected.set(
      id,
      new Set(
        events.filter((item) => item !== removed && item !== overlays[3]),
      ),
    );
    return events;
  });
  expect(fixture).toHaveLength(2000);
  owner.accept(fixture);
  expect(fixture.every((item) => owner.event(item.id))).toBe(true);
  const inbox = owner.capability.inbox();
  // A thread row and a mention row in each channel.
  expect(inbox.items).toHaveLength(160);
  expect(folds.calls.map(({ channelId }) => channelId).sort()).toEqual(
    [...ids].sort(),
  );
  for (const { channelId, events } of folds.calls) {
    expect(events.length).toBeLessThanOrEqual(25);
    expect(new Set(events)).toEqual(expected.get(channelId));
  }
  folds.calls = [];
  expect(owner.capability.activity("c7").items).toHaveLength(1);
  expect(folds.calls).toHaveLength(1);
  expect(new Set(folds.calls[0]?.events)).toEqual(expected.get("c7"));
});

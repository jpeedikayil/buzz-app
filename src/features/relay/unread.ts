import type { ProfileQueries } from "./profile-directory";
import { workflowOwner } from "./workflow-attribution";
import { agentAudience } from "./audience";
import type { InboxItem, InboxSnapshot } from "./inbox";
import type { ChannelQueries } from "./contracts";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import {
  effectiveFrontier,
  overrideActive,
  targetKey,
  type ReadTarget,
  type ReadState,
} from "./read-state-model";
import type {
  createReadState,
  ReadMutationResult,
  ReadSyncSnapshot,
} from "./read-state";
import type { ReadJournal } from "./read-state-storage";
import { markMessage } from "./read-state-retention";
import type { Priority, RelayReader } from "./reader";
import { isOversizedResponse } from "./errors";
import { listByteSize } from "./budget";
import { matchesEvent } from "./projection";
import { yieldToHost } from "./yield";
import { clientMetrics } from "../developer/client-metrics";
import { foldMessages, deletionApplies, messageAuthor } from "./fold";
import { eventMs } from "./message-order";
import { threadReference } from "./thread-reference";
import {
  UNREAD_CONTENT_KINDS,
  UNREAD_WINDOW_BATCH,
} from "./unread-window-batch";
import {
  memoryThreadFollows,
  THREAD_FOLLOW_LIMIT,
  type ThreadFollows,
  type ThreadFollowStorage,
} from "./thread-follows";
import {
  NO_THREAD_PARTICIPATION,
  THREAD_PARTICIPATION_LIMIT,
  type ThreadMark,
  type ThreadParticipation,
} from "./thread-participation";
import {
  memoryUnreadStorage,
  UNREAD_RECORD_BYTES,
  UNREAD_RECORD_EVENTS,
  UnreadRecordPurged,
  type UnreadMark,
  type UnreadRecord,
  type UnreadStorage,
} from "./unread-storage";

export type UnreadSnapshot = Readonly<{
  target: ReadTarget;
  /** Latest verified content evidence, including read and self-authored messages. */
  latestMessage?: Readonly<{ id: string; createdAt: number }>;
  /** null means unobserved/denied, never a fabricated zero or an exact relay total. */
  observedCount: number | null;
  attentionCount: number | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  manual: "none" | "local-only" | "remote";
  error?: string | undefined;
}>;
export type MessageAttention = Readonly<{
  status: "unknown" | "ineligible" | "eligible";
  category?: "mention" | "direct" | "thread";
  /** The event mentions the viewer, excluding trusted workflow-owner attribution. */
  mentioned?: boolean;
  rootId?: string;
  /** The reply's conversation is still being looked up; it may become thread
   * attention when the lookup finishes. */
  pending?: boolean;
  unread: boolean;
  /** This row is explicitly forced unread during the current channel visit. */
  forced: boolean;
  viewing: boolean;
}>;
export type ThreadActivityItem = Readonly<{
  channelId: string;
  rootId: string;
  latestMessageId: string;
  authorId: string;
  workflowOwnerId?: string | undefined;
  createdAt: number;
  preview: string;
  unreadCount: number;
}>;
export type ThreadActivitySnapshot = Readonly<{
  channelId: string;
  /** null means activity evidence is unknown or access is denied. */
  items: readonly ThreadActivityItem[] | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
export type ReadingHandle = Readonly<{
  /** Qualified visible rows only. This publishes no read intent and ends with the
   * lease. `visible` decides each of this channel's rows; `measured` says the
   * row is among `messageIds`. A consumer that is re-measuring may confirm any
   * of its rows on demand instead. */
  view(
    messageIds: readonly string[],
    visible: (messageId: string, measured: boolean) => boolean,
  ): void;
  /** Only message IDs actually visible to the active consumer; no caller timestamps. */
  observe(messageIds: readonly string[]): Promise<void>;
  /** Bottom dwell through verified evidence; channel catch-up reads the
   * timeline's mentions and broadcasts by message, never other replies. */
  catchUp(messageId: string, rootId?: string): Promise<void>;
  dispose(): void;
}>;
export interface UnreadCapability {
  inbox(): InboxSnapshot;
  subscribeInbox(listener: () => void): () => void;
  snapshot(target: ReadTarget): UnreadSnapshot;
  /** Same verified attention/frontier policy as badges, not a notification event source. */
  attention(channelId: string, messageId: string): MessageAttention;
  subscribe(target: ReadTarget, listener: () => void): () => void;
  activity(channelId: string): ThreadActivitySnapshot;
  subscribeActivity(channelId: string, listener: () => void): () => void;
  sync(): ReadSyncSnapshot;
  subscribeSync(listener: () => void): () => void;
  ensure(): Promise<void>;
  refresh(): Promise<void>;
  retrySync(): Promise<void>;
  /** Durable local intent revision, not sync-health changes. */
  revision(): number;
  /** Access/cache/connection retirement fence. */
  generation(): number;
  reading(channelId: string): ReadingHandle;
  /** Whether the viewer follows this canonical root: an explicit choice,
   * otherwise writing or replying anywhere in its thread. */
  following(channelId: string, rootId: string): boolean;
  /** Saves an explicit choice on this device; throws, unchanged, if not saved.
   * Wakes `subscribeSync` listeners. */
  follow(channelId: string, rootId: string, following: boolean): void;
  /** Explicit prefix intent, unlike individual-message visibility observations. */
  markThrough(
    target: ReadTarget,
    messageId: string,
  ): Promise<ReadMutationResult>;
  /** One immediate menu action over the selected verified message and loaded reply subtree. */
  markMessageUnread(
    channelId: string,
    messageId: string,
  ): Promise<ReadMutationResult>;
  markMessageRead(
    channelId: string,
    messageId: string,
  ): Promise<ReadMutationResult>;
  /** End the channel visit; the device-local sidebar force remains until next open. */
  leaveChannel(channelId: string): void;
  /** Reconcile the previous visit's sidebar force without clearing independent channel intent. */
  enterChannel(channelId: string): Promise<void>;
  /** Explicit channel prefix through retained verified evidence, including replies. */
  markChannelRead(channelId: string): Promise<ReadMutationResult>;
  /** Capture one prefix/time cut; each invocation queues that same intent for retry. */
  prepareChannelRead(channelId: string): () => Promise<ReadMutationResult>;
  /** `markChannelRead` serialised over every accessible listed channel that still
   * shows unread evidence or a local mark. Channels with nothing to clear are
   * skipped, so an already-read community costs no writes. One failing channel
   * does not stop the rest; the first failure is rethrown after the sweep. */
  markAllChannelsRead(): Promise<readonly ReadMutationResult[]>;
  markUnreadLocal(target: ReadTarget): Promise<ReadMutationResult>;
  clearUnreadLocal(target: ReadTarget): Promise<ReadMutationResult>;
  readonly syncedManualUnread: false;
}
/** Rendered message order: effective ms, then event id. */
const order = (a: RelayEvent, b: RelayEvent) =>
  eventMs(a) - eventMs(b) || a.id.localeCompare(b.id);
const contentKind = (event: RelayEvent) =>
  event.kind === 9 || event.kind === 40002 || event.kind === 40008;
const channelIds = new WeakMap<RelayEvent, string | undefined>();
/** Verified events are frozen, and every evidence index asks for each one. */
const channelOf = (event: RelayEvent) => {
  if (channelIds.has(event)) return channelIds.get(event);
  const tags = event.tags.filter(([name]) => name === "h");
  const channelId = tags.length === 1 ? tags[0]?.[1] : undefined;
  channelIds.set(event, channelId);
  return channelId;
};
const auxiliaryKind = (event: RelayEvent) =>
  event.kind === 40003 || event.kind === 5 || event.kind === 9005;
/** Resolve every owning channel through bounded reference-only auxiliary ancestry.
 * A missing target, cycle, or unsupported intermediary fails closed. */
function channelOwnership(find: (id: string) => RelayEvent | undefined) {
  const memo = new Map<string, ReadonlySet<string> | undefined>();
  const visiting = new Set<string>();
  function owners(event: RelayEvent): ReadonlySet<string> | undefined {
    if (memo.has(event.id)) return memo.get(event.id);
    if (visiting.has(event.id) || visiting.size >= 32) return;
    visiting.add(event.id);
    const direct = channelOf(event);
    let resolved: Set<string> | undefined;
    if (contentKind(event)) {
      if (direct) resolved = new Set([direct]);
    } else if (auxiliaryKind(event)) {
      resolved = direct ? new Set([direct]) : new Set();
      const targets = event.tags.flatMap(([name, id]) =>
        name === "e" && id ? [id] : [],
      );
      if (!direct && !targets.length) resolved = undefined;
      for (const id of targets) {
        const target = find(id);
        const inherited = target && owners(target);
        if (!inherited) {
          resolved = undefined;
          break;
        }
        for (const channel of inherited) resolved?.add(channel);
      }
      if (!resolved?.size) resolved = undefined;
    }
    visiting.delete(event.id);
    memo.set(event.id, resolved);
    return resolved;
  }
  return owners;
}
/** Bounded verified evidence and one projection; no sidebar counters, sockets or implicit reads. */
export function createUnread({
  reads,
  channels,
  reader,
  viewer,
  relayAuthor,
  signingAuthority,
  workflowAuthority,
  profiles,
  notify = (listener) => listener(),
  follows = memoryThreadFollows(),
  storage = memoryUnreadStorage(),
  now = () => Date.now(),
}: {
  reads: ReturnType<typeof createReadState>;
  channels: ChannelQueries;
  reader: RelayReader;
  viewer: string;
  relayAuthor?: string;
  signingAuthority?: string;
  workflowAuthority?: string | undefined;
  profiles?: ProfileQueries;
  notify?: (listener: () => void) => void;
  follows?: ThreadFollowStorage;
  storage?: UnreadStorage;
  /** For the never-read channel window floor and the age of the mark's
   * confirmation (see `route`); reading never uses the clock. */
  now?: () => number;
}) {
  let closed = false,
    epoch = 0;
  let requested = false;
  let repairAgain = false;
  // Whether the running repair catches up (see `route`): one an access
  // change retires is read again the same way, so a retired explicit refresh
  // still reads the bootstrap, and an explicit refresh that finds it running
  // has the next one read the bootstrap.
  let catchingUp = false;
  let freshness: UnreadSnapshot["freshness"] = "unknown";
  /** A repair failed or the stream dropped, and no repair has completed
   * since. Live traffic marks evidence observed again but does not pay this. */
  let owing = false;
  let error: string | undefined;
  let refresh: Promise<void> | undefined;
  const lifetime = new AbortController();
  const events = new Map<string, RelayEvent>();
  const known = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, UnreadSnapshot>();
  const dirty = new Set<string>();
  const activityListeners = new Map<string, Set<() => void>>();
  const activitySnapshots = new Map<string, ThreadActivitySnapshot>();
  const activityDirty = new Set<string>();
  const inboxListeners = new Set<() => void>();
  let inboxSnapshot: InboxSnapshot | undefined;
  let inboxDirty = true;
  let inboxLoading = false;
  // The last repair dropped a request after its retry (see `pool`).
  let partial = false;
  const handles = new Set<() => void>();
  const views = new Map<
    () => void,
    {
      channelId: string;
      ids: ReadonlySet<string>;
      visible: (messageId: string, measured: boolean) => boolean;
    }
  >();
  // Per-visit message overlay; only the sidebar hint is persisted in read state.
  const forcedMessages = new Map<string, Set<string>>();
  const entered = new Set<string>();
  const messageForceKey = (channelId: string) => `message-force:${channelId}`;
  const visits = new Map<string, number>();
  const mutations = new Map<string, Promise<unknown>>();
  // Explicit channel reads survive unrelated roster changes, but never their
  // own revoke/regrant or a session/cache reset. Tokens cannot be revived.
  const channelReadGenerations = new Map<string, object>();
  function serialize<T>(
    channelId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = mutations.get(channelId) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    mutations.set(channelId, settled);
    void settled.then(() => {
      if (mutations.get(channelId) === settled) mutations.delete(channelId);
    });
    return next;
  }

  let bytes = 0;
  // Per member list: a large channel would otherwise be scanned for the
  // viewer on every event.
  const viewerIn = new WeakMap<readonly string[], boolean>();
  const member = (members: readonly string[] | undefined) => {
    if (!members) return false;
    let found = viewerIn.get(members);
    if (found === undefined) {
      found = members.includes(viewer);
      if (Object.isFrozen(members)) viewerIn.set(members, found);
    }
    return found;
  };
  const allowed = (id: string) =>
    channels
      .list()
      .channels.some(
        (channel) =>
          channel.id === id && !channel.cached && member(channel.members),
      );
  const keyFor = (target: ReadTarget) =>
    `${target.channelId}:${targetKey(target)}`;
  /** Counted evidence, or a fetched parent/root kept only for structure. */
  const structural = (id: string) => events.get(id) ?? lookupEvents.get(id);
  function root(event: RelayEvent): string | undefined {
    const channel = channelOf(event);
    let current = event;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current.id)) return;
      seen.add(current.id);
      const reference = threadReference(current);
      if (!reference) return current.id;
      const next = structural(reference.rootId);
      if (!next || !contentKind(next) || channelOf(next) !== channel) return;
      current = next;
    }
  }
  type Evidence = {
    event: RelayEvent;
    channelId: string;
    rootId: string | undefined;
    /** Direct parent of a reply; undefined for top-level messages. */
    parentId: string | undefined;
    /** The reply's canonical marked root, which explicit follows key on. */
    threadRootId: string | undefined;
    mentioned: boolean;
    broadcast: boolean;
    /** Signed `audience=agents`: coordination between agents, which people
     * see quietly. It never counts or earns attention. */
    quiet: boolean;
  };
  let indexed = false;
  const byChannel = new Map<string, Evidence[]>();
  const byId = new Map<string, Evidence>();
  const tombstones = new Set<string>();
  // Conversation membership: the viewer's own messages, and the parents the
  // viewer has replied to, each keyed by channel. A conversation is the set of
  // replies to one parent.
  const own = new Map<string, string>();
  const joined = new Set<string>();
  // `channel:root` of every thread the viewer wrote or replied in, from
  // retained messages and lookup witnesses: the automatic follow.
  const ownThreads = new Set<string>();
  // `channel:root` of the threads the viewer is part of, with the newest
  // time they wrote or read in each (see thread-participation.ts). Read from
  // storage by the first repair, extended and read again by every repair, and
  // evicted last when retained evidence overflows. The live map is bounded by
  // what the walk, the evidence and follows can teach; the 1,000 limit is
  // applied where it is read (`newest()`) and in the saved record.
  let remembered: Map<string, ThreadMark> | undefined;
  // The threads the next repair starts from, with the walk mark: read from
  // storage once, then what the last repair saved.
  let persisted: ThreadParticipation | undefined;
  // The record's mark and whether it is complete (see unread-storage.ts):
  // read with it, then what this session confirmed and last saved. Together
  // they choose a pass's reads (see `route`).
  let mark: UnreadMark | undefined;
  let complete = false;
  // The channels the mark covers and the remembered threads read whole (see
  // unread-storage.ts), read with the record, then what this session
  // confirmed: a pass that catches up reads a channel not `covered` once,
  // and a hot thread not `whole` whole (see `route`). A channel left since
  // the roster sample was read owes the sample again, deeper, and until
  // then a save is not complete.
  const covered = new Set<string>();
  let whole = new Set<string>();
  let resample = false;
  // Roots the relay returned nothing for when asked by ID, read with the
  // record too, so a remembered thread whose root was deleted does not leave
  // every save incomplete (see `retention`); the newest 1,024.
  const absent = new Set<string>();
  const pinned = (event: RelayEvent) => {
    const channel = channelOf(event);
    return (
      channel !== undefined &&
      !!remembered?.has(
        conversationKey(channel, threadReference(event)?.rootId ?? event.id),
      )
    );
  };
  // Relay lookups for parents the sampled windows cannot decide. They are kept
  // apart from counted evidence: fetched events never count, never fill the
  // windows and survive their eviction, because whether the viewer wrote or
  // answered a message does not change with the sample. Bounded, oldest first.
  // Keyed by channel and parent, like `joined`. `evidence` is one of the
  // viewer's messages that make the viewer a member (the parent itself, or a
  // reply to it), held as a witness; `more` records that the viewer has
  // others. The viewer's own parent is preferred, and the first witness is
  // kept. Deleting the witness ends the membership, or asks again if `more`.
  // One witness per lookup keeps every positive lookup within the witness
  // bound, however many replies one batch returns.
  type Lookup = {
    channelId: string;
    done: boolean;
    evidence: string | undefined;
    more: boolean;
    /** A structure lookup whose root the cache has let go since. */
    released?: boolean;
  };
  const lookups = new Map<string, Lookup>();
  const lookupEvents = new Map<string, RelayEvent>();
  const rememberedRoot = (event: RelayEvent) =>
    !threadReference(event) && pinned(event);
  // How many remembered threads' roots the structure cache holds, counted
  // for the remembered set as it was (which only grows in place), and
  // counted again once it changes or structure is let go elsewhere.
  let heldRoots:
    | { of: typeof remembered; size: number; count: number }
    | undefined;
  const queued = new Map<
    string,
    {
      channelId: string;
      parentId: string;
      rootId: string | undefined;
      ids: Set<string>;
      structuralOnly: boolean;
      /** The reply whose root this structure lookup fetches, when its thread
       * is one the participation pass would learn from it. */
      taught: RelayEvent | undefined;
    }
  >();
  // The viewer's own deleted messages, so neither a stored lookup result nor
  // one still in flight can outlive them.
  const retracted = new Set<string>();
  // The viewer's messages behind positive lookups, kept so a deletion from
  // another client can be verified (see `event`) after the window drops them.
  // They are not counted evidence. Evicting one forgets the lookups it backs,
  // so a membership never outlives the means to observe its deletion. Callers
  // remember a lookup before witnessing it, so eviction always sees it.
  const witnesses = new Map<string, RelayEvent>();
  const conversationKey = (channelId: string, parentId: string) =>
    `${channelId}:${parentId}`;
  function witness(lookup: Lookup, event: RelayEvent) {
    // Keep the first witness: replacing it could hide the deletion of a
    // cached parent that a later lookup would reuse.
    if (lookup.evidence !== undefined && lookup.evidence !== event.id) {
      lookup.more = true;
      return;
    }
    lookup.evidence = event.id;
    witnesses.delete(event.id);
    witnesses.set(event.id, event);
    for (const [oldest] of witnesses) {
      if (witnesses.size <= 4096) break;
      witnesses.delete(oldest);
      for (const [key, other] of lookups)
        if (other.evidence === oldest) lookups.delete(key);
    }
  }
  let scheduled = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const membershipListeners = new Set<() => void>();
  function mentionsViewer(event: RelayEvent): boolean {
    const tagged = (name: string, value: string) =>
      event.tags.some((tag) => tag[0] === name && tag[1] === value);
    if (!tagged("p", viewer)) return false;
    // The relay also p-tags the workflow owner for attribution. Only trusted
    // kind-9 workflow output may disambiguate that tag; ordinary senders cannot
    // use workflow metadata to suppress a mention. Other recipients keep p-tag
    // semantics: workflow-mention is template provenance, not every recipient.
    if (
      event.kind === 9 &&
      relayAuthor &&
      event.pubkey === relayAuthor &&
      tagged("buzz:workflow", "true") &&
      tagged("buzz:workflow-owner", viewer)
    )
      return tagged("buzz:workflow-mention", viewer);
    return true;
  }
  function indexEvidence() {
    if (indexed) return;
    indexed = true;
    byChannel.clear();
    byId.clear();
    tombstones.clear();
    own.clear();
    joined.clear();
    ownThreads.clear();
    for (const event of events.values()) {
      if (event.kind !== 5 && event.kind !== 9005) continue;
      for (const [name, id] of event.tags) {
        const target = id ? events.get(id) : undefined;
        if (
          name === "e" &&
          target &&
          deletionApplies(event, target, signingAuthority)
        )
          tombstones.add(target.id);
      }
    }
    for (const event of events.values()) {
      if (!contentKind(event) || tombstones.has(event.id)) continue;
      const channel = channelOf(event);
      if (!channel) continue;
      const rootId = root(event);
      const reference = threadReference(event);
      const parentId = reference?.parentId;
      if (event.pubkey === viewer) {
        own.set(event.id, channel);
        ownThreads.add(conversationKey(channel, reference?.rootId ?? event.id));
        if (parentId) {
          joined.add(`${channel}:${parentId}`);
          // A later reply of the viewer outlives the window that showed it.
          const lookup = lookups.get(conversationKey(channel, parentId));
          if (lookup?.done) witness(lookup, event);
        }
      }
      const rows = byChannel.get(channel) ?? [];
      const entry: Evidence = {
        event,
        channelId: channel,
        rootId: parentId ? rootId : undefined,
        parentId,
        threadRootId: reference?.rootId,
        mentioned: mentionsViewer(event),
        broadcast: event.tags.some(
          ([name, value]) => name === "broadcast" && value === "1",
        ),
        quiet: agentAudience(event),
      };
      rows.push(entry);
      byChannel.set(channel, rows);
      byId.set(event.id, entry);
    }
    for (const { channelId, evidence } of lookups.values()) {
      const event =
        evidence === undefined ? undefined : witnesses.get(evidence);
      if (event)
        ownThreads.add(
          conversationKey(
            channelId,
            threadReference(event)?.rootId ?? event.id,
          ),
        );
    }
  }
  function deleted(event: RelayEvent): boolean {
    indexEvidence();
    return tombstones.has(event.id);
  }
  /** Evidence of the target's channel: the index already resolved its channel
   * and reply root, which every selector would otherwise derive per event. */
  function inTarget({ event, rootId }: Evidence, target: ReadTarget) {
    return (
      target.kind === "channel" ||
      (target.kind === "message" && target.messageId === event.id) ||
      (target.kind === "thread" && rootId === target.rootId)
    );
  }
  const isDm = (channelId: string) =>
    channels.list().channels.find((channel) => channel.id === channelId)
      ?.channelType === "dm";
  // Read on first use: constructing a session touches no storage.
  let saved: ThreadFollows | undefined;
  const choices = () => (saved ??= follows.read());
  /** An explicit follow choice for the reply's whole thread, if any. */
  const chosen = ({ channelId, threadRootId }: Evidence) =>
    threadRootId === undefined
      ? undefined
      : choices().get(conversationKey(channelId, threadRootId));
  /** The reply is in a conversation the viewer is part of in its own channel:
   * the viewer follows its thread, or (without an explicit choice) wrote or
   * replied anywhere in that thread, wrote the parent, or also replied to the
   * same parent. Undecided parents are not members until their lookup finishes.
   * A finished lookup counts only through `ownThreads`, under the root its
   * witness names, so the reply's own root decides it and the label and the
   * effect read one set even if replies to one parent disagree on its root. */
  const conversation = (entry: Evidence) => {
    const { parentId, channelId, threadRootId } = entry;
    if (!parentId) return false;
    const explicit = chosen(entry);
    if (explicit !== undefined) return explicit;
    return (
      (threadRootId !== undefined &&
        ownThreads.has(conversationKey(channelId, threadRootId))) ||
      own.get(parentId) === channelId ||
      joined.has(conversationKey(channelId, parentId))
    );
  };
  /** Top-level posts always count. A reply counts only in the viewer's own
   * conversations, or when it is a DM, mentions the viewer, or is broadcast.
   * Quiet agent messages never count; explicit unread intent still can. */
  const relevant = (entry: Evidence, dm: boolean) =>
    !entry.quiet &&
    (!entry.parentId ||
      dm ||
      entry.mentioned ||
      entry.broadcast ||
      conversation(entry));
  /** A reply whose root is not retained would be a row of its own. While a
   * repair runs, whose thread reads fetch the roots it lacks, and the
   * structure lookup `want` queues has not finished, the reply waits, so a
   * thread does not flash as one row per reply before grouping under its
   * root. Otherwise it shows by itself, as a live mention does, and joins
   * its root once that is verified. */
  const rootless = (entry: Evidence) =>
    refresh !== undefined &&
    entry.parentId !== undefined &&
    entry.rootId === undefined &&
    entry.threadRootId !== undefined &&
    !lookups.get(
      `${conversationKey(entry.channelId, entry.threadRootId)}:structure`,
    )?.done;
  /** Retained evidence cannot decide this reply's conversation yet. */
  const undecided = (entry: Evidence, dm: boolean) =>
    !entry.quiet &&
    !!entry.parentId &&
    !relevant(entry, dm) &&
    chosen(entry) === undefined &&
    !lookups.get(conversationKey(entry.channelId, entry.parentId))?.done;
  function isUnread(entry: Evidence, state: ReadState, dm: boolean) {
    const { event, channelId } = entry;
    if (event.pubkey === viewer) return false;
    // Explicit per-message unread intent wins; otherwise replies outside the
    // viewer's conversations are not unread.
    if (
      forcedMessages.get(channelId)?.has(event.id) ||
      reads.localUnread(`msg:${event.id}`)
    )
      return true;
    return (
      relevant(entry, dm) && afterFrontier(entry, state, timeline(entry, dm))
    );
  }
  /** The read-state half of unread, before conversation relevance; `ordinary`
   * is a top-level message the channel catch-up mark reads (see `timeline`).
   * A thread read's reply is judged by the same marks as retained evidence. */
  function afterFrontier(
    entry: Pick<Evidence, "event" | "channelId" | "rootId">,
    state: ReadState,
    ordinary: boolean,
  ) {
    const { event, channelId, rootId } = entry;
    const frontier = effectiveFrontier(
      state,
      `msg:${event.id}`,
      channelId,
      rootId,
    );
    const forced =
      overrideActive(state.overrides[`msg:${event.id}`], frontier) ||
      overrideActive(
        state.overrides[channelId],
        effectiveFrontier(state, channelId),
      ) ||
      (rootId !== undefined &&
        overrideActive(
          state.overrides[`thread:${rootId}`],
          effectiveFrontier(state, `thread:${rootId}`, channelId),
        ));
    // Channel catch-up never acknowledges thread replies: retained evidence
    // cannot prove nonparticipation, especially after reload. Only ordinary
    // top-level messages inherit it; reply attention/direct thread dots survive.
    const catchUp = ordinary
      ? state.frontiers[`activity:${channelId}`]
      : undefined;
    const thread = rootId
      ? state.frontiers[`thread-activity:${rootId}`]
      : undefined;
    const caughtUp = Math.max(frontier ?? -1, catchUp ?? -1, thread ?? -1);
    return event.created_at > caughtUp || !!forced;
  }
  /** An ordinary top-level message: the channel catch-up mark reads it. Its
   * event alone decides this, except DM, which needs the listed channel. */
  function timeline(entry: Evidence, dm: boolean) {
    return !threadReference(entry.event) && !priority(entry, dm);
  }
  /** The channel catch-up mark reads this message. Until the channel's type
   * is known, it might be a DM, whose messages catch-up never reads. A roster
   * can list a channel before its metadata arrives, so being listed is not
   * enough. */
  function caughtUp(
    entry: Evidence,
    frontier: (key: string) => number | undefined,
  ) {
    const type = channels
      .list()
      .channels.find((channel) => channel.id === entry.channelId)?.channelType;
    return (
      type !== undefined &&
      timeline(entry, type === "dm") &&
      (frontier(`activity:${entry.channelId}`) ?? -1) >= entry.event.created_at
    );
  }
  /** A mark is redundant when a broader mark already reads all it reads.
   * The channel mark covers a message mark, and the channel catch-up mark
   * (`activity:`) covers an ordinary top-level message's mark. Older desktop
   * and mobile clients ignore `activity:`, so they show those messages as
   * unread; that is accepted. A reply finds its channel from its own event,
   * but finds its thread only while the root is loaded; after a reload without
   * the root, a thread or thread catch-up mark no longer reads it. So neither
   * covers a message mark. A message's channel comes from retained evidence,
   * or from the channel that read state saved for a marked message (`home`);
   * marks without either are kept. Catch-up needs the message itself, because only
   * its event says whether catch-up reads it. */
  reads.setCoverage({
    covered(key, frontier, home) {
      const value = frontier(key) ?? Number.POSITIVE_INFINITY;
      const separator = key.indexOf(":");
      if (separator < 0) return undefined;
      const kind = key.slice(0, separator);
      const id = key.slice(separator + 1);
      const by = (other: string, through: number) =>
        (frontier(other) ?? -1) >= through ? other : undefined;
      if (kind === "activity") return by(id, value);
      // Both marks name the same thread root, so this needs no event.
      if (kind === "thread-activity" && by(`thread:${id}`, value))
        return `thread:${id}`;
      if (closed) return undefined;
      indexEvidence();
      const entry = byId.get(id);
      const channel = entry?.channelId ?? home(id);
      if (channel === undefined) return undefined;
      if (kind === "msg")
        return (
          by(channel, entry?.event.created_at ?? value) ??
          (entry && caughtUp(entry, frontier)
            ? `activity:${entry.channelId}`
            : undefined)
        );
      if (kind === "thread" || kind === "thread-activity")
        return by(channel, value);
      return undefined;
    },
    home(id) {
      if (closed) return undefined;
      indexEvidence();
      return byId.get(id)?.channelId;
    },
  });
  function category(
    entry: Evidence,
    dm: boolean,
  ): MessageAttention["category"] {
    // DM events p-tag the recipient, so a mention check would classify every
    // direct message as a mention. Direct wins inside DM channels. Thread
    // attention follows the direct parent, even when the root is unknown.
    // A quiet agent message earns none, even when it mentions the viewer.
    if (entry.quiet) return undefined;
    return dm
      ? "direct"
      : entry.mentioned
        ? "mention"
        : conversation(entry)
          ? "thread"
          : undefined;
  }
  function priority(entry: Evidence, dm: boolean) {
    return !!category(entry, dm) || entry.broadcast;
  }
  function attention(channelId: string, messageId: string): MessageAttention {
    const unknown = Object.freeze({
      status: "unknown",
      unread: false,
      forced: false,
      viewing: false,
    } as const);
    if (closed || !allowed(channelId)) return unknown;
    indexEvidence();
    const event = events.get(messageId);
    if (!event || channelOf(event) !== channelId || !contentKind(event))
      return unknown;
    const entry = byChannel
      .get(channelId)
      ?.find((row) => row.event.id === messageId);
    if (!entry || event.pubkey === viewer)
      return Object.freeze({
        status: "ineligible",
        unread: false,
        forced: forcedMessages.get(channelId)?.has(messageId) ?? false,
        viewing: false,
      });
    const dm = isDm(channelId);
    const kind = category(entry, dm);
    // A queued or running lookup may still make this reply thread attention.
    // A read reply under a retained root is never looked up, so it is
    // undecided but not pending.
    const open = undecided(entry, dm);
    if (open) want(entry, dm);
    const pending =
      open &&
      lookups.get(conversationKey(channelId, entry.parentId ?? ""))?.done ===
        false;
    const viewing = [...views.values()].some(
      (view) =>
        view.channelId === channelId &&
        view.visible(messageId, view.ids.has(messageId)),
    );
    return Object.freeze({
      status: kind
        ? "eligible"
        : open || (threadReference(event) && !entry.rootId)
          ? "unknown"
          : "ineligible",
      ...(kind ? { category: kind } : {}),
      ...(pending ? { pending: true } : {}),
      ...(entry.mentioned ? { mentioned: true } : {}),
      ...(entry.rootId ? { rootId: entry.rootId } : {}),
      unread: isUnread(entry, reads.state(), dm),
      forced: forcedMessages.get(channelId)?.has(messageId) ?? false,
      viewing,
    });
  }
  function compute(target: ReadTarget): UnreadSnapshot {
    const key = targetKey(target);
    const accessible =
      allowed(target.channelId) &&
      (target.kind === "channel" ||
        (() => {
          const event =
            target.kind === "thread"
              ? structural(target.rootId)
              : events.get(target.messageId);
          return (
            !!event &&
            channelOf(event) === target.channelId &&
            contentKind(event)
          );
        })());
    if (!accessible)
      return Object.freeze({
        target,
        observedCount: null,
        attentionCount: null,
        coverage: "unknown",
        freshness: "unknown",
        manual: "none",
      });
    const evidence = known.has(target.channelId);
    const state = reads.state();
    let count = 0,
      attention = 0;
    const dm = isDm(target.channelId);
    indexEvidence();
    let latest: RelayEvent | undefined;
    for (const entry of byChannel.get(target.channelId) ?? []) {
      const event = entry.event;
      if (
        target.kind === "channel" &&
        (!latest ||
          event.created_at > latest.created_at ||
          (event.created_at === latest.created_at && event.id < latest.id))
      )
        latest = event;
      if (!inTarget(entry, target)) continue;
      want(entry, dm);
      if (!isUnread(entry, state, dm)) continue;
      count++;
      if (priority(entry, dm)) attention++;
    }
    const manual = reads.localUnread(key)
      ? "local-only"
      : target.kind === "message" &&
          forcedMessages.get(target.channelId)?.has(target.messageId)
        ? "local-only"
        : target.kind === "channel" &&
            reads.localUnread(messageForceKey(target.channelId))
          ? "local-only"
          : overrideActive(
                state.overrides[key],
                effectiveFrontier(state, key, target.channelId),
              )
            ? "remote"
            : "none";
    return Object.freeze({
      target,
      ...(latest
        ? { latestMessage: { id: latest.id, createdAt: latest.created_at } }
        : {}),
      observedCount: evidence ? count : null,
      attentionCount: evidence ? attention : null,
      coverage: evidence ? "observed" : "unknown",
      freshness,
      manual,
      ...(error ? { error } : {}),
    });
  }
  const equal = (a: UnreadSnapshot, b: UnreadSnapshot) =>
    a.latestMessage?.id === b.latestMessage?.id &&
    a.observedCount === b.observedCount &&
    a.attentionCount === b.attentionCount &&
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.manual === b.manual &&
    a.error === b.error;
  // Folds read profiles only through agent owners. Keep the answers they got:
  // a profile change that leaves them all alone cannot change a projection.
  const ownersRead = new Map<string, string | undefined>();
  const agentOwner = (pubkey: string) => {
    const owner = profiles?.owner?.(pubkey);
    ownersRead.set(pubkey, owner);
    return owner;
  };
  function computeActivity(channelId: string): ThreadActivitySnapshot {
    if (!allowed(channelId) || !known.has(channelId))
      return Object.freeze({
        channelId,
        items: null,
        coverage: "unknown",
        freshness: "unknown",
      });
    indexEvidence();
    const state = reads.state();
    const dm = isDm(channelId);
    const grouped = new Map<string, ThreadActivityItem>();
    // Only unread thread activity is presented; most publishes have none.
    let presented: Map<string, string> | undefined;
    for (const evidence of byChannel.get(channelId) ?? []) {
      const { event, rootId, mentioned, broadcast } = evidence;
      want(evidence, dm);
      if (
        !rootId ||
        (!mentioned && !broadcast && !conversation(evidence)) ||
        !isUnread(evidence, state, dm)
      )
        continue;
      const current = grouped.get(rootId);
      presented ??= new Map(
        foldMessages(channelId, "", [...events.values()], {
          includeReplies: true,
          signingAuthority,
          agentOwner: profiles?.owner && agentOwner,
        }).map((message) => [message.id, message.content]),
      );
      const preview = presented.get(event.id) ?? event.content;
      if (!current) {
        grouped.set(
          rootId,
          Object.freeze({
            channelId,
            rootId,
            latestMessageId: event.id,
            authorId: event.pubkey,
            workflowOwnerId: workflowOwner(event, workflowAuthority),
            createdAt: event.created_at,
            preview,
            unreadCount: 1,
          }),
        );
        continue;
      }
      const latest =
        event.created_at > current.createdAt ||
        (event.created_at === current.createdAt &&
          event.id < current.latestMessageId);
      grouped.set(
        rootId,
        Object.freeze({
          channelId,
          rootId,
          latestMessageId: latest ? event.id : current.latestMessageId,
          authorId: latest ? event.pubkey : current.authorId,
          workflowOwnerId: latest
            ? workflowOwner(event, workflowAuthority)
            : current.workflowOwnerId,
          createdAt: latest ? event.created_at : current.createdAt,
          preview: latest ? preview : current.preview,
          unreadCount: current.unreadCount + 1,
        }),
      );
    }
    return Object.freeze({
      channelId,
      items: Object.freeze(
        [...grouped.values()].sort(
          (a, b) =>
            b.createdAt - a.createdAt ||
            a.latestMessageId.localeCompare(b.latestMessageId),
        ),
      ),
      coverage: "observed",
      freshness,
      ...(error ? { error } : {}),
    });
  }
  const equalActivity = (
    a: ThreadActivitySnapshot,
    b: ThreadActivitySnapshot,
  ) =>
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.error === b.error &&
    ((a.items === null && b.items === null) ||
      (a.items !== null &&
        b.items !== null &&
        a.items.length === b.items.length &&
        a.items.every((item, index) => {
          const other = b.items?.[index];
          return (
            item.rootId === other?.rootId &&
            item.latestMessageId === other.latestMessageId &&
            item.authorId === other.authorId &&
            item.workflowOwnerId === other.workflowOwnerId &&
            item.createdAt === other.createdAt &&
            item.preview === other.preview &&
            item.unreadCount === other.unreadCount
          );
        })));
  function activity(channelId: string) {
    const previous = activitySnapshots.get(channelId);
    if (previous && !activityDirty.delete(channelId)) return previous;
    const value = computeActivity(channelId);
    if (previous && equalActivity(previous, value)) return previous;
    activitySnapshots.set(channelId, value);
    return value;
  }
  function snapshot(target: ReadTarget) {
    const key = keyFor(target),
      previous = snapshots.get(key);
    if (previous && !dirty.delete(key)) return previous;
    const value = compute(previous?.target ?? Object.freeze({ ...target }));
    if (previous && equal(previous, value)) return previous;
    if (!previous && snapshots.size >= 4096) {
      for (const key of snapshots.keys())
        if (!listeners.has(key)) {
          snapshots.delete(key);
          dirty.delete(key);
        }
      if (snapshots.size >= 4096)
        throw new Error("Unread selector capacity reached");
    }
    snapshots.set(key, value);
    return value;
  }
  function inbox(): InboxSnapshot {
    if (inboxSnapshot && !inboxDirty) return inboxSnapshot;
    inboxDirty = false;
    indexEvidence();
    const state = reads.state();
    const items: InboxItem[] = [];
    if (!closed)
      for (const channel of channels.list().channels) {
        if (
          channel.huddle ||
          channel.metadataPending ||
          channel.cached ||
          channel.archived ||
          !channel.members?.includes(viewer)
        )
          continue;
        const dm = channel.channelType === "dm";
        const session = channel.channelType === "solo";
        const evidence = (byChannel.get(channel.id) ?? []).filter((entry) => {
          want(entry, dm);
          return (
            entry.event.pubkey !== viewer &&
            !!category(entry, dm) &&
            !(!dm && rootless(entry))
          );
        });
        // A session's top-level timeline is one conversation; its threads,
        // roots included, stay separate.
        const roots = new Set(evidence.map((entry) => entry.rootId));
        const groups = new Map<string, Evidence[]>();
        const elsewhere = new Set<string>();
        for (const entry of evidence) {
          const id =
            dm || (session && !entry.parentId && !roots.has(entry.event.id))
              ? channel.id
              : (entry.rootId ?? entry.event.id);
          if (id !== channel.id) elsewhere.add(id);
          const group = groups.get(id) ?? [];
          group.push(entry);
          groups.set(id, group);
        }
        if (!groups.size) continue;
        const rows = foldMessages(channel.id, "", [...events.values()], {
          includeReplies: true,
          signingAuthority,
          agentOwner: profiles?.owner && agentOwner,
        });
        const content = new Map(rows.map((row) => [row.id, row.content]));
        // A session's top-level row shows its newest message from someone
        // else to everyone, even one that is not Inbox evidence, unless that
        // message is the root of its own thread row.
        const newest = session
          ? rows.reduce<RelayEvent | undefined>((best, row) => {
              const event = events.get(row.id);
              return event &&
                !row.threadRootId &&
                !row.membership &&
                !row.audience &&
                row.authorId !== viewer &&
                !elsewhere.has(row.id) &&
                (!best || order(event, best) > 0)
                ? event
                : best;
            }, undefined)
          : undefined;
        for (const [id, entries] of groups) {
          entries.sort((a, b) => order(a.event, b.event));
          const project = (
            entries: readonly Evidence[],
            timeline = false,
          ): InboxItem | undefined => {
            const latest = entries[entries.length - 1];
            if (!latest) return;
            // The row shows its newest message, matching its time; opening
            // still resumes at the representative.
            const shown =
              timeline && newest && order(newest, latest.event) >= 0
                ? newest
                : latest.event;
            const unread = entries.filter((entry) =>
              isUnread(entry, state, dm),
            );
            const representative = unread[0] ?? latest;
            const replies = entries.filter(
              (entry) => entry.rootId !== undefined,
            );
            const lastReply = replies[replies.length - 1];
            const target: ReadTarget = dm
              ? { kind: "channel", channelId: channel.id }
              : lastReply?.rootId &&
                  events.has(lastReply.rootId) &&
                  !tombstones.has(lastReply.rootId)
                ? {
                    kind: "thread",
                    channelId: channel.id,
                    rootId: lastReply.rootId,
                  }
                : {
                    kind: "message",
                    channelId: channel.id,
                    messageId: latest.event.id,
                  };
            const readThrough: { target: ReadTarget; messageId: string }[] = dm
              ? []
              : entries
                  .filter(
                    (entry) =>
                      !entry.rootId ||
                      !!reads.localUnread(`msg:${entry.event.id}`),
                  )
                  .map((entry) => ({
                    target: {
                      kind: "message" as const,
                      channelId: channel.id,
                      messageId: entry.event.id,
                    },
                    messageId: entry.event.id,
                  }));
            if (!dm && lastReply?.rootId)
              readThrough.push({
                target: {
                  kind: "thread",
                  channelId: channel.id,
                  rootId: lastReply.rootId,
                },
                messageId: lastReply.event.id,
              });
            return Object.freeze({
              id: `${channel.id}:${id}`,
              channelId: channel.id,
              target: Object.freeze(target),
              messageId: representative.event.id,
              latestMessageId: latest.event.id,
              messageIds: Object.freeze(entries.map((entry) => entry.event.id)),
              ...(representative.rootId
                ? { rootId: representative.rootId }
                : {}),
              authorId: shown.pubkey,
              workflowOwnerId: workflowOwner(shown, workflowAuthority),
              preview: content.get(shown.id) ?? shown.content,
              previewMessageId: shown.id,
              createdAt: shown.created_at,
              mentioned: entries.some((entry) => entry.mentioned),
              messages: Object.freeze(
                entries.map(({ event, mentioned }) =>
                  Object.freeze({
                    id: event.id,
                    createdAt: event.created_at,
                    mentioned,
                  }),
                ),
              ),
              thread: entries.some((entry) => entry.parentId !== undefined),
              unreadCount: unread.length,
              manual:
                !!reads.localUnread(targetKey(target)) ||
                readThrough.some(
                  ({ target }) => !!reads.localUnread(targetKey(target)),
                ),
              readThrough: Object.freeze(
                readThrough.map((step) =>
                  Object.freeze({
                    ...step,
                    target: Object.freeze(step.target),
                  }),
                ),
              ),
            });
          };
          const item = project(entries, id === channel.id && session);
          if (item)
            items.push(
              Object.freeze({
                ...item,
                mention: project(
                  entries.filter((entry) => category(entry, dm) === "mention"),
                ),
              }),
            );
        }
      }
    items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const next: InboxSnapshot = Object.freeze({
      status: error
        ? "error"
        : inboxLoading
          ? "loading"
          : freshness === "unknown"
            ? "idle"
            : "ready",
      items: Object.freeze(items),
      // Evidence shown while a repair still reads the roster is `observing`.
      freshness: freshness === "observed" && refresh ? "observing" : freshness,
      ...(partial ? { partial: true } : {}),
      ...(error ? { error } : {}),
    });
    // Keep React's snapshot stable for irrelevant evidence and duplicate deliveries.
    if (
      !inboxSnapshot ||
      JSON.stringify(inboxSnapshot) !== JSON.stringify(next)
    )
      inboxSnapshot = next;
    return inboxSnapshot;
  }
  function addActivityListener(channelId: string, listener: () => void) {
    activity(channelId);
    const set = activityListeners.get(channelId) ?? new Set();
    set.add(listener);
    activityListeners.set(channelId, set);
    return () => {
      set.delete(listener);
      if (!set.size) activityListeners.delete(channelId);
    };
  }
  function publish(channelIds?: ReadonlySet<string>) {
    if (closed) return;
    inboxDirty = true;
    const previousInbox = inboxSnapshot;
    const nextInbox = inboxListeners.size ? inbox() : undefined;
    const changed: string[] = [];
    const changedActivity: string[] = [];
    for (const [key, old] of snapshots) {
      if (channelIds && !channelIds.has(old.target.channelId)) continue;
      // Revisit dormant selectors lazily, retaining identity if unchanged.
      if (!listeners.has(key)) {
        dirty.add(key);
        continue;
      }
      const next = compute(old.target);
      if (!equal(old, next)) {
        snapshots.set(key, next);
        changed.push(key);
      }
    }
    for (const [channelId, old] of activitySnapshots) {
      if (channelIds && !channelIds.has(channelId)) continue;
      if (!activityListeners.has(channelId)) {
        activityDirty.add(channelId);
        continue;
      }
      const next = computeActivity(channelId);
      if (!equalActivity(old, next)) {
        activitySnapshots.set(channelId, next);
        changedActivity.push(channelId);
      }
    }
    // Replace/invalidate ALL affected projections before any reentrant callback.
    if (nextInbox && nextInbox !== previousInbox)
      for (const listener of inboxListeners) notify(listener);
    for (const key of changed)
      for (const listener of listeners.get(key) ?? []) notify(listener);
    for (const channelId of changedActivity)
      for (const listener of activityListeners.get(channelId) ?? [])
        notify(listener);
  }
  const stopRead = reads.subscribe(publish);
  const stopProfiles = profiles?.subscribe(() => {
    const owner = profiles.owner;
    if (!owner || [...ownersRead].every(([key, value]) => owner(key) === value))
      return;
    ownersRead.clear();
    publish();
  });
  /** A choice changes relevance in every projection and held live alert. */
  function followsChanged(channelIds?: ReadonlySet<string>) {
    publish(channelIds);
    for (const listener of [...membershipListeners]) listener();
  }
  const stopFollows = follows.subscribe(() => {
    saved = undefined;
    followsChanged();
  });
  /** Channels the viewer left or lost leave the roster set, with their
   * threads read whole: their evidence is purged, so a re-grant is a join. */
  function uncover() {
    const listed = new Set(
      channels
        .list()
        .channels.flatMap((channel) =>
          channel.members?.includes(viewer) ? [channel.id] : [],
        ),
    );
    for (const id of covered)
      if (!listed.has(id)) {
        covered.delete(id);
        resample = true;
      }
    for (const key of whole)
      if (!listed.has(key.slice(0, key.indexOf(":")))) whole.delete(key);
  }
  function purge() {
    // A revoke/regrant must not revive a transaction accepted under the old access epoch.
    epoch++;
    uncover();
    for (const channelId of channelReadGenerations.keys())
      if (!allowed(channelId)) channelReadGenerations.delete(channelId);
    for (const [key, lookup] of lookups)
      if (!allowed(lookup.channelId)) lookups.delete(key);
    for (const [id, event] of lookupEvents)
      if (!allowed(channelOf(event) ?? "")) lookupEvents.delete(id);
    heldRoots = undefined;
    for (const [id, event] of witnesses)
      if (!allowed(channelOf(event) ?? "")) witnesses.delete(id);
    for (const [key, { channelId }] of queued)
      if (!allowed(channelId)) queued.delete(key);
    const denied = new Set(
      [...known, ...forcedMessages.keys()].filter(
        (channel) => !allowed(channel),
      ),
    );
    for (const channel of denied) {
      known.delete(channel);
      forcedMessages.delete(channel);
      entered.delete(channel);
    }
    const retained = new Map(events);
    const owners = channelOwnership((targetId) => retained.get(targetId));
    for (const [id, event] of retained) {
      const channels = owners(event);
      if (!channels || [...channels].some((channel) => !allowed(channel)))
        events.delete(id);
    }
    indexed = false;
    // Reference-only tombstones are retained only with a still-accessible target.
    bytes = [...events.values()].reduce(
      (total, event) =>
        total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    publish();
  }
  // Names/previews do not affect unread. Read membership once, without a
  // roster scan for every channel, and retain only the invalidation inputs.
  const types = (list: ReturnType<ChannelQueries["list"]>) =>
    new Map(
      list.channels
        .filter(
          (channel) => !channel.cached && channel.members?.includes(viewer),
        )
        .map((channel) => [
          channel.id,
          `${channel.channelType ?? ""}:${!!channel.huddle}:${!!channel.metadataPending}`,
        ]),
    );
  const inboxArchiveKey = (list: ReturnType<ChannelQueries["list"]>) =>
    list.channels
      .filter(
        (channel) =>
          channel.archived &&
          !channel.cached &&
          channel.members?.includes(viewer),
      )
      .map((channel) => channel.id)
      .sort()
      .join(",");
  const initialList = channels.list();
  let archivedKey = inboxArchiveKey(initialList);
  let channelTypes = types(initialList);
  let accessKey = [...channelTypes.keys()].sort().join(",");
  const stopChannels = channels.subscribeList(() => {
    const list = channels.list();
    const nextTypes = types(list);
    const next = [...nextTypes.keys()].sort().join(",");
    const changed = new Set(
      [...nextTypes].flatMap(([id, type]) =>
        channelTypes.get(id) !== type ? [id] : [],
      ),
    );
    channelTypes = nextTypes;
    // Channel archive changes Inbox eligibility, not membership or read intent.
    const nextArchived = inboxArchiveKey(list);
    const archiveChanged = nextArchived !== archivedKey;
    archivedKey = nextArchived;
    if (next === accessKey) {
      if (changed.size || archiveChanged) publish(changed);
    } else {
      accessKey = next;
      purge();
      if (waiting.length) admitRestored(waiting);
      // An initial observation made against a display-only roster still owes
      // evidence when membership becomes fresh, including during an active repair.
      // A newly accessible channel has no evidence yet, a channel lost owes
      // the roster sample again (see `uncover`), and the epoch bump abandons
      // any in-flight observation, so each observes again at once, catching
      // up: what the mark does not cover is read once.
      if (requested) {
        repairAgain = true;
        if (!refresh) void repair("foreground", true);
      }
    }
  });
  // Conversation membership for replies whose parent conversation is not
  // decided by retained evidence: the parent may be the viewer's own older
  // message, or the viewer may have replied to it outside the sampled windows.
  // A selector that evaluates an otherwise-unread reply, or a read reply whose
  // root is not retained, asks the relay once per parent. Selectors only queue
  // the parent; the fetch starts in a microtask, so channels nobody observes
  // cost nothing. Fetched events are structure only: they never count and
  // never start another lookup, so a lookup cannot walk up an old thread.
  function want(entry: Evidence, dm: boolean) {
    const { event, channelId, parentId, threadRootId } = entry;
    if (!parentId || event.pubkey === viewer) return;
    // Activity and the Inbox group thread replies by root, so fetch a root the
    // sampled windows dropped for a followed thread or a relevant reply in it,
    // or for a read reply, which would otherwise be its own row. Membership
    // of read replies is answered by the participation pass, not a lookup,
    // except in a remembered thread: the viewer's reply may be older than the
    // thread page and the authored page both reach, so the lookup recovers
    // that verified witness, or finds it deleted and leaves the thread.
    const read = () =>
      !afterFrontier(entry, reads.state(), timeline(entry, dm));
    const structuralRootId =
      !entry.rootId &&
      (chosen(entry) === true ||
        entry.mentioned ||
        entry.broadcast ||
        conversation(entry) ||
        read())
        ? threadRootId
        : undefined;
    const structuralRecovery = structuralRootId !== undefined;
    const key = structuralRecovery
      ? `${conversationKey(channelId, structuralRootId)}:structure`
      : conversationKey(channelId, parentId);
    // A mention or a reply in the viewer's conversation teaches the pass
    // its thread, as retained evidence does (see `participating().learn`);
    // a read reply outside them only needs its root to group under.
    const teaches = () =>
      structuralRecovery && (entry.mentioned || conversation(entry));
    // A root the cache let go is fetched again for a thread whose root it
    // keeps from then on: remembered, or taught by this reply. Another
    // thread's lookup stays done, so replies needing more roots than the
    // cache holds cannot cycle their fetches.
    const found = lookups.get(key);
    if (found?.released && (teaches() || pinned(event))) lookups.delete(key);
    else if (
      found ||
      (!structuralRecovery &&
        (!undecided(entry, dm) || (read() && !pinned(event))))
    )
      return;
    lookups.set(key, {
      channelId,
      done: false,
      evidence: undefined,
      more: false,
    });
    // One lookup per parent also decides the whole thread: the root is
    // fetched (so a reply still groups and opens, and the viewer may have
    // written it) and its replies are asked for (the viewer may have replied
    // on another branch).
    const rootId = threadRootId === parentId ? undefined : threadRootId;
    const ids = new Set(structuralRecovery ? [structuralRootId] : [parentId]);
    if (rootId && !structural(rootId)) ids.add(rootId);
    queued.set(key, {
      channelId,
      parentId: structuralRootId ?? parentId,
      rootId,
      ids,
      structuralOnly: structuralRecovery,
      taught: teaches() ? event : undefined,
    });
    if (scheduled || retry) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void resolveConversations();
    });
  }
  function resetLookups() {
    lookups.clear();
    lookupEvents.clear();
    heldRoots = undefined;
    queued.clear();
    retracted.clear();
    witnesses.clear();
    failures = 0;
    if (retry) clearTimeout(retry);
    retry = undefined;
  }
  // At most one lookup per retained reply (keyed by its parent), and the
  // window holds at most 4,096 events, so the lookups the current window
  // needs fit together and a fixed working set drains. Queued lookups from a
  // window that was reset are not capped here; they drain as before.
  function remember(key: string, lookup: Lookup) {
    lookups.delete(key);
    lookups.set(key, lookup);
    for (const [oldest] of lookups) {
      if (lookups.size <= 4096) break;
      lookups.delete(oldest);
    }
  }
  /** Fetched structure, 1,024 events besides the roots of remembered
   * threads it holds, which go last as their evidence does: a cold thread
   * does not fetch its root again for a reply it already holds. Each thread
   * has one root, so the remembered set bounds them and the oldest other
   * event goes first; a root passed over moves to the newest end, so the
   * next eviction does not walk it again. A root let go releases its
   * structure lookup (see `want`). */
  function keep(event: RelayEvent) {
    const size = remembered?.size ?? 0;
    let roots = heldRoots;
    if (!roots || roots.of !== remembered || roots.size !== size) {
      let count = 0;
      for (const held of lookupEvents.values())
        if (rememberedRoot(held)) count++;
      roots = heldRoots = { of: remembered, size, count };
    }
    if (!lookupEvents.has(event.id) && rememberedRoot(event)) roots.count++;
    lookupEvents.delete(event.id);
    lookupEvents.set(event.id, event);
    for (const [id, oldest] of lookupEvents) {
      if (lookupEvents.size - roots.count <= 1024) break;
      lookupEvents.delete(id);
      if (rememberedRoot(oldest)) {
        lookupEvents.set(id, oldest);
        continue;
      }
      const lookup = lookups.get(
        `${conversationKey(channelOf(oldest) ?? "", id)}:structure`,
      );
      if (lookup) lookup.released = true;
    }
  }
  /** A root the participation pass fetched by ID is structure, as a
   * lookup's fetch is: it groups its thread's replies and counts only once a
   * window or the roster sample returns it, so a repair counts the same
   * whether the root came from a lookup, a thread read or storage. The
   * viewer's own root witnesses their membership of its thread, as it does
   * for a lookup that fetched it. */
  function keepRoot(event: RelayEvent) {
    const channelId = channelOf(event);
    if (!channelId || (event.pubkey === viewer && retracted.has(event.id)))
      return;
    keep(event);
    if (event.pubkey !== viewer) return;
    const key = conversationKey(channelId, event.id);
    const found = lookups.get(key);
    const lookup: Lookup = found?.done
      ? found
      : { channelId, done: true, evidence: undefined, more: false };
    remember(key, lookup);
    witness(lookup, event);
  }
  /** IDs a landed fetch asked for and did not return are absent; one it
   * returned is not. */
  function noteAbsent(asked: readonly string[], found: readonly RelayEvent[]) {
    const returned = new Set(found.map((event) => event.id));
    for (const id of asked) {
      absent.delete(id);
      if (!returned.has(id)) absent.add(id);
    }
    for (const id of absent) {
      if (absent.size <= 1024) break;
      absent.delete(id);
    }
  }
  const contentKinds = UNREAD_CONTENT_KINDS;
  type Target = { parentId: string; rootId: string | undefined };
  /** The viewer's reply decides this lookup: it answers the parent, or is
   * anywhere in the parent's thread. */
  const decides = (event: RelayEvent, { parentId, rootId }: Target) => {
    const reference = threadReference(event);
    return (
      reference !== undefined &&
      (reference.parentId === parentId ||
        reference.rootId === (rootId ?? parentId))
    );
  };
  /** The viewer's replies under these parents and their roots, with their
   * deletions. `#e` also matches root tags, which the whole-thread answer
   * relies on, so a busy thread can fill one page: split a full page, and page
   * one parent back in time until a reply that decides it appears. */
  async function viewerReplies(
    channelId: string,
    parents: readonly Target[],
    signal: AbortSignal,
    until?: number,
    pages = 0,
  ): Promise<RelayEvent[]> {
    const rows = await reader.read(
      [
        {
          kinds: contentKinds,
          authors: [viewer],
          "#h": [channelId],
          "#e": [
            ...new Set(
              parents.flatMap(({ parentId, rootId }) =>
                rootId ? [parentId, rootId] : [parentId],
              ),
            ),
          ],
          include_aux: true,
          limit: 500,
          ...(until === undefined ? {} : { until }),
        },
      ],
      { signal, priority: "background" },
    );
    const content = rows.filter((event) => contentKinds.includes(event.kind));
    if (content.length < 500) return [...rows];
    if (parents.length > 1) {
      const half = Math.ceil(parents.length / 2);
      return [
        ...(await viewerReplies(channelId, parents.slice(0, half), signal)),
        ...(await viewerReplies(channelId, parents.slice(half), signal)),
      ];
    }
    // `until` is inclusive: stop when a page makes no progress, and after ten
    // pages (5,000 replies under one root) as a cost bound.
    const oldest = Math.min(...content.map((event) => event.created_at));
    const [target] = parents;
    if (
      !target ||
      content.some((event) => decides(event, target)) ||
      oldest === until ||
      pages >= 9
    )
      return [...rows];
    return [
      ...rows,
      ...(await viewerReplies(channelId, parents, signal, oldest, pages + 1)),
    ];
  }
  let resolving = false;
  async function resolveConversations() {
    if (closed || resolving || !queued.size) return;
    resolving = true;
    try {
      while (!closed && queued.size) {
        const channelId = queued.values().next().value?.channelId;
        if (!channelId) return;
        const chunk = [...queued]
          .filter(([, item]) => item.channelId === channelId)
          .slice(0, 50);
        for (const [key] of chunk) queued.delete(key);
        const parents = chunk.map(([, item]) => item);
        // A reset or access change during the read makes its answer stale.
        // Re-queue only lookups the reset kept; cleared ones are asked again
        // by the next selector that needs them.
        const generation = epoch;
        const requeue = () => {
          for (const [key, item] of chunk)
            if (lookups.get(key)?.done === false) queued.set(key, item);
        };
        const ids = [
          ...new Set(chunk.flatMap(([, item]) => [...item.ids])),
        ].filter((id) => !structural(id));
        const signal = AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(10000),
        ]);
        let fetched: readonly RelayEvent[];
        let replies: readonly RelayEvent[];
        try {
          [fetched, replies] = await Promise.all([
            ids.length
              ? reader.read(
                  [
                    {
                      kinds: contentKinds,
                      ids,
                      include_aux: true,
                      limit: ids.length,
                    },
                  ],
                  { signal, priority: "background" },
                )
              : Promise.resolve([]),
            parents.some((parent) => !parent.structuralOnly)
              ? viewerReplies(
                  channelId,
                  parents.filter((parent) => !parent.structuralOnly),
                  signal,
                )
              : Promise.resolve([]),
          ]);
        } catch {
          if (closed) return;
          requeue();
          // A reset retires its requests; that is not a relay failure.
          if (generation !== epoch) continue;
          // Keep the parents pending, so they are not asked twice, and retry
          // the batch with backoff while the relay is unavailable.
          const delay = Math.min(60000, 1000 * 2 ** failures++);
          retry = setTimeout(() => {
            retry = undefined;
            void resolveConversations();
          }, delay);
          return;
        }
        failures = 0;
        if (closed) return;
        if (generation !== epoch) {
          requeue();
          continue;
        }
        if (!allowed(channelId)) continue;
        const removed = new Set<string>();
        for (const event of [...fetched, ...replies])
          if (event.kind === 5 || event.kind === 9005)
            for (const [name, id] of event.tags)
              if (name === "e" && id) removed.add(`${event.pubkey}:${id}`);
        const live = (event: RelayEvent) =>
          contentKind(event) &&
          channelOf(event) === channelId &&
          !removed.has(`${event.pubkey}:${event.id}`) &&
          !(event.pubkey === viewer && retracted.has(event.id));
        for (const event of fetched) if (live(event)) keep(event);
        noteAbsent(ids, fetched.filter(live));
        const mine = replies.filter(
          (event) => event.pubkey === viewer && live(event),
        );
        // What this batch teaches the repair's participation pass: a thread
        // the viewer's reply was found in, or one a fetched root now holds.
        // Its read goes ahead of the windows still queued, or runs as a
        // follow-up once the repair's pool has finished.
        const run = activePass?.generation === epoch ? activePass : undefined;
        const taught: ReadFilter[][] = [];
        const feed = (key: string, event: RelayEvent) => {
          if (run) taught.push(...run.pass.feed(key, event));
        };
        for (const target of parents) {
          if (target.structuralOnly) {
            remember(
              `${conversationKey(channelId, target.parentId)}:structure`,
              {
                channelId,
                done: true,
                evidence: undefined,
                more: false,
              },
            );
            if (target.taught && structural(target.parentId))
              feed(conversationKey(channelId, target.parentId), target.taught);
            continue;
          }
          const found = mine.filter((event) => decides(event, target));
          // The viewer's own parent or root, live and in this channel.
          const authored = [target.parentId, target.rootId].flatMap((id) => {
            const event = id === undefined ? undefined : structural(id);
            return event?.pubkey === viewer && live(event) ? [event] : [];
          });
          const lookup: Lookup = {
            channelId,
            done: true,
            evidence: undefined,
            more: found.length + authored.length > 1,
          };
          remember(conversationKey(channelId, target.parentId), lookup);
          // The viewer's own parent or root is the witness when there is one:
          // it may come from the structural cache, which a later lookup
          // reuses, so its deletion must stay observable. Replies are always
          // refetched.
          const newest = found.reduce<RelayEvent | undefined>(
            (best, event) =>
              !best || event.created_at > best.created_at ? event : best,
            undefined,
          );
          const chosen = authored[0] ?? newest;
          if (chosen) {
            witness(lookup, chosen);
            feed(
              conversationKey(channelId, target.rootId ?? target.parentId),
              chosen,
            );
          }
        }
        if (run && taught.length) {
          run.queue.unshift(...taught);
          if (!run.pooling) void followUp(run);
        }
        indexed = false;
        publish(new Set([channelId]));
        // Live notifications wait on pending replies; let them re-check.
        for (const listener of [...membershipListeners]) listener();
      }
    } finally {
      resolving = false;
    }
  }
  // Per-channel evidence: the newest content events of each member channel at
  // or after its older read mark (the explicit channel frontier or the
  // catch-up `activity:` mark, whichever is older, so unread replies between
  // them are seen), or after the last week for a channel never read on any
  // device, whose dormant history would otherwise fill the budget to show
  // nothing new. Each channel gets one page of at most WINDOW_LIMIT events,
  // sized so the roster's windows together stay within WINDOW_BUDGET, three
  // quarters of the retained budget: counts and rows beyond a channel's page
  // are bounded, as under the roster sample alone, but a busy channel can no
  // longer push a quiet channel's thread out of the evidence, not even on a
  // first run with a large roster. Single-channel filters ride
  // UNREAD_WINDOW_BATCH per request (the relay honours per-filter limits; the
  // reader and hosts admit this batch shape beyond their four-filter rule),
  // so the windows cost one or two requests, with WINDOW_CONCURRENCY in flight:
  // the reader runs three reads at once, and the third slot stays free for
  // the channel the viewer opens meanwhile. Each landed request publishes.
  const WINDOW_LIMIT = 100;
  const WINDOW_LEAST = 20;
  const WINDOW_BUDGET = 3072;
  const WINDOW_CONCURRENCY = 2;
  const WINDOW_FLOOR_SECONDS = 7 * 24 * 60 * 60;
  // Behind the windows, the roster sample is read too: the newest
  // SAMPLE_LIMIT events of each SAMPLE_CHANNELS of the roster, whatever their
  // marks, one single-filter request each (the relay once capped a request's
  // `#h` values at 128). A window starts at its channel's older mark, and in
  // a channel only scrolled to its end that is the catch-up mark, which reads
  // no replies, so an unread reply older than it is in no window; the sample
  // still holds it while it is that recent, as it holds read history before
  // a mark or a never-read channel's week.
  const SAMPLE_LIMIT = 500;
  const SAMPLE_CHANNELS = 128;
  // The viewer's threads ride the same requests as the windows do. The
  // HOT_THREADS most recently read or written in are refetched whole, one
  // filter per channel naming its roots (a full page splits a filter's roots,
  // as `viewerReplies` does); the rest are asked only for replies since their
  // newest time, one filter per root so no thread's seen replies are reread
  // under another's older time, COLD_LIMIT each and usually none, with a root
  // fetched by ID once a reply arrives. Across threads, only the newest
  // PARTICIPATION_BUDGET replies are admitted per repair, the threads most
  // recently read or written in having been asked first and each thread
  // given its newest unread reply before the rest fill, with at most
  // PARTICIPATION_RESERVE slots kept from the fill for the reads still to
  // land, so a large cold set (mostly empty) does not starve the hot
  // landing: pinned evidence must leave the channel windows at least three
  // quarters of the retained budget.
  const THREAD_LIMIT = 200;
  const HOT_THREADS = 50;
  const COLD_LIMIT = 50;
  const PARTICIPATION_BUDGET = 1024;
  const PARTICIPATION_RESERVE = PARTICIPATION_BUDGET / 4;
  // The walk over the viewer's authored history teaches the threads they
  // replied in. A device's first repair pages back from the authored page in
  // the first request, SEED_PAGE a page behind the windows, until a short
  // page or SEED_PAGES; later repairs read only what was authored since the
  // newest time walked. Pages beyond the first are not evidence.
  const SEED_PAGE = 500;
  const SEED_PAGES = 6;
  // The delta (design §3.3): what each SAMPLE_CHANNELS of the roster gained
  // since the mark, less DELTA_LOOKBACK seconds (the relay's 900 s future
  // tolerance, which bounds the mark above the time it was read, and its
  // 960 s commit floor, below which nothing commits late, with 5 s margin),
  // with the edits and deletions `accept` admits, so those of a held event
  // of any age arrive. DELTA_PAGE a page, keyset to a short page; a chunk
  // still full at DELTA_PAGES, or a mark confirmed more than MARK_AGE ago,
  // leaves the pass to the bootstrap. Restored evidence a delta has not
  // covered has its deletions since the record's mark read the same way,
  // DELETION_PAGES at most (see `settleDeletions`).
  const DELTA_LOOKBACK = 900 + 960 + 5;
  const DELTA_PAGE = 500;
  const DELTA_PAGES = 6;
  const DELETION_PAGES = 2;
  const MARK_AGE = 24 * 60 * 60;
  const overlayKinds = [40003, 5, 9005];
  const deadline = () =>
    AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]);
  const chunk = <T>(items: readonly T[], size: number) =>
    Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
      items.slice(i * size, (i + 1) * size),
    );
  /** The relay's order: newest first, then by ID. */
  const byTime = (a: RelayEvent, b: RelayEvent) =>
    b.created_at - a.created_at || a.id.localeCompare(b.id);
  /** Channels the repair reads: joined, with membership confirmed. */
  const rosterIds = () =>
    channels
      .list()
      .channels.filter(
        (channel) => !channel.cached && channel.members?.includes(viewer),
      )
      .map((channel) => channel.id);
  /** The roster's windows, most recently read channels first (the viewer is
   * active there, and their windows are the smallest; never-read channels go
   * last), the channels with a read mark, and the roster sample. What a
   * repair reads of the roster, and what a save keeps for the next one. */
  function rosterReads(ids: readonly string[]) {
    const { frontiers } = reads.state();
    const floor = Math.floor(now() / 1000) - WINDOW_FLOOR_SECONDS;
    const limit = Math.max(
      WINDOW_LEAST,
      Math.min(WINDOW_LIMIT, Math.floor(WINDOW_BUDGET / ids.length)),
    );
    const windows = ids
      .map((id) => {
        const marks = [frontiers[id], frontiers[`activity:${id}`]].filter(
          (mark): mark is number => mark !== undefined,
        );
        return { id, since: marks.length ? Math.min(...marks) : undefined };
      })
      .sort((a, b) => (b.since ?? -1) - (a.since ?? -1));
    return {
      marked: new Set(
        windows.flatMap(({ id, since }) => (since === undefined ? [] : [id])),
      ),
      windows: windows.map(
        ({ id, since }): ReadFilter => ({
          kinds: contentKinds,
          "#h": [id],
          since: since ?? floor,
          include_aux: true,
          limit,
        }),
      ),
      sample: chunk(ids, SAMPLE_CHANNELS).map(
        (part): ReadFilter => ({
          kinds: contentKinds,
          "#h": part,
          include_aux: true,
          limit: SAMPLE_LIMIT,
        }),
      ),
    };
  }
  /** A thread read: whole, or replies since a time. */
  const threadRead = (
    channelId: string,
    rootIds: readonly string[],
    since?: number,
  ): ReadFilter => ({
    kinds: contentKinds,
    "#h": [channelId],
    "#e": [...rootIds],
    ...(since === undefined ? {} : { since }),
    include_aux: true,
    limit: since === undefined ? THREAD_LIMIT : COLD_LIMIT,
  });
  /** The viewer's newest authored page, since the last walk when there was
   * one. */
  const authoredRead = (walk: ThreadParticipation["walk"]): ReadFilter => ({
    kinds: contentKinds,
    authors: [viewer],
    ...(walk ? { since: walk.since } : {}),
    include_aux: true,
    limit: WINDOW_LIMIT,
  });
  /** One repair's reads: whether any landed, whether one was dropped, and
   * the last failure, which is the repair's error when nothing landed. */
  type Pass = { landed: boolean; dropped: boolean; failure: unknown };
  /** A response over the reader's byte budget, or the native host's, fails
   * the same way every time, so the request is split, not retried: its
   * filters in two halves, a lone filter's `ids` in two, or a lone filter's
   * limit halved. A lone filter at limit 1 cannot shrink and is dropped. */
  const oversized = isOversizedResponse;
  function split(request: readonly ReadFilter[]): ReadFilter[][] {
    if (request.length > 1) {
      const half = Math.ceil(request.length / 2);
      return [request.slice(0, half), request.slice(half)];
    }
    const [filter] = request;
    if (!filter) return [];
    if (filter.ids && filter.ids.length > 1) {
      const half = Math.ceil(filter.ids.length / 2);
      return [
        [{ ...filter, ids: filter.ids.slice(0, half), limit: half }],
        [
          {
            ...filter,
            ids: filter.ids.slice(half),
            limit: filter.ids.length - half,
          },
        ],
      ];
    }
    return filter.limit > 1
      ? [[{ ...filter, limit: Math.floor(filter.limit / 2) }]]
      : [];
  }
  /** Reads `requests` WINDOW_CONCURRENCY at a time, workers pulling the next
   * as one lands; `landed` sees each result (undefined for a dropped request)
   * and may push follow-up requests. A request that fails is read once more
   * in its slot with a fresh deadline (one window in five live runs stalled
   * past it alone); failing again, it is dropped and the rest still land.
   * Once a request has been dropped, a failing request is dropped at once —
   * a second stall is the relay, not the request — so a dead relay holds a
   * pass for one deadline per request beyond the two the first costs. An
   * oversized response splits the request (see `split`); `divided` sees the
   * parts, which are read next. False when the repair was retired meanwhile
   * or `landed` declined. */
  async function pool(
    requests: ReadFilter[][],
    generation: number,
    priority: Priority,
    pass: Pass,
    landed: (
      request: readonly ReadFilter[],
      result: readonly RelayEvent[] | undefined,
      requests: ReadFilter[][],
    ) => boolean,
    divided: (
      request: readonly ReadFilter[],
      parts: readonly (readonly ReadFilter[])[],
    ) => void = () => {},
  ) {
    let retired = false;
    const worker = async () => {
      while (!retired && !closed && generation === epoch) {
        const request = requests.shift();
        if (!request) return;
        let result: readonly RelayEvent[] | undefined;
        let parts: ReadFilter[][] | undefined;
        for (
          let attempt = 0;
          attempt < (pass.dropped ? 1 : 2) && !parts;
          attempt++
        )
          try {
            result = await reader.read(request, {
              signal: deadline(),
              priority,
            });
            break;
          } catch (cause) {
            if (closed || generation !== epoch) return;
            pass.failure = cause;
            if (oversized(cause)) parts = split(request);
          }
        if (parts?.length) {
          requests.unshift(...parts);
          divided(request, parts);
          continue;
        }
        if (result) {
          pass.landed = true;
          reconcile(request, result);
        } else pass.dropped = true;
        if (
          closed ||
          generation !== epoch ||
          !landed(request, result, requests)
        )
          retired = true;
      }
    };
    await Promise.all(
      Array.from({ length: WINDOW_CONCURRENCY }, () => worker()),
    );
    return !closed && generation === epoch && !retired;
  }
  /** Which reads a pass catches up with (design §3.5): a launch, tick,
   * reconnect or access change (`catchUp`) reads the delta when the record
   * is complete and its mark was confirmed within MARK_AGE, with what the
   * mark does not cover read once (design §3.6): a channel outside the
   * roster set (joined, unconfirmed when the mark moved, or its window
   * dropped) has its window and its cold threads read, and the roster
   * sample is read with it or after a leave; a hot thread outside `whole`
   * is read whole. Anything else, and an explicit refresh, reads the
   * bootstrap. The age is of the confirmation, not of the mark's own time,
   * so a quiet roster, whose newest event stays old, is not read whole
   * every pass. A delta still full at DELTA_PAGES falls to the bootstrap in
   * the same pass, whose sample confirms the mark; one that dropped keeps
   * the mark, the pass is partial, and the next pass reads the delta again.
   * Only a pass that reads the bootstrap lets the sample move the mark or
   * rebuild the roster set. Until the cut-over the bootstrap's reads are
   * made whatever the delta's outcome. */
  const route = (catchUp: boolean): "delta" | "bootstrap" =>
    catchUp &&
    complete &&
    mark &&
    Math.floor(now() / 1000) - mark.checked <= MARK_AGE
      ? "delta"
      : "bootstrap";
  /** A read of every chunk of the roster to its end confirms the mark now,
   * raised to the newest time it returned. Live events never move it: a
   * dropped frame could leave them behind the delta's lookback. */
  function confirm(newest: number | undefined) {
    const at = Math.max(mark?.at ?? -1, newest ?? -1);
    if (at >= 0) mark = { at, checked: Math.floor(now() / 1000) };
  }
  /** One filter of `kinds` per SAMPLE_CHANNELS of `ids`, since `since`. */
  const sinceReads = (
    ids: readonly string[],
    since: number,
    kinds: readonly number[],
  ) =>
    chunk(ids, SAMPLE_CHANNELS).map(
      (part): ReadFilter => ({ kinds, "#h": part, since, limit: DELTA_PAGE }),
    );
  /** Pages single-filter reads from their `since` to the end, newest first,
   * accepting every page: a full page's next starts at its oldest (`until`
   * with `before_id`; the relay orders a second's events by ID, so ties are
   * neither skipped nor read twice), until a short page or `pages`. A page is
   * the whole response, since the relay matched each event to the filter by
   * a channel the client may not see (see `relayMatches`). Once its requests
   * are read, `outcome` is `read` when every filter read to its end, `full`
   * when one was still full at its last page (nothing more of it is read)
   * and `dropped` when one was dropped; `newest` is the newest time read.
   * The requests ride a pool of their own (`scan`) or the bootstrap's. */
  function scanner(filters: readonly ReadFilter[], pages: number) {
    const depth = new Map(filters.map((filter) => [filter, 1]));
    let open = filters.length;
    let full = false;
    let dropped = false;
    let newest: number | undefined;
    const owns = (request: readonly ReadFilter[]) =>
      request.length === 1 && request.every((filter) => depth.has(filter));
    return {
      requests: filters.map((filter) => [filter]),
      owns,
      landed(
        [filter]: readonly ReadFilter[],
        result: readonly RelayEvent[] | undefined,
        queue: ReadFilter[][],
      ) {
        if (!filter) return true;
        if (!result) {
          dropped = true;
          return true;
        }
        const page = [
          ...new Map(result.map((event) => [event.id, event])).values(),
        ].sort(byTime);
        for (const event of page)
          newest = Math.max(newest ?? 0, event.created_at);
        if (!accept(result)) return false;
        const oldest = page.at(-1);
        const at = depth.get(filter) ?? 1;
        if (full) return true;
        if (!oldest || page.length < filter.limit) {
          open--;
          return true;
        }
        if (at >= pages) {
          full = true;
          const rest = queue.filter((request) => !owns(request));
          queue.splice(0, queue.length, ...rest);
          return true;
        }
        const next = {
          ...filter,
          until: oldest.created_at,
          before_id: oldest.id,
        };
        depth.set(next, at + 1);
        queue.push([next]);
        return true;
      },
      divided(
        [filter]: readonly ReadFilter[],
        parts: readonly (readonly ReadFilter[])[],
      ) {
        const part = parts[0]?.[0];
        const at = filter && depth.get(filter);
        if (at && part) depth.set(part, at);
      },
      outcome: () =>
        full ? "full" : dropped ? "dropped" : open ? undefined : "read",
      newest: () => newest,
    };
  }
  /** A scanner's reads in a pool of their own: the outcome, or undefined
   * when retired. */
  async function scan(
    filters: readonly ReadFilter[],
    pages: number,
    generation: number,
    priority: Priority,
  ) {
    const reading = scanner(filters, pages);
    const read = await pool(
      reading.requests,
      generation,
      priority,
      { landed: false, dropped: false, failure: undefined },
      reading.landed,
      reading.divided,
    );
    return read ? reading.outcome() : undefined;
  }
  /** A read of these channels' edits and deletions to its end, from no
   * later than the record's mark less the lookback, has read what their
   * restored evidence owes (see `settleDeletions`). */
  function cover(ids: readonly string[], since: number) {
    const owed = owedDeletions;
    if (owed?.since !== undefined && since <= owed.since)
      for (const id of ids) owed.covered.add(id);
  }
  /** Whether the edits and deletions since `prior` less the lookback were
   * read for every roster channel holding evidence, so the roster sample may
   * confirm the mark past `prior`: the bootstrap's reads carry none, and a
   * held event deleted meanwhile would otherwise be kept under a mark every
   * later delta starts after. A read still full at its last page, which
   * holding the mark back would only widen, vouches by forgetting the held
   * content of those channels that is not `current` (returned by a read of
   * the pass, or received while it ran), as a launch without it would not
   * show it: the relay leaves deleted events out of what it returns. Only a
   * dropped read holds the mark back, for the next pass to retry. Undefined
   * when retired. */
  async function vouch(
    ids: readonly string[],
    prior: UnreadMark,
    current: (id: string) => boolean,
    generation: number,
    priority: Priority,
  ) {
    await restoring?.done;
    if (closed || generation !== epoch) return;
    const holding = new Set(
      [...events.values()].flatMap((event) =>
        contentKind(event) ? (channelOf(event) ?? []) : [],
      ),
    );
    const held = ids.filter((id) => holding.has(id));
    const since = Math.max(0, prior.at - DELTA_LOOKBACK);
    const outcome = await scan(
      sinceReads(held, since, overlayKinds),
      DELETION_PAGES,
      generation,
      priority,
    );
    if (!outcome) return;
    if (outcome === "read") cover(held, since);
    if (outcome === "full") {
      const channels = new Set(held);
      forget(
        [...events.values()].flatMap((event) =>
          contentKind(event) &&
          channels.has(channelOf(event) ?? "") &&
          !current(event.id)
            ? [event.id]
            : [],
        ),
      );
    }
    return outcome !== "dropped";
  }
  /** Restored evidence of roster channels no read has covered (see
   * `cover`) has its deletions since the record's mark read once restore is
   * in, so it does not stay restored when deleted while this device was
   * closed. When that read cannot reach its end, or the record had no mark,
   * the restored evidence no read returned is dropped, as a launch without
   * the record would not show it; when it is dropped, the channels stay
   * owed, their evidence kept, for the next pass. False when retired. */
  async function settleDeletions(
    ids: readonly string[],
    generation: number,
    priority: Priority,
  ) {
    const owed = owedDeletions;
    if (!owed) return true;
    const { since } = owed;
    await restoring?.done;
    if (closed || generation !== epoch) return false;
    const holding = new Set(
      [...unconfirmed].flatMap((id) => {
        const event = events.get(id);
        return event ? (channelOf(event) ?? []) : [];
      }),
    );
    const owing = ids.filter((id) => holding.has(id) && !owed.covered.has(id));
    if (!owing.length) return true;
    const outcome =
      since === undefined
        ? undefined
        : await scan(
            sinceReads(owing, since, overlayKinds),
            DELETION_PAGES,
            generation,
            priority,
          );
    if (closed || generation !== epoch) return false;
    if (outcome === "dropped") return true;
    if (outcome !== "read") {
      const channels = new Set(owing);
      forget(
        [...unconfirmed].filter((id) => {
          const event = events.get(id);
          return !event || channels.has(channelOf(event) ?? "");
        }),
      );
    }
    for (const id of owing) owed.covered.add(id);
    return true;
  }
  // Saved evidence is restored once a session, verified off the repair's
  // path; `restoring` is that verification, and the reads that land during
  // it wait in `early` to be reconciled once it is in.
  let restored = false;
  // Cache clears, each of which wipes the record a launch may be reading.
  let clears = 0;
  let restoring: { done: Promise<void> } | undefined;
  let early: [readonly ReadFilter[], readonly RelayEvent[]][] = [];
  // Restored content no read has returned yet (see `reconcile`).
  const unconfirmed = new Set<string>();
  // Restored events of channels listed but not yet confirmed, which `accept`
  // refuses: offered again as access changes, and saved meanwhile, with the
  // saved record's structure (see `admitRestored`).
  let waiting: RelayEvent[] = [];
  let restoredStructure: ReadonlySet<string> = new Set();
  // What restored evidence owes a read of its deletions (see
  // `settleDeletions`): where that read starts, from the record's mark, and
  // the channels a read since then has covered.
  let owedDeletions:
    | { since: number | undefined; covered: Set<string> }
    | undefined;
  const awaitingAccess = (event: RelayEvent) => {
    const channelId = channelOf(event);
    return (
      channelId !== undefined &&
      !allowed(channelId) &&
      channels
        .list()
        .channels.some(
          (channel) =>
            channel.id === channelId && channel.members?.includes(viewer),
        )
    );
  };
  /** Restored evidence is accepted; a root or parent fetched to group
   * replies goes back to the lookup cache first, so the replies accepted
   * with it group under it at once, and never counts. */
  function admitRestored(batch: readonly RelayEvent[]) {
    for (const event of batch)
      if (restoredStructure.has(event.id) && allowed(channelOf(event) ?? ""))
        keep(event);
    accept(batch.filter((event) => !restoredStructure.has(event.id)));
    for (const event of batch)
      if (
        !restoredStructure.has(event.id) &&
        contentKind(event) &&
        events.has(event.id)
      )
        unconfirmed.add(event.id);
    waiting = batch.filter(
      (event) =>
        !events.has(event.id) &&
        !lookupEvents.has(event.id) &&
        awaitingAccess(event),
    );
  }
  /** Re-verifies the saved evidence in yielding batches, as the channel
   * heads restore does, and admits it whole or not at all: storage is
   * untrusted, and one event failing verification discards the evidence,
   * which the repair reads again. Reads that landed meanwhile are then
   * reconciled against it. */
  function restore(saved: readonly unknown[], structure: ReadonlySet<string>) {
    const run = { done: Promise.resolve() };
    restoring = run;
    restoredStructure = structure;
    run.done = (async () => {
      const verified: RelayEvent[] = [];
      for (let index = 0; index < saved.length; index += 8) {
        if (index) await yieldToHost();
        if (closed || restoring !== run) return;
        const started = performance.now();
        const batch = saved
          .slice(index, index + 8)
          .map((value) => eventDto(JSON.parse(JSON.stringify(value))));
        clientMetrics.cpu(
          "verify.restore",
          performance.now() - started,
          batch.length,
        );
        verified.push(...batch);
      }
      admitRestored(verified);
    })()
      // The record's evidence is gone, so its mark no longer vouches for
      // what this session holds: the pass reads the bootstrap, and no save
      // claims the record's channels or threads were read.
      .catch(() => {
        complete = false;
        covered.clear();
        whole.clear();
      })
      .finally(() => {
        if (restoring !== run) return;
        restoring = undefined;
        const landed = early;
        early = [];
        // Edits and deletions that landed before their restored targets
        // were refused for want of one (see `accept`); they apply now.
        const overlays = landed.flatMap(([, result]) =>
          result.filter(auxiliaryKind),
        );
        if (overlays.length) accept(overlays);
        for (const [request, result] of landed) reconcile(request, result);
      });
  }
  /** Whether the relay returns `event` for `filter`. It matches `#h` against
   * the channel it filed an event under, which for one with no `h` tag (a
   * deletion naming only its target, such as a reaction's removal) is its
   * target's, out of the client's sight: such an event is taken to match. */
  function relayMatches(event: RelayEvent, filter: ReadFilter) {
    if (!filter["#h"] || event.tags.some(([name]) => name === "h"))
      return matchesEvent(event, filter);
    const { "#h": _, ...unscoped } = filter;
    return matchesEvent(event, unscoped);
  }
  /** Restored evidence a read should have returned and did not is gone from
   * the relay: deleted, or no longer readable, while this device was closed,
   * which no read tells. A read returns each filter's newest matches, so a
   * short page covers every match and a full one those down to its last; a
   * keyset page starts below the newest and is not judged. Other filters of
   * the request return older matches too, so a filter's page is the newest
   * `limit` matches of the whole response, as the relay matched them (see
   * `relayMatches`).
   *
   * The bootstrap's reads carry no deletions (the relay attaches edits and
   * deletions only to top-level and depth-limited reads), so restored
   * evidence no read reaches (unread past a full window's cut and outside
   * the roster sample) is not judged here. Its deletion arrives with the
   * delta, or with the read of deletions a pass without one makes (see
   * `settleDeletions`): `accept` takes it like any other and the next save
   * drops both. */
  function reconcile(
    request: readonly ReadFilter[],
    result: readonly RelayEvent[],
  ) {
    if (restoring) early.push([request, result]);
    if (!unconfirmed.size) return;
    const returned = new Set(result.map((event) => event.id));
    const gone = new Set<string>();
    for (const filter of request) {
      if (filter.until !== undefined) continue;
      const page = [
        ...new Map(
          result
            .filter((event) => relayMatches(event, filter))
            .map((event) => [event.id, event]),
        ).values(),
      ].sort(byTime);
      const last =
        page.length < filter.limit ? undefined : page[filter.limit - 1];
      for (const id of unconfirmed) {
        const event = events.get(id);
        if (!event) unconfirmed.delete(id);
        else if (!matchesEvent(event, filter)) continue;
        else if (returned.has(id)) unconfirmed.delete(id);
        else if (!last || event.created_at > last.created_at) gone.add(id);
      }
    }
    forget(gone);
  }
  /** Drops restored evidence found gone, or that no read vouches for. */
  function forget(gone: Iterable<string>) {
    const changed = new Set<string>();
    let removed = false;
    for (const id of gone) {
      const event = events.get(id);
      unconfirmed.delete(id);
      if (!event) continue;
      removed = true;
      events.delete(id);
      bytes -= sizeOf(event);
      const channel = channelOf(event);
      if (channel) changed.add(channel);
    }
    if (!removed) return;
    dropOrphans();
    indexed = false;
    publish(changed);
  }
  // Content that retention evicted or refused since the repair began, or
  // undefined once that outgrew the evidence budget: a save whose reads
  // would select one of them is not complete.
  let dropped: RelayEvent[] | undefined = [];
  const drop = (event: RelayEvent) => {
    if (contentKind(event) && dropped && dropped.push(event) > EVENT_BUDGET)
      dropped = undefined;
  };
  /** What a save keeps of the evidence held (design §3.2), so a relaunch
   * shows what the next warm repair would: what that repair's own reads
   * would return, judged against held evidence newest first with each
   * filter's limit (the cold read's boundary reply passed over, as the
   * repair passes it); every row the projection counts unread or cannot
   * decide yet; and what kept rows depend on: their roots and parents, the
   * viewer's messages in their threads, and the edits and deletions of
   * them. Beyond the record's bounds nothing is kept; that, a selected
   * event retention dropped, a remembered thread's reply kept without its
   * root (unless the relay returned nothing for it: `absent`, saved with the
   * record), or a roster sample owed since a leave, leaves the record
   * incomplete. Of the threads read whole, those still hot, followed and in
   * a channel the mark covers stay so. */
  function retention(participation: ThreadParticipation) {
    indexEvidence();
    const ids = rosterIds();
    const members = new Set(ids);
    // One copy of an event dropped and read again: the one held.
    const held = [
      ...new Map(
        [...(dropped ?? []), ...events.values()].map((event) => [
          event.id,
          event,
        ]),
      ).values(),
    ].filter((event) => contentKind(event) && !tombstones.has(event.id));
    const heldIds = new Map(held.map((event) => [event.id, event]));
    const inChannel = new Map<string, RelayEvent[]>();
    const tagged = new Map<string, RelayEvent[]>();
    const add = (
      map: Map<string, RelayEvent[]>,
      key: string,
      event: RelayEvent,
    ) => {
      const list = map.get(key);
      if (list) list.push(event);
      else map.set(key, [event]);
    };
    for (const event of held) {
      const channelId = channelOf(event);
      if (!channelId) continue;
      add(inChannel, channelId, event);
      for (const [name, id] of event.tags)
        if (name === "e" && id) add(tagged, id, event);
    }
    const kept = new Set<RelayEvent>();
    const read = (
      candidates: readonly RelayEvent[],
      filter: ReadFilter,
      passed?: string,
    ) =>
      candidates
        .filter((event) => matchesEvent(event, filter))
        .sort(byTime)
        .slice(0, filter.limit)
        .filter((event) => event.id !== passed);
    const keep = (page: readonly RelayEvent[]) => {
      for (const event of page) kept.add(event);
    };
    const { windows, sample } = rosterReads(ids);
    for (const filter of [...windows, ...sample])
      keep(
        read(
          (filter["#h"] ?? []).flatMap((id) => inChannel.get(id) ?? []),
          filter,
        ),
      );
    keep(read(held, authoredRead(participation.walk)));
    const stillWhole = new Set<string>();
    const newest = [...participation.roots]
      .filter(([key]) => {
        const channelId = key.slice(0, key.indexOf(":"));
        return members.has(channelId) && choices().get(key) !== false;
      })
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, THREAD_PARTICIPATION_LIMIT);
    newest.forEach(([key, mark], rank) => {
      const separator = key.indexOf(":");
      const channelId = key.slice(0, separator);
      const rootId = key.slice(separator + 1);
      const replies = tagged.get(rootId) ?? [];
      const all = read(replies, threadRead(channelId, [rootId]));
      if (rank < HOT_THREADS) {
        keep(all);
        // Read by ID when not held.
        const root = heldIds.get(rootId) ?? lookupEvents.get(rootId);
        if (root) kept.add(root);
        if (whole.has(key) && covered.has(channelId)) stillWhole.add(key);
        return;
      }
      // A full page is read again whole, as `landed` does.
      const recent = read(replies, threadRead(channelId, [rootId], mark.at));
      keep(
        recent.length < COLD_LIMIT
          ? recent.filter((event) => event.id !== mark.newestId)
          : all,
      );
    });
    const state = reads.state();
    for (const [channelId, entries] of byChannel) {
      const dm = isDm(channelId);
      for (const entry of entries)
        if (isUnread(entry, state, dm) || undecided(entry, dm))
          kept.add(entry.event);
    }
    const threadOf = (event: RelayEvent) =>
      `${channelOf(event)}:${threadReference(event)?.rootId ?? event.id}`;
    // A remembered thread's reply kept without its root would restore as a
    // row of its own: the record does not hold what that row needs, unless
    // the root is gone from the relay too.
    let ungrouped = false;
    const gone = new Set<string>();
    for (const event of [...kept]) {
      const reference = threadReference(event);
      for (const id of reference
        ? [reference.rootId, reference.parentId]
        : []) {
        const dependency = structural(id);
        if (dependency) kept.add(dependency);
      }
      if (
        reference &&
        !structural(reference.rootId) &&
        participation.roots.has(threadOf(event))
      ) {
        if (absent.has(reference.rootId)) gone.add(reference.rootId);
        else ungrouped = true;
      }
    }
    const threads = new Set([...kept].map(threadOf));
    for (const event of [...events.values(), ...witnesses.values()])
      if (
        event.pubkey === viewer &&
        contentKind(event) &&
        !tombstones.has(event.id) &&
        threads.has(threadOf(event))
      )
        kept.add(event);
    const keptIds = new Set([...kept].map((event) => event.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const event of events.values())
        if (
          auxiliaryKind(event) &&
          !keptIds.has(event.id) &&
          event.tags.some(([name, id]) => name === "e" && keptIds.has(id ?? ""))
        ) {
          keptIds.add(event.id);
          kept.add(event);
          grew = true;
        }
    }
    const retained = [...kept].filter(
      (event) =>
        events.has(event.id) ||
        lookupEvents.has(event.id) ||
        witnesses.has(event.id),
    );
    const lost =
      !dropped || ungrouped || resample || retained.length < kept.size;
    retained.push(...waiting.filter(awaitingAccess));
    const fits =
      retained.length <= UNREAD_RECORD_EVENTS &&
      listByteSize(retained) <= UNREAD_RECORD_BYTES;
    // Held only by the lookup cache, or restored from it and waiting.
    const structure = new Set(
      retained.flatMap(({ id }) =>
        !events.has(id) &&
        !witnesses.has(id) &&
        (lookupEvents.has(id) || restoredStructure.has(id))
          ? [id]
          : [],
      ),
    );
    return fits
      ? {
          events: retained,
          structure,
          complete: !lost,
          whole: stillWhole,
          absent: gone,
        }
      : {
          events: [],
          structure: new Set<string>(),
          complete: false,
          whole: new Set<string>(),
          absent: new Set<string>(),
        };
  }
  // The record the saves issued leave once they land, so a save writes only
  // a change: one that fails clears it unless a later save was issued since,
  // and the next save writes again.
  let issuedKey: string | undefined;
  // A save refused because the partition was purged after this session
  // first read it: nothing it holds is saved again.
  let fenced = false;
  let owed: ThreadParticipation | undefined;
  function save(record: UnreadRecord, key?: string) {
    issuedKey = key;
    const saving = storage.save(record);
    void saving.catch((cause: unknown) => {
      if (cause instanceof UnreadRecordPurged) fenced = true;
      if (issuedKey === key) issuedKey = undefined;
    });
    return saving;
  }
  /** The one way the record is saved: the threads with the evidence kept
   * for them (see `retention`), so a save carrying new threads never drops
   * saved evidence. While restored evidence is still being verified the
   * save waits for it, rather than replace it with what is held so far. */
  function persist(participation: ThreadParticipation) {
    if (fenced) return;
    if (restoring) {
      if (!owed) {
        const generation = epoch;
        void restoring.done.then(() => {
          const next = owed;
          owed = undefined;
          if (next && !closed && generation === epoch) persist(next);
        });
      }
      owed = participation;
      return;
    }
    const record = {
      participation,
      ...retention(participation),
      roster: new Set(covered),
      ...(mark ? { mark } : {}),
    };
    complete = record.complete;
    whole = new Set(record.whole);
    const key = JSON.stringify([
      [...participation.roots],
      participation.walk?.since,
      record.events.map((event) => event.id).sort(),
      [...record.structure].sort(),
      record.complete,
      mark,
      [...record.roster].sort(),
      [...record.whole].sort(),
      [...record.absent].sort(),
    ]);
    if (key !== issuedKey) save(record, key);
  }
  async function rememberedRoots(): Promise<ThreadParticipation> {
    if (!persisted) {
      const cleared = clears;
      let record: UnreadRecord<unknown> | undefined;
      try {
        record = await storage.read();
      } catch {
        // Unreadable storage forgets nothing durable: this repair relearns
        // what the relay still shows and saves that.
      }
      // A cache clear meanwhile wiped what was read; the repair is retired
      // and the next one reads again. An access change retires the repair
      // too, but the record read stands.
      if (cleared !== clears) return NO_THREAD_PARTICIPATION;
      persisted = record?.participation ?? NO_THREAD_PARTICIPATION;
      remembered = new Map(persisted.roots);
      mark = record?.mark;
      complete = !!record?.complete;
      for (const id of record?.roster ?? []) covered.add(id);
      whole = new Set(record?.whole);
      for (const id of record?.absent ?? []) absent.add(id);
      // Once a session: a cache clear wipes the record, so the threads read
      // again are only those saved since.
      if (!restored && record?.events.length) {
        restore(record.events, record.structure);
        owedDeletions = {
          since: record.mark && Math.max(0, record.mark.at - DELTA_LOOKBACK),
          covered: new Set(),
        };
      }
      restored = true;
    }
    return {
      roots: remembered ?? persisted.roots,
      ...(persisted.walk ? { walk: persisted.walk } : {}),
    };
  }
  /** One repair's view of the threads the viewer is part of, keyed
   * `channel:root` with the newest time of a reply the viewer wrote or read
   * in each (or of its root) and the newest reply at it: an unread reply
   * advances nothing, so it stays at or above its cold read's `since` and
   * returns each repair until read. Roots start as those remembered from
   * earlier repairs and explicit follows (a follow carries no time, so one
   * first seen here is as recent as this repair), and grow with what this
   * repair's evidence and walk teach: the viewer's replies, replies that
   * mention the viewer, and replies in the viewer's conversations.
   * Unfollowed threads are forgotten; threads in channels the roster lacks
   * are neither read nor forgotten, since the walk mark advances past the
   * viewer's replies in them. The newest are read and remembered. */
  function participating(
    members: ReadonlySet<string>,
    stored: ThreadParticipation,
  ) {
    const followed = (key: string) => choices().get(key) !== false;
    const active = (key: string) =>
      members.has(key.slice(0, key.indexOf(":"))) && followed(key);
    const roots = new Map([...stored.roots].filter(([key]) => followed(key)));
    const seen = Math.floor(now() / 1000);
    for (const [key, following] of choices())
      if (following && !roots.has(key) && active(key))
        roots.set(key, { at: seen });
    /** A peer's reply the viewer has not read, as `isUnread` judges one:
     * marked unread on this device, or past the marks the Inbox counts with
     * (`msg:`, channel, `thread:` and `thread-activity:` frontiers and the
     * synced overrides). */
    const unreadReply = (event: RelayEvent, key: string, state: ReadState) => {
      const separator = key.indexOf(":");
      const channelId = key.slice(0, separator);
      return (
        event.pubkey !== viewer &&
        (!!forcedMessages.get(channelId)?.has(event.id) ||
          !!reads.localUnread(`msg:${event.id}`) ||
          afterFrontier(
            { event, channelId, rootId: key.slice(separator + 1) },
            state,
            false,
          ))
      );
    };
    // An unread reply caps its thread's mark for this pass at its own time,
    // whatever is read after it, so the cold read still reaches it; a reply
    // marked unread below the mark moves the mark back to it, the one way a
    // mark moves back, and a thread or root marked unread holds the mark at
    // the root while that intent lasts. Of replies in the same second, the
    // first by `byTime` is the newest. A thread in a channel the roster lacks
    // is learned, not read: the walk mark advances past the viewer's replies
    // in it. A thread only an unread reply teaches is remembered as of its
    // root, when that is held.
    const ceilings = new Map<string, number>();
    const moveBack = (key: string, at: number) => {
      const mark = roots.get(key);
      if (mark && mark.at > at) roots.set(key, { at });
    };
    const cap = (key: string, at: number) => {
      ceilings.set(key, Math.min(ceilings.get(key) ?? at, at));
      moveBack(key, at);
    };
    const learn = (key: string, event: RelayEvent) => {
      if (!followed(key)) return;
      const rootId = key.slice(key.indexOf(":") + 1);
      const root = structural(rootId);
      if (
        reads.localUnread(`thread:${rootId}`) ||
        reads.localUnread(`msg:${rootId}`)
      )
        cap(key, root?.created_at ?? roots.get(key)?.at ?? event.created_at);
      if (threadReference(event) && unreadReply(event, key, reads.state())) {
        cap(key, event.created_at);
        if (root && !threadReference(root) && !roots.has(key)) learn(key, root);
        return;
      }
      const ceiling = ceilings.get(key);
      const [at, newestId] =
        ceiling !== undefined && ceiling < event.created_at
          ? [ceiling, undefined]
          : [event.created_at, event.id];
      const mark = roots.get(key);
      if (
        !mark ||
        at > mark.at ||
        (at === mark.at &&
          newestId !== undefined &&
          (mark.newestId === undefined ||
            newestId.localeCompare(mark.newestId) < 0))
      )
        roots.set(key, newestId === undefined ? { at } : { at, newestId });
    };
    const newest = () =>
      [...roots]
        .filter(([key]) => active(key))
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, THREAD_PARTICIPATION_LIMIT)
        .map(([key]) => key);
    // Roots asked for this repair, those whose read has not landed, those
    // holding an admitted reply, roots asked for by ID, every event the
    // thread reads returned, and the replies admitted so far by ID: a full
    // page's split rereads replies the page already admitted, which count
    // once.
    const fetched = new Set<string>();
    const pending = new Set<string>();
    const held = new Set<string>();
    const fetchedIds = new Set<string>();
    const rows = new Map<string, RelayEvent>();
    const admitted = new Set<string>();
    // The reply each cold read begins at, by root: already seen, so its
    // return is neither evidence nor a reason to fetch its root.
    const boundary = new Map<string, string>();
    // Roots this pass read whole (see `whole`).
    const readWhole = new Set<string>();
    const threads = threadRead;
    /** The roots of `keys` not yet asked for (or all of them, `again`), by
     * channel, now asked for. */
    const group = (keys: readonly string[], again = false) => {
      const groups = new Map<string, string[]>();
      for (const key of keys) {
        if (fetched.has(key) && !again) continue;
        fetched.add(key);
        pending.add(key);
        const separator = key.indexOf(":");
        const channelId = key.slice(0, separator);
        groups.set(channelId, [
          ...(groups.get(channelId) ?? []),
          key.slice(separator + 1),
        ]);
      }
      return groups;
    };
    const byId = (rootIds: readonly string[]) => {
      for (const id of rootIds) fetchedIds.add(id);
      return chunk(rootIds, 100).map(
        (ids): ReadFilter => ({
          kinds: contentKinds,
          ids,
          include_aux: true,
          limit: ids.length,
        }),
      );
    };
    // The walk: pages asked for beyond the first, the newest authored time
    // seen, and whether the walk reached its end this repair.
    let pages = 0;
    let newestWalked: number | undefined;
    let walked = false;
    /** Whole reads of these roots, with roots the retained evidence lacks
     * fetched by ID so replies group and open under them. */
    const wholeReads = (groups: ReadonlyMap<string, readonly string[]>) => {
      const missing = [...groups.values()]
        .flat()
        .filter((rootId) => !structural(rootId));
      return chunk<ReadFilter>(
        [
          ...[...groups].map(([channelId, rootIds]) =>
            threads(channelId, rootIds),
          ),
          ...byId(missing),
        ],
        UNREAD_WINDOW_BATCH,
      );
    };
    return {
      roots,
      readWhole,
      walk: {
        /** The authored read riding the first request: the viewer's newest
         * page, since the last walk when there was one. */
        first: () => authoredRead(stored.walk),
        /** Learns the threads the viewer replied in from a walk page and
         * returns the next page when this one was full: the viewer's older
         * messages, keyset from the page's oldest. */
        landed(
          filter: ReadFilter,
          result: readonly RelayEvent[],
        ): ReadFilter | undefined {
          const page = result
            .filter(
              (event) =>
                contentKind(event) &&
                event.pubkey === viewer &&
                (filter.since === undefined ||
                  event.created_at >= filter.since),
            )
            .sort(byTime)
            .slice(0, filter.limit);
          for (const event of page) {
            newestWalked = Math.max(newestWalked ?? 0, event.created_at);
            const channelId = channelOf(event);
            const reference = threadReference(event);
            if (channelId && reference)
              learn(conversationKey(channelId, reference.rootId), event);
          }
          const oldest = page.at(-1);
          // Ending at SEED_PAGES with a full page is the one case the mark
          // advances past replies never seen: the oldest of a history longer
          // than the walk reads.
          if (page.length < filter.limit || !oldest || pages >= SEED_PAGES) {
            walked = true;
            return;
          }
          pages++;
          // An oversized page was halved (see `split`); the next keeps that.
          return {
            ...filter,
            until: oldest.created_at,
            before_id: oldest.id,
            limit: filter.until === undefined ? SEED_PAGE : filter.limit,
          };
        },
      },
      /** Whole reads of the newest roots not yet asked for. */
      hot(keys = newest().slice(0, HOT_THREADS)) {
        return wholeReads(group(keys));
      },
      /** Promotion reads (design §3.6): whole reads of the newest roots not
       * in `settled`, the threads already read whole in channels the mark
       * covers, whether or not this pass asked for them. */
      promote(settled: ReadonlySet<string>) {
        return wholeReads(
          group(
            newest()
              .slice(0, HOT_THREADS)
              .filter((key) => !settled.has(key)),
            true,
          ),
        );
      },
      /** Reads of the other remembered roots not yet asked for (or all of
       * them, `again`), each for replies since the newest time seen in it,
       * inclusive: a reply in the same second as that one is not passed
       * over, and the one seen returns too, to be passed over by ID. */
      cold(keys = newest().slice(HOT_THREADS), again = false) {
        return chunk(
          [...group(keys, again)].flatMap(([channelId, rootIds]) =>
            rootIds.map((rootId) => {
              const key = `${channelId}:${rootId}`;
              const mark = roots.get(key);
              if (mark?.newestId) boundary.set(key, mark.newestId);
              return threads(channelId, [rootId], mark?.at ?? 0);
            }),
          ),
          UNREAD_WINDOW_BATCH,
        );
      },
      /** Cold reads of the remembered roots in `channels`, which the mark
       * does not cover, whether or not this pass asked for them (design
       * §3.6): no delta read those channels meanwhile, and their window and
       * sample hold only their newest events. */
      uncovered(channels: ReadonlySet<string>) {
        return this.cold(
          newest()
            .slice(HOT_THREADS)
            .filter((key) => channels.has(key.slice(0, key.indexOf(":")))),
          true,
        );
      },
      /** Learns a thread a lookup found the viewer in, or fetched the root
       * of, and returns its read when not yet asked for: whole when it ranks
       * among the hot threads, since its newest time otherwise. */
      feed(key: string, event: RelayEvent): ReadFilter[][] {
        learn(key, event);
        if (fetched.has(key)) return [];
        const rank = newest().indexOf(key);
        if (rank < 0) return [];
        return rank < HOT_THREADS ? this.hot([key]) : this.cold([key]);
      },
      /** A reply marked unread on this device: its thread's mark moves back
       * to it (to the root, for a thread or its root), capped there for this
       * pass so a lookup's single-event `learn` cannot re-advance it before a
       * save, and the record is saved; `learn` keeps the mark there while the
       * reply stays unread. */
      lower(key: string, at: number) {
        if (!roots.has(key)) return;
        cap(key, at);
        this.save();
      },
      /** A thread read's result, or `undefined` for a dropped read, which
       * only releases its roots' reserved slots. */
      landed(
        request: readonly ReadFilter[],
        result: readonly RelayEvent[] | undefined,
        requests: ReadFilter[][],
      ) {
        // Every root asked for and not yet landed keeps one slot of the
        // budget, so a read landing later still has room for its newest
        // unread reply; a root already holding an admitted reply needs none.
        // This request's roots have landed and are served below.
        const asked = request.flatMap((filter) => {
          const channelId = filter["#h"]?.[0];
          return channelId
            ? (filter["#e"] ?? []).map((rootId) => `${channelId}:${rootId}`)
            : [];
        });
        for (const key of asked) pending.delete(key);
        if (!result) return true;
        for (const filter of request)
          if (filter.ids) noteAbsent(filter.ids, result);
        const reserve = Math.min(
          [...pending].filter((key) => !held.has(key)).length,
          PARTICIPATION_RESERVE,
        );
        // A full page may hide replies under a filter's other roots, or
        // older than a lone root's `since` page reaches; the roots are asked
        // for again and keep their slots.
        const reasked = new Set<string>();
        for (const filter of request) {
          const channelId = filter["#h"]?.[0];
          const rootIds = filter["#e"];
          if (!channelId || !rootIds) continue;
          if (rootIds.length < 2 && filter.since === undefined) continue;
          const page = result.filter(
            (event) =>
              contentKind(event) &&
              channelOf(event) === channelId &&
              event.tags.some(
                ([name, id]) => name === "e" && rootIds.includes(id ?? ""),
              ),
          ).length;
          if (page < filter.limit) continue;
          for (const rootId of rootIds) {
            pending.add(`${channelId}:${rootId}`);
            reasked.add(`${channelId}:${rootId}`);
          }
          // The split stays ahead of the windows, as the thread read was.
          if (rootIds.length < 2) {
            requests.unshift([threads(channelId, rootIds)]);
            continue;
          }
          const half = Math.ceil(rootIds.length / 2);
          requests.unshift([
            { ...filter, "#e": rootIds.slice(0, half) },
            { ...filter, "#e": rootIds.slice(half) },
          ]);
        }
        // A cold read's boundary reply was read by an earlier repair and is
        // passed over; one still unread (a record from before unread replies
        // kept their place, or a thread marked unread since) is admitted.
        // Replies already retained cost the budget nothing: one
        // a window read, or one this pass admitted. Of the rest, each root
        // holding no admitted reply yet is given its newest unread reply, or
        // its newest, most recently read or written in first, drawing on the
        // whole budget (the reserve is kept for exactly these); then the rest
        // are admitted newest first while the budget less the reserve lasts.
        // What is not admitted is not kept and teaches no thread a newer
        // time, so a later read still reaches it.
        const reply = (event: RelayEvent) =>
          contentKind(event) && !!threadReference(event);
        const keyOf = (event: RelayEvent) => {
          const channelId = channelOf(event);
          const rootId = threadReference(event)?.rootId;
          return channelId && rootId ? `${channelId}:${rootId}` : undefined;
        };
        const state = reads.state();
        const seen = (event: RelayEvent) => {
          const key = keyOf(event);
          return (
            key !== undefined &&
            boundary.get(key) === event.id &&
            !unreadReply(event, key, state)
          );
        };
        const fresh = result.filter((event) => !seen(event));
        const candidates = fresh
          .filter(
            (event) =>
              reply(event) && !admitted.has(event.id) && !structural(event.id),
          )
          .sort(byTime);
        const byRoot = new Map<string, RelayEvent[]>();
        for (const event of candidates) {
          const key = keyOf(event);
          if (key) byRoot.set(key, [...(byRoot.get(key) ?? []), event]);
        }
        const room = () => PARTICIPATION_BUDGET - reserve - admitted.size;
        const replies: RelayEvent[] = [];
        const admit = (event: RelayEvent, key: string | undefined) => {
          admitted.add(event.id);
          if (key) held.add(key);
          replies.push(event);
        };
        for (const [key, events] of [...byRoot].sort(
          ([a], [b]) => (roots.get(b)?.at ?? 0) - (roots.get(a)?.at ?? 0),
        )) {
          const [newest] = events;
          if (!newest || held.has(key) || admitted.size >= PARTICIPATION_BUDGET)
            continue;
          admit(
            events.find((event) => unreadReply(event, key, state)) ?? newest,
            key,
          );
        }
        for (const event of candidates) {
          if (room() <= 0) break;
          if (!admitted.has(event.id)) admit(event, keyOf(event));
        }
        const refused = new Set<string | undefined>();
        const kept = fresh.filter((event) => {
          const keep =
            !reply(event) || admitted.has(event.id) || !!structural(event.id);
          if (!keep) refused.add(keyOf(event));
          return keep;
        });
        for (const event of kept) rows.set(event.id, event);
        // A root whose whole read landed with every reply kept, and is not
        // asked for again, is read whole.
        for (const filter of request) {
          const channelId = filter["#h"]?.[0];
          if (!channelId || filter.since !== undefined) continue;
          for (const rootId of filter["#e"] ?? []) {
            const key = `${channelId}:${rootId}`;
            if (reasked.has(key) || refused.has(key)) continue;
            whole.add(key);
            readWhole.add(key);
          }
        }
        // A root fetched by ID is structure (see `keepRoot`), kept before the
        // replies are accepted so they group under it at once.
        const fetchedRoots = new Set(
          kept.filter(
            (event) =>
              !reply(event) &&
              fetchedIds.has(event.id) &&
              !events.has(event.id),
          ),
        );
        for (const event of fetchedRoots) keepRoot(event);
        // A root an admitted reply names that nothing holds is fetched, so
        // the reply groups under it rather than standing as its own row.
        const missing = [
          ...new Set(
            replies.map((event) => threadReference(event)?.rootId ?? ""),
          ),
        ].filter(
          (rootId) =>
            rootId &&
            !structural(rootId) &&
            !rows.has(rootId) &&
            !fetchedIds.has(rootId),
        );
        if (missing.length)
          requests.unshift(...chunk(byId(missing), UNREAD_WINDOW_BATCH));
        const accepted = accept(
          kept.filter((event) => !fetchedRoots.has(event)),
        );
        if (fetchedRoots.size) {
          indexed = false;
          publish(
            new Set(
              [...fetchedRoots].flatMap((event) => channelOf(event) ?? []),
            ),
          );
        }
        return accepted;
      },
      /** Learns roots and their newest times from retained evidence and the
       * thread reads so far. */
      learn() {
        indexEvidence();
        for (const entries of byChannel.values())
          for (const entry of entries) {
            const key = conversationKey(
              entry.channelId,
              entry.threadRootId ?? entry.event.id,
            );
            if (
              (entry.event.pubkey === viewer && entry.parentId) ||
              entry.mentioned ||
              conversation(entry) ||
              roots.has(key)
            )
              learn(key, entry.event);
          }
        for (const event of rows.values()) {
          const channelId = channelOf(event);
          const reference = contentKind(event)
            ? threadReference(event)
            : undefined;
          if (!channelId || !reference) continue;
          const key = conversationKey(channelId, reference.rootId);
          if (roots.has(key)) learn(key, event);
        }
      },
      /** The newest roots become the remembered threads, with the walk mark
       * advanced to the newest authored time when the walk reached its end;
       * a walk cut short by a dropped page is taken up by the next repair. */
      save() {
        const nextRoots = new Map(
          [...roots]
            .sort(([, a], [, b]) => b.at - a.at)
            .slice(0, THREAD_PARTICIPATION_LIMIT),
        );
        const walk =
          walked && newestWalked !== undefined
            ? { since: newestWalked }
            : stored.walk;
        persisted = { roots: nextRoots, ...(walk ? { walk } : {}) };
        persist(persisted);
      },
    };
  }
  /** The newest repair's participation pass, with the queue its reads are
   * pooled from and whether a pool is draining it. A lookup that lands while
   * the repair reads puts the thread it taught at the queue's head, ahead of
   * the remaining windows; one that lands later starts a follow-up. Retired
   * with its access epoch; the next repair replaces it. */
  type Run = {
    pass: ReturnType<typeof participating>;
    generation: number;
    queue: ReadFilter[][];
    pooling: boolean;
  };
  let activePass: Run | undefined;
  /** Reads what lookups taught after the repair finished, in the background,
   * each request once, and saves the threads learned; what a dropped read
   * leaves is the next repair's. The Inbox's loading, freshness, partial
   * notice and error are the repair's alone. A `landed` publish may queue
   * more lookups, whose answers join the queue while it drains. A repair
   * that starts meanwhile replaces the run and reads what it remembers. */
  async function followUp(run: Run) {
    if (run.pooling) return;
    run.pooling = true;
    const current = () =>
      !closed && activePass === run && run.generation === epoch;
    try {
      while (run.queue.length && current()) {
        await pool(
          run.queue,
          run.generation,
          "background",
          { landed: false, dropped: true, failure: undefined },
          (request, result, queue) =>
            current() && run.pass.landed(request, result, queue),
        );
        if (!current()) return;
        run.pass.learn();
        run.pass.save();
      }
    } finally {
      run.pooling = false;
    }
  }
  async function repair(priority: Priority = "foreground", catchUp = false) {
    requested = true;
    if (closed) return;
    if (refresh) {
      // An explicit refresh reads the bootstrap: one that finds a pass
      // catching up has the bootstrap read after it, and waits for that.
      if (!catchUp && catchingUp) {
        repairAgain = true;
        catchingUp = false;
      }
      return repairAgain ? refresh.then(() => refresh) : refresh;
    }
    repairAgain = false;
    catchingUp = catchUp;
    inboxLoading = true;
    const generation = epoch;
    refresh = (async () => {
      const [, stored] = await Promise.all([reads.ensure(), rememberedRoots()]);
      if (closed || generation !== epoch) return;
      const ids = rosterIds();
      if (!ids.length) {
        freshness = "observed";
        owing = false;
        error = undefined;
        return;
      }
      uncover();
      // The mark this pass catches up from, and what it covers.
      const prior = mark;
      const settled = new Set(
        [...whole].filter((key) => covered.has(key.slice(0, key.indexOf(":")))),
      );
      // The evidence held before this pass, and what its reads return (see
      // `vouch`).
      const before = new Set(events.keys());
      const returned = new Set<string>();
      try {
        // This repair reads again what retention dropped before it.
        dropped = [];
        // A delta reads what the roster gained since the mark (see `route`),
        // with the edits and deletions `accept` admits, so those of a held
        // event of any age arrive. Until the cut-over it rides the
        // bootstrap's pool behind the reads the Inbox waits for, so a pass
        // shows at least what the bootstrap alone does, as soon.
        const deltaSince = Math.max(0, (prior?.at ?? 0) - DELTA_LOOKBACK);
        const catching =
          route(catchUp) === "delta"
            ? scanner(
                sinceReads(ids, deltaSince, [...contentKinds, ...overlayKinds]),
                DELTA_PAGES,
              )
            : undefined;
        // Keep roster scope: an unscoped read also includes unjoined open
        // channels. Each bounded request owns its queue-inclusive deadline
        // after marker sync; optional profiles must not block the initial
        // user-visible observation.
        const { marked, windows, sample } = rosterReads(ids);
        // The viewer's newest messages ride the first request, and the
        // remembered threads most recently read or written in are read right
        // behind it, before the windows: the pinned rows are the ones the
        // windows cannot show.
        // The roster sample follows the windows. The other remembered
        // threads are asked for new replies, and the walk pages back through
        // the viewer's history, behind them.
        const pass = participating(new Set(ids), stored);
        const requests = chunk<ReadFilter>(
          [pass.walk.first(), ...windows],
          UNREAD_WINDOW_BATCH,
        );
        const hot = pass.hot();
        requests.splice(1, 0, ...hot);
        requests.push(...sample.map((filter) => [filter]), ...pass.cold());
        remembered = pass.roots;
        // What the mark does not cover is read once beside the delta
        // (design §3.6): the windows of channels outside the roster set, the
        // roster sample, whose chunks a join or leave changes, and the cold
        // threads in those channels, whose hot ones are promoted. Built when
        // queued, so the cold reads are asked again after the bootstrap's.
        const joined = new Set(ids.filter((id) => !covered.has(id)));
        const once = () => [
          ...chunk(
            windows.filter((filter) => joined.has(filter["#h"]?.[0] ?? "")),
            UNREAD_WINDOW_BATCH,
          ),
          ...(joined.size || resample ? sample.map((filter) => [filter]) : []),
          ...pass.uncovered(joined),
        ];
        const run: Run = { pass, generation, queue: requests, pooling: true };
        activePass = run;
        // Once those have landed, or were dropped, the Inbox is no longer
        // loading; the windows still reading show as `observing`.
        const first = new Set<readonly ReadFilter[]>(
          requests.slice(0, 1 + hot.length),
        );
        const progress: Pass = {
          landed: false,
          dropped: false,
          failure: undefined,
        };
        // A dropped window, or the first request carrying them, leaves its
        // channels as they were; a dropped thread read or root fetch leaves
        // those threads to the next repair, with their channels' counts
        // still observed. Either way the Inbox says some activity could not
        // be checked. A dropped walk page leaves only the walk's mark where
        // it was, so the next repair resumes it, and says nothing.
        let unchecked = false;
        // Whether a read the roster sample cannot vouch for dropped: a
        // dropped window only leaves its channel out of the roster set.
        let unvouched = false;
        const windowed = new Set<string>();
        const sampled = new Set<string>();
        let sampledNewest: number | undefined;
        const walkPage = (request: readonly ReadFilter[]) =>
          request.find((filter) => filter.authors);
        const checks = (filter: ReadFilter) =>
          (!!filter["#h"] && !filter["#e"]) ||
          (!!filter.authors && filter.until === undefined);
        const landed = (
          request: readonly ReadFilter[],
          result: readonly RelayEvent[] | undefined,
          queue: ReadFilter[][],
        ) => {
          for (const event of result ?? []) returned.add(event.id);
          if (catching?.owns(request))
            return catching.landed(request, result, queue);
          let ok = true;
          const walk = walkPage(request);
          if (request.some((filter) => filter["#e"] || filter.ids)) {
            ok = pass.landed(request, result, queue);
            if (!result) unchecked = unvouched = true;
          } else if (!result) {
            unchecked ||= request.some(checks);
            unvouched ||= request.some(
              (filter) => filter.authors && filter.until === undefined,
            );
          } else {
            // A read channel with nothing since its mark is observed with
            // nothing unread; a never-read channel with no recent history
            // stays unknown rather than claiming zero. The roster sample has
            // no start, so it returning nothing of a channel claims nothing.
            for (const filter of request) {
              const id =
                filter.since === undefined ? undefined : filter["#h"]?.[0];
              if (id) windowed.add(id);
              if (id && marked.has(id)) known.add(id);
            }
            const samples = request.filter(
              (filter) => filter["#h"] && filter.since === undefined,
            );
            if (samples.length) {
              for (const filter of samples)
                for (const id of filter["#h"] ?? []) sampled.add(id);
              for (const event of result)
                if (contentKind(event))
                  sampledNewest = Math.max(
                    sampledNewest ?? 0,
                    event.created_at,
                  );
            }
            // Walk pages beyond the first are not evidence.
            ok = walk?.until === undefined ? accept(result) : true;
            if (ok && walk) {
              const page = pass.walk.landed(walk, result);
              if (page) queue.push([page]);
            }
            // The authored page teaches the viewer's newest threads at once;
            // their reads go ahead of the remaining windows.
            if (ok && walk && walk.until === undefined) {
              pass.learn();
              const taught = pass.hot();
              queue.unshift(...taught);
              for (const item of taught) first.add(item);
            }
          }
          if (first.delete(request) && !first.size) {
            inboxLoading = false;
            publish();
            // A relay that answered none of these is not asked for the
            // delta: the pass fails as soon as the bootstrap alone would.
            if (catching && progress.landed)
              queue.push(...catching.requests, ...once());
          }
          return ok;
        };
        const divided = (
          request: readonly ReadFilter[],
          parts: readonly (readonly ReadFilter[])[],
        ) => {
          if (first.delete(request)) for (const part of parts) first.add(part);
          catching?.divided(request, parts);
        };
        // The queue is drained until it stays empty: a lookup may put a
        // thread read at its head between a worker finding it empty and the
        // pool returning.
        const drain = async () => {
          while (requests.length)
            if (
              !(await pool(
                requests,
                generation,
                priority,
                progress,
                landed,
                divided,
              ))
            )
              return false;
          return true;
        };
        try {
          if (!(await drain())) return;
          // Threads the windows and the walk newly taught: on a device's
          // first repair, the threads the viewer replied in before their
          // newest page.
          pass.learn();
          requests.push(...pass.hot(), ...pass.cold());
          // Until the cut-over the bootstrap reads the hot threads whole
          // anyway; these are what a pass that catches up reads of them.
          if (catching) requests.push(...pass.promote(settled));
          if (!(await drain())) return;
        } finally {
          run.pooling = false;
        }
        // Nothing landed: nothing was observed, so the repair failed.
        if (!progress.landed) throw progress.failure;
        // A delta read to its end confirms the mark, and has read what
        // restored evidence owes. One still full at its last page leaves the
        // pass to the bootstrap (see `route`); one that dropped leaves the
        // mark for the next pass, which reads it again, and the Inbox says
        // some activity could not be checked.
        const outcome = catching?.outcome();
        const caught = outcome === "read";
        const bootstrapped = !catching || outcome === "full";
        if (!caught && !bootstrapped) unchecked = true;
        if (caught) {
          confirm(catching?.newest());
          cover(ids, deltaSince);
        }
        // In a pass that reads the bootstrap, the roster sample landing whole
        // confirms the mark (design §3.5), once every read but the windows
        // and the walk's later pages landed and, past a mark, the edits and
        // deletions since it were read where evidence is held. In one that
        // catches up, what it read once only adds to the roster set.
        const resampled = ids.every((id) => sampled.has(id));
        let moved = false;
        if (bootstrapped && resampled && !unvouched) {
          const vouched =
            !prior ||
            (await vouch(
              ids,
              prior,
              (id) =>
                returned.has(id) || (!before.has(id) && !unconfirmed.has(id)),
              generation,
              priority,
            ));
          if (vouched === undefined) return;
          if (vouched) confirm(sampledNewest);
          moved = vouched;
        }
        // The roster set (design §3.5–3.6): the channels whose windows and
        // sample landed, and those a delta read to its end kept reading. A
        // mark only the sample moved covers no more, nor a thread not read
        // whole since; one a delta did not move keeps what it covered.
        if (moved) {
          covered.clear();
          for (const key of whole)
            if (!pass.readWhole.has(key)) whole.delete(key);
        } else if (caught) {
          const read = new Set(ids);
          for (const id of covered) if (!read.has(id)) covered.delete(id);
        }
        for (const id of ids)
          if (windowed.has(id) && sampled.has(id)) covered.add(id);
        if (resampled) resample = false;
        if (!(await settleDeletions(ids, generation, priority))) return;
        pass.learn();
        pass.save();
        // A lookup that landed between the last drain and the pool's release
        // queued its read for a pool that had finished; it is the follow-up's.
        if (requests.length) void followUp(run);
        // A dropped request leaves its channels or threads as they were; the
        // Inbox says so until the next repair, with no automatic retry.
        partial = unchecked;
        freshness = "observed";
        owing = false;
        error = undefined;
        publish();
        void findHomes(generation);
      } catch (cause) {
        if (closed || generation !== epoch) return;
        freshness = "stale";
        owing = true;
        error =
          cause instanceof Error ? cause.message : "Unread observation failed";
        publish();
      }
    })().finally(() => {
      refresh = undefined;
      inboxLoading = false;
      publish();
      if (!closed && repairAgain) void repair("foreground", catchingUp);
    });
    publish();
    return refresh;
  }
  // Marked messages already asked for this session, found or not.
  const askedHomes = new Set<string>();
  // The running lookup and the access epoch it serves.
  let findingHomes: { generation: number; done: Promise<void> } | undefined;
  /** Asks the relay for marked messages whose channel is not known, so the
   * channel marks that cover them can replace their marks (see
   * `setCoverage`). Only marks that some channel mark could cover are asked
   * for, each once per session. A failure only keeps marks, which stay
   * correct; the next session asks again. Found messages are not evidence. */
  function findHomes(generation: number) {
    if (findingHomes?.generation === generation) return findingHomes.done;
    // A lookup for an older epoch first releases the IDs it did not use.
    const previous = findingHomes?.done;
    const running = (async () => {
      await previous;
      if (closed || generation !== epoch) return;
      indexEvidence();
      const { frontiers, overrides } = reads.state();
      // Overrides turn pruning off, so channels would not help.
      if (Object.keys(overrides).length) return;
      const broadest = Math.max(
        -1,
        ...Object.entries(frontiers).flatMap(([key, value]) =>
          key.includes(":") ? [] : [value],
        ),
      );
      const ids = new Set<string>();
      for (const [key, value] of Object.entries(frontiers)) {
        const id = markMessage(key);
        if (
          id !== undefined &&
          /^[0-9a-f]{64}$/.test(id) &&
          value <= broadest &&
          !askedHomes.has(id) &&
          !byId.has(id) &&
          reads.home(id) === undefined
        )
          ids.add(id);
      }
      const found: Record<string, string> = {};
      try {
        const wanted = [...ids];
        for (let offset = 0; offset < wanted.length; offset += 100) {
          const batch = wanted.slice(offset, offset + 100);
          for (const id of batch) askedHomes.add(id);
          const signal = AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(10000),
          ]);
          const rows = await reader.read(
            [{ ids: batch, kinds: contentKinds, limit: batch.length }],
            { signal, priority: "background" },
          );
          if (closed || generation !== epoch) break;
          for (const event of rows) {
            const channel = channelOf(event);
            if (ids.has(event.id) && contentKind(event) && channel)
              found[event.id] = channel;
          }
        }
      } catch {
        // Keep what was found; the rest is asked for next session.
      }
      if (generation !== epoch) {
        // An access change discarded this answer; the new epoch asks again.
        for (const id of ids) askedHomes.delete(id);
        return;
      }
      if (!closed && Object.keys(found).length)
        await reads.learnHomes(found).catch(() => {});
    })().finally(() => {
      if (findingHomes?.done === running) findingHomes = undefined;
    });
    findingHomes = { generation, done: running };
    return running;
  }
  /** The viewer's deletions end lookup memberships they were evidence for,
   * including ones decided before the deletion, and even when the deletion
   * itself is not retained as counted evidence. */
  function retract(batch: readonly RelayEvent[]) {
    const ids = batch.flatMap((event) =>
      (event.kind === 5 || event.kind === 9005) && event.pubkey === viewer
        ? event.tags.flatMap(([name, id]) => (name === "e" && id ? [id] : []))
        : [],
    );
    if (!ids.length) return;
    const changed = new Set<string>();
    for (const id of ids) {
      retracted.delete(id);
      retracted.add(id);
      witnesses.delete(id);
      // A deleted message must be fetched again, not reused from the cache.
      if (lookupEvents.delete(id)) heldRoots = undefined;
      for (const [key, lookup] of lookups) {
        if (lookup.evidence !== id) continue;
        changed.add(lookup.channelId);
        // Other messages of the viewer may still hold the membership: ask
        // again (the retracted message stays excluded) rather than end it.
        if (lookup.more) lookups.delete(key);
        else lookup.evidence = undefined;
      }
    }
    for (const id of retracted) {
      if (retracted.size <= 1024) break;
      retracted.delete(id);
    }
    if (changed.size) publish(changed);
  }
  // Verified events never change; each is measured once.
  const sizes = new WeakMap<RelayEvent, number>();
  const sizeOf = (event: RelayEvent) => {
    let size = sizes.get(event);
    if (size === undefined) {
      size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      sizes.set(event, size);
    }
    return size;
  };
  const older = (a: RelayEvent, b: RelayEvent) =>
    a.created_at - b.created_at || a.id.localeCompare(b.id);
  /** `a` outlasts `b`: pinned after ordinary, then the newer. */
  const outlasts = (a: RelayEvent, b: RelayEvent) =>
    (Number(pinned(a)) - Number(pinned(b)) || older(a, b)) > 0;
  /** Retained content once evidence is full, in eviction order: ordinary
   * evidence goes first, the oldest of the channel holding the most of the
   * exhausted budget (events, or bytes), so a busy channel's traffic pushes
   * out its own older evidence and never a quiet channel's only message,
   * whose count would otherwise become a confident zero; evidence of the
   * viewer's threads goes last, oldest first. */
  type Pool = { rows: RelayEvent[]; bytes: number };
  type Pools = { unpinned: Map<string, Pool>; pinned: Pool };
  const EVENT_BUDGET = 4096;
  const BYTE_BUDGET = 8 * 1024 * 1024;
  function pools(): Pools {
    const unpinned = new Map<string, Pool>();
    const pinnedPool: Pool = { rows: [], bytes: 0 };
    for (const event of events.values()) {
      const channel = contentKind(event) ? channelOf(event) : undefined;
      if (channel === undefined) continue;
      const pool = pinned(event)
        ? pinnedPool
        : (unpinned.get(channel) ?? { rows: [], bytes: 0 });
      pool.rows.push(event);
      pool.bytes += sizeOf(event);
      if (pool !== pinnedPool) unpinned.set(channel, pool);
    }
    pinnedPool.rows.sort(older);
    for (const pool of unpinned.values()) pool.rows.sort(older);
    return { unpinned, pinned: pinnedPool };
  }
  /** The pool whose first event goes next, holding the most of `measure`. */
  const next = ({ unpinned, pinned }: Pools, measure: keyof Pool) => {
    const held = (pool: Pool) =>
      measure === "rows" ? pool.rows.length : pool.bytes;
    let chosen: Pool | undefined;
    for (const pool of unpinned.values()) {
      const first = pool.rows[0];
      const best = chosen?.rows[0];
      if (
        first &&
        (!best ||
          held(pool) > held(chosen as Pool) ||
          (held(pool) === held(chosen as Pool) && older(first, best) < 0))
      )
        chosen = pool;
    }
    return chosen ?? pinned;
  };
  const place = (pool: Pool, event: RelayEvent) => {
    const { rows } = pool;
    let low = 0,
      high = rows.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const row = rows[mid];
      if (row && older(row, event) < 0) low = mid + 1;
      else high = mid;
    }
    rows.splice(low, 0, event);
    pool.bytes += sizeOf(event);
  };
  /** Whether incoming content would be evicted before the retained `oldest`:
   * ordinary before pinned; pinned by age; ordinary by age within the channel
   * going next, since another channel holds no more than it. */
  const before = (event: RelayEvent, oldest: RelayEvent) =>
    pinned(event) !== pinned(oldest)
      ? !pinned(event)
      : (pinned(event) || channelOf(event) === channelOf(oldest)) &&
        older(event, oldest) < 0;
  /** Edits and deletions stay only while one of their targets does. */
  function dropOrphans() {
    for (const [id, event] of events) {
      if (!auxiliaryKind(event)) continue;
      const targets = event.tags.flatMap(([name, target]) =>
        name === "e" && target ? [target] : [],
      );
      if (targets.length && targets.every((target) => !events.has(target))) {
        events.delete(id);
        bytes -= sizeOf(event);
      }
    }
  }
  function accept(batch: readonly RelayEvent[]) {
    if (closed) return false;
    retract(batch);
    const changed = new Set<string>();
    indexed = false;
    const incoming = new Map(batch.map((event) => [event.id, event]));
    const owners = channelOwnership((id) => incoming.get(id) ?? events.get(id));
    // An edit or deletion is kept with its newest-ranked content target,
    // retained or in this batch, so an overlay on a pinned message is admitted
    // while the message is. Without one it ranks as itself.
    const overlaid = (event: RelayEvent) => {
      let best: RelayEvent | undefined;
      for (const [name, id] of event.tags) {
        const target =
          name === "e" && id ? (events.get(id) ?? incoming.get(id)) : undefined;
        if (target && contentKind(target) && (!best || outlasts(target, best)))
          best = target;
      }
      return best ?? event;
    };
    // Retained content in eviction order, built once a batch needs room, and
    // the channels room was taken from or refused to.
    let retained: Pools | undefined;
    let evicted = false;
    const unsettled = new Set<string>();
    for (const event of batch) {
      if (
        ![9, 40002, 40008, 40003, 5, 9005].includes(event.kind) ||
        events.has(event.id)
      )
        continue;
      const channels = owners(event);
      if (!channels || [...channels].some((channel) => !allowed(channel)))
        continue;
      const size = sizeOf(event);
      const subject = auxiliaryKind(event) ? overlaid(event) : event;
      // Full: make room by evicting what goes first, unless this event would
      // go before all of it. The channel stays observed; like any sample,
      // the count is of what is retained. An overlay whose own target goes
      // first retires with it: a deleted or superseded body is not kept
      // counted for want of room.
      let admitted = true;
      while (events.size >= EVENT_BUDGET || bytes + size > BYTE_BUDGET) {
        retained ??= pools();
        const pool = next(
          retained,
          events.size >= EVENT_BUDGET ? "rows" : "bytes",
        );
        const oldest = pool.rows[0];
        if (!oldest || (!events.has(subject.id) && before(subject, oldest))) {
          admitted = false;
          for (const channel of channels) unsettled.add(channel);
          break;
        }
        pool.rows.shift();
        pool.bytes -= sizeOf(oldest);
        events.delete(oldest.id);
        bytes -= sizeOf(oldest);
        drop(oldest);
        evicted = true;
        const channel = channelOf(oldest);
        if (channel) {
          changed.add(channel);
          unsettled.add(channel);
        }
        if (oldest.id === subject.id) {
          admitted = false;
          break;
        }
      }
      if (!admitted) {
        drop(event);
        continue;
      }
      events.set(event.id, event);
      bytes += size;
      // Later events in this batch see this one as retained.
      const channel =
        retained && contentKind(event) ? channelOf(event) : undefined;
      if (retained && channel !== undefined) {
        if (pinned(event)) place(retained.pinned, event);
        else {
          const pool = retained.unpinned.get(channel) ?? { rows: [], bytes: 0 };
          place(pool, event);
          retained.unpinned.set(channel, pool);
        }
      }
      for (const channel of channels) {
        known.add(channel);
        changed.add(channel);
      }
      // The recursively resolved owner set already includes every activity
      // projection affected by a deletion, including delete-of-edit chains.
    }
    // A channel left with no retained content is no longer observed: what
    // room took or refused is not a count of nothing.
    for (const channel of unsettled)
      if (
        !retained?.unpinned.get(channel)?.rows.length &&
        !retained?.pinned.rows.some((event) => channelOf(event) === channel) &&
        known.delete(channel)
      )
        changed.add(channel);
    if (evicted) dropOrphans();
    if (changed.size) {
      // The session admits profiles from this same batch after unread evidence.
      if (profiles)
        queueMicrotask(() => {
          if (closed) return;
          const authors = new Set<string>();
          for (const edit of events.values()) {
            if (edit.kind !== 40003) continue;
            for (const [name, id] of edit.tags) {
              const original = name === "e" && id ? events.get(id) : undefined;
              if (original && contentKind(original)) {
                const author = messageAuthor(original, signingAuthority);
                if (author !== edit.pubkey) authors.add(author);
              }
            }
          }
          if (authors.size)
            void profiles.ensure([...authors], "background").catch(() => {});
        });
      const global = freshness !== "observed";
      freshness = "observed";
      publish(global ? undefined : changed);
    }
    return true;
  }
  function requireMessage(target: ReadTarget, id: string) {
    targetKey(target);
    const event = events.get(id);
    if (
      closed ||
      !allowed(target.channelId) ||
      !event ||
      !contentKind(event) ||
      deleted(event) ||
      channelOf(event) !== target.channelId
    )
      throw new Error("Verified readable message evidence unavailable");
    if (
      (target.kind === "thread" && root(event) !== target.rootId) ||
      (target.kind === "message" && target.messageId !== id)
    )
      throw new Error("Message does not belong to the read target");
    if (
      target.kind === "channel" &&
      threadReference(event) &&
      !event.tags.some(([name, value]) => name === "broadcast" && value === "1")
    )
      throw new Error("A thread reply cannot advance the channel frontier");
    return event;
  }
  function messageSubtree(channelId: string, messageId: string) {
    const selected = requireMessage(
      { kind: "message", channelId, messageId },
      messageId,
    );
    indexEvidence();
    const children = new Map<string, string[]>();
    for (const { event } of byChannel.get(channelId) ?? []) {
      const parent = threadReference(event)?.parentId;
      if (!parent || event.id === selected.id || !root(event)) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(event.id);
      children.set(parent, siblings);
    }
    const ids = new Set<string>([messageId]);
    const stack = [messageId];
    while (stack.length) {
      const parent = stack.pop();
      if (!parent) break;
      for (const id of children.get(parent) ?? []) {
        if (ids.has(id)) continue;
        ids.add(id);
        stack.push(id);
      }
    }
    return [...ids].flatMap((id) => {
      const event = events.get(id);
      return event ? [event] : [];
    });
  }
  // Queued explicit reads and manual intent share the same access fence.
  function channelIntentValid(channelId: string) {
    const generation = channelReadGenerations.get(channelId) ?? {};
    channelReadGenerations.set(channelId, generation);
    return () =>
      !closed &&
      channelReadGenerations.get(channelId) === generation &&
      allowed(channelId);
  }
  // Capture evidence and time once per click, including every channel in a sweep.
  function channelReadIntent(channelId: string, clickedAt: number) {
    if (closed || !allowed(channelId))
      throw new Error("Read target unavailable");
    indexEvidence();
    const rows = byChannel.get(channelId) ?? [];
    // Explicit catch-up covers everything posted up to this click, including
    // messages this client has not loaded: a cut at the newest retained message
    // lets older activity arrive later and relight the channel. Snapshot it at
    // invocation, not after a queued storage write. Frontiers merge by maximum,
    // so a device clock running ahead also covers arrivals until real time
    // passes it; automatic reading must never use the clock.
    const cut = rows.reduce(
      (newest, { event }) => Math.max(newest, event.created_at),
      clickedAt,
    );
    const keys = new Set([channelId, messageForceKey(channelId)]);
    for (const { event, rootId } of rows) {
      keys.add(`msg:${event.id}`);
      if (rootId) keys.add(`thread:${rootId}`);
      // A retained top-level message establishes its thread's channel even
      // when that thread's replies are outside our bounded evidence window.
      if (!threadReference(event)) keys.add(`thread:${event.id}`);
    }
    const valid = channelIntentValid(channelId);
    return async () => {
      const result =
        rows.length || reads.snapshot().capability === "frontier-sync"
          ? await reads.read(channelId, cut, valid, true, [...keys])
          : await reads.clearLocalUnread(channelId, [...keys], valid);
      if (valid() && forcedMessages.delete(channelId))
        publish(new Set([channelId]));
      return result;
    };
  }
  const capability: UnreadCapability = Object.freeze<UnreadCapability>({
    inbox,
    subscribeInbox(listener) {
      inbox();
      inboxListeners.add(listener);
      return () => inboxListeners.delete(listener);
    },
    snapshot,
    attention,
    subscribe(target, listener) {
      snapshot(target);
      const key = keyFor(target),
        set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
    activity,
    subscribeActivity: addActivityListener,
    sync: reads.snapshot,
    subscribeSync(listener) {
      const stop = reads.subscribe(listener);
      membershipListeners.add(listener);
      return () => {
        stop();
        membershipListeners.delete(listener);
      };
    },
    ensure: () =>
      refresh ?? (requested ? Promise.resolve() : repair("foreground", true)),
    refresh: async () => {
      await reads.refresh("foreground");
      await repair();
    },
    revision: reads.revision,
    generation: () => epoch,
    retrySync: async () => {
      await reads.refresh();
      await reads.flush();
    },
    syncedManualUnread: false,
    following(channelId, rootId) {
      if (closed || !allowed(channelId)) return false;
      const id = rootId.toLowerCase();
      const key = conversationKey(channelId, id);
      const explicit = choices().get(key);
      if (explicit !== undefined) return explicit;
      indexEvidence();
      // The reference's automatic follow, which `conversation` applies to
      // every reply under the root: the viewer wrote or replied in the thread.
      return ownThreads.has(key);
    },
    follow(channelId, rootId, following) {
      if (closed || !allowed(channelId) || !/^[0-9a-f]{64}$/i.test(rootId))
        throw new Error("Thread unavailable");
      const key = conversationKey(channelId, rootId.toLowerCase());
      const next = new Map(choices());
      next.delete(key);
      next.set(key, following);
      const changed = new Set([channelId]);
      for (const [oldest] of next) {
        if (next.size <= THREAD_FOLLOW_LIMIT) break;
        next.delete(oldest);
        changed.add(oldest.slice(0, oldest.indexOf(":")));
      }
      follows.write(next);
      saved = next;
      // A follow carries no time of its own: the thread joins the viewer's
      // remembered threads as of now, and the next repair refetches it.
      if (following && remembered && !remembered.has(key))
        remembered.set(key, { at: Math.floor(now() / 1000) });
      followsChanged(changed);
    },
    reading(channelId) {
      if (closed || !allowed(channelId) || handles.size >= 64)
        throw new Error("Reading handle unavailable");
      let active = true;
      const generation = epoch;
      const manualRevision = reads.revision();
      const observed = new Set<string>();
      const dispose = () => {
        active = false;
        handles.delete(dispose);
        views.delete(dispose);
      };
      // A newer manual unread cancels this lease. Inside a save, check the
      // journal being replaced: another window may have marked it since.
      const manual = (key: string, journal?: ReadJournal) =>
        (journal ? journal.localUnread[key] : reads.localUnread(key)) ?? 0;
      const valid = (journal?: ReadJournal) =>
        active &&
        !closed &&
        generation === epoch &&
        allowed(channelId) &&
        manual(channelId, journal) <= manualRevision;
      handles.add(dispose);
      // Reading a DM reads all of it, through the newest retained message,
      // and ends a manual unread on it. A DM is all for the reader, so there
      // is no backlog to keep. One lease is one earned dwell, so its catchUp
      // and observe share the first cutoff: a message arriving between them
      // waits for the next dwell. Returns undefined outside DMs.
      let dmRead: Promise<unknown> | undefined;
      const readDm = (
        witnesses: readonly Readonly<{ target: ReadTarget; id: string }>[],
      ) => {
        if (!isDm(channelId)) return undefined;
        if (dmRead) return dmRead;
        for (const { target, id } of witnesses) {
          let event: RelayEvent;
          try {
            event = requireMessage(target, id);
          } catch {
            continue;
          }
          indexEvidence();
          const cut = (byChannel.get(channelId) ?? []).reduce(
            (newest, row) => Math.max(newest, row.event.created_at),
            -1,
          );
          dmRead =
            (reads.state().frontiers[channelId] ?? -1) < cut ||
            manual(channelId)
              ? reads.read(
                  channelId,
                  cut,
                  (journal) =>
                    valid(journal) && requireMessage(target, id) === event,
                  true,
                  [channelId],
                )
              : Promise.resolve();
          return dmRead;
        }
        return Promise.resolve();
      };
      return Object.freeze({
        dispose,
        view(
          ids: readonly string[],
          visible: (id: string, measured: boolean) => boolean,
        ) {
          if (!valid() || ids.length > 128) return;
          const verified = ids.filter((id) => {
            try {
              requireMessage({ kind: "message", channelId, messageId: id }, id);
              return true;
            } catch {
              return false;
            }
          });
          views.set(dispose, {
            channelId,
            ids: new Set(verified),
            visible: (id, measured) => valid() && visible(id, measured),
          });
        },
        async catchUp(id: string, rootId?: string) {
          if (!valid()) return;
          const target = rootId
            ? { kind: "thread" as const, channelId, rootId }
            : { kind: "channel" as const, channelId };
          const dm = readDm([{ target, id }]);
          if (dm) {
            await dm;
            return;
          }
          const event = requireMessage(target, id);
          const key = rootId
            ? `thread-activity:${rootId}`
            : `activity:${channelId}`;
          // A historical window is not the live bottom. Check retained evidence
          // at invocation, not after a later arrival queues behind this intent.
          indexEvidence();
          const rows = byChannel.get(channelId) ?? [];
          const newer = rows.some(
            (entry) =>
              entry.event.created_at > event.created_at &&
              (rootId
                ? entry.rootId === rootId
                : !threadReference(entry.event) ||
                  entry.event.tags.some(
                    ([name, value]) => name === "broadcast" && value === "1",
                  )),
          );
          if (newer) return;
          // Replies can be newer than the last top-level row. Quiet that already
          // retained activity too, without acknowledging the replies themselves.
          const cut = rootId
            ? event.created_at
            : rows.reduce(
                (latest, row) => Math.max(latest, row.event.created_at),
                event.created_at,
              );
          const frontiers = reads.state().frontiers;
          const current = (journal: ReadJournal) =>
            valid(journal) &&
            requireMessage(target, id) === event &&
            (!rootId || manual(`thread:${rootId}`, journal) <= manualRevision);
          // Reaching the live bottom of a channel ends a manual unread on the
          // channel. Unseen replies and marked messages stay unread.
          const endManual = !rootId && !!reads.localUnread(channelId);
          // A broader mark already covering the cut makes this one redundant.
          if (
            Math.max(
              frontiers[key] ?? -1,
              frontiers[channelId] ?? -1,
              rootId ? (frontiers[`thread:${rootId}`] ?? -1) : -1,
            ) >= cut
          ) {
            if (endManual)
              await reads.clearLocalUnread(channelId, [channelId], current);
          } else
            await reads.read(
              key,
              cut,
              current,
              endManual,
              endManual ? [channelId] : undefined,
            );
          if (rootId) return;
          // The timeline above the bottom also shows mentions and broadcasts,
          // which `activity:` never reads: it is a timestamp, so it would also
          // read attention that arrives later with an older timestamp. Mark
          // the retained ones through the bottom row individually instead,
          // at most the newest 128, as one observation reads, so a backlog
          // cannot crowd older marks out of the synced budget.
          const state = reads.state();
          const shown = rows
            .filter(
              (entry) =>
                entry.event.created_at <= event.created_at &&
                (!threadReference(entry.event) || entry.broadcast) &&
                priority(entry, false) &&
                !forcedMessages.get(channelId)?.has(entry.event.id) &&
                !reads.localUnread(`msg:${entry.event.id}`) &&
                !overrideActive(
                  state.overrides[`msg:${entry.event.id}`],
                  effectiveFrontier(
                    state,
                    `msg:${entry.event.id}`,
                    channelId,
                    entry.rootId,
                  ),
                ) &&
                isUnread(entry, state, false),
            )
            .sort((a, b) => order(b.event, a.event))
            .slice(0, 128);
          if (shown.length)
            await reads.readMessages(
              shown.map((entry) => ({
                key: `msg:${entry.event.id}`,
                timestamp: entry.event.created_at,
                channelId,
                ...(entry.rootId ? { rootId: entry.rootId } : {}),
              })),
              undefined,
              (journal) =>
                current(journal) &&
                shown.every(
                  (entry) =>
                    events.get(entry.event.id) === entry.event &&
                    !manual(`msg:${entry.event.id}`, journal),
                ),
            );
        },
        async observe(ids: readonly string[]) {
          if (!valid() || ids.length > 128) return;
          const dm = readDm(
            ids.map((id) => ({
              target: { kind: "message" as const, channelId, messageId: id },
              id,
            })),
          );
          if (dm) {
            await dm;
            return;
          }
          for (const id of ids) {
            if (!valid() || observed.has(id)) continue;
            const target = {
              kind: "message" as const,
              channelId,
              messageId: id,
            };
            const event = requireMessage(target, id);
            indexEvidence();
            const entry = byId.get(id);
            const state = reads.state();
            if (
              (entry &&
                !state.overrides[targetKey(target)] &&
                caughtUp(entry, (key) => state.frontiers[key])) ||
              (effectiveFrontier(
                reads.state(),
                targetKey(target),
                channelId,
                threadReference(event) ? root(event) : undefined,
              ) ?? -1) >= event.created_at
            ) {
              observed.add(id);
              continue;
            }
            await reads.read(
              targetKey(target),
              event.created_at,
              (journal) =>
                valid(journal) && requireMessage(target, id) === event,
            );
            observed.add(id);
          }
        },
      });
    },
    async markThrough(target, id) {
      const event = requireMessage(target, id),
        generation = epoch;
      return serialize(target.channelId, () =>
        reads.read(
          targetKey(target),
          event.created_at,
          () =>
            !closed &&
            generation === epoch &&
            requireMessage(target, id) === event,
          true,
        ),
      );
    },
    async markMessageUnread(channelId, messageId) {
      const visit = visits.get(channelId) ?? 0;
      const rows = messageSubtree(channelId, messageId);
      const generation = epoch;
      return serialize(channelId, async () => {
        const valid = () =>
          !closed &&
          generation === epoch &&
          (visits.get(channelId) ?? 0) === visit &&
          allowed(channelId) &&
          rows.every((row) => events.get(row.id) === row && !deleted(row));
        if (!valid()) throw new Error("Unread channel visit expired");
        const result = await reads.markLocalUnread(
          messageForceKey(channelId),
          valid,
        );
        // A leave after persistence must not restore a previous visit's overlay.
        if (valid()) {
          const forced = forcedMessages.get(channelId) ?? new Set<string>();
          for (const row of rows) forced.add(row.id);
          forcedMessages.set(channelId, forced);
          publish(new Set([channelId]));
        }
        return result;
      });
    },
    async markMessageRead(channelId, messageId) {
      const visit = visits.get(channelId) ?? 0;
      const rows = messageSubtree(channelId, messageId);
      const generation = epoch;
      return serialize(channelId, async () => {
        const valid = () =>
          !closed &&
          generation === epoch &&
          (visits.get(channelId) ?? 0) === visit &&
          allowed(channelId) &&
          rows.every((row) => events.get(row.id) === row && !deleted(row));
        if (!valid()) throw new Error("Unread channel visit expired");
        const forced = forcedMessages.get(channelId);
        const ids = new Set(rows.map((row) => row.id));
        const remaining = forced && [...forced].some((id) => !ids.has(id));
        const result = await reads.readMessages(
          rows
            .filter((row) => row.pubkey !== viewer)
            .map((row) => ({
              key: `msg:${row.id}`,
              timestamp: row.created_at,
              channelId,
              ...(threadReference(row) && root(row)
                ? { rootId: root(row) }
                : {}),
            })),
          remaining ? undefined : messageForceKey(channelId),
          valid,
        );
        if (valid()) {
          for (const row of rows) forced?.delete(row.id);
          if (!forced?.size) forcedMessages.delete(channelId);
          publish(new Set([channelId]));
        }
        return result;
      });
    },
    leaveChannel(channelId) {
      visits.set(channelId, (visits.get(channelId) ?? 0) + 1);
      if (forcedMessages.delete(channelId)) publish(new Set([channelId]));
      entered.delete(channelId);
    },
    enterChannel(channelId) {
      const visit = visits.get(channelId) ?? 0;
      return serialize(channelId, async () => {
        await reads.ready;
        if (entered.has(channelId)) return;
        const valid = () =>
          !closed &&
          allowed(channelId) &&
          (visits.get(channelId) ?? 0) === visit;
        if (!valid()) throw new Error("Unread channel visit expired");
        // A prior visit's message force is reconciled on open; independent channel intent remains.
        if (reads.localUnread(messageForceKey(channelId)))
          await reads.clearLocalUnread(
            messageForceKey(channelId),
            [messageForceKey(channelId)],
            valid,
          );
        if (valid()) entered.add(channelId);
      });
    },
    async markChannelRead(channelId) {
      return capability.prepareChannelRead(channelId)();
    },
    prepareChannelRead(channelId) {
      const read = channelReadIntent(channelId, Math.floor(Date.now() / 1000));
      return () => serialize(channelId, read);
    },
    async markAllChannelsRead() {
      if (closed) throw new Error("Read target unavailable");
      // Decide the sweep from the list at invocation; channels granted later wait
      // for the next explicit action, like arrivals after a per-channel cut.
      const clickedAt = Math.floor(Date.now() / 1000);
      const pending = channels
        .list()
        .channels.filter((channel) => allowed(channel.id))
        .filter((channel) => {
          const current = compute({ kind: "channel", channelId: channel.id });
          // The sidebar can be quiet while unopened replies still have receipts.
          // Explicit Mark all must consume retained unread intent, not styling.
          return (
            current.manual !== "none" ||
            (byChannel.get(channel.id) ?? []).some(
              (entry) =>
                isUnread(entry, reads.state(), channel.channelType === "dm") ||
                !!(
                  entry.rootId && reads.localUnread(`thread:${entry.rootId}`)
                ) ||
                (!threadReference(entry.event) &&
                  !!reads.localUnread(`thread:${entry.event.id}`)),
            )
          );
        })
        .map((channel) => ({
          channelId: channel.id,
          read: channelReadIntent(channel.id, clickedAt),
        }));
      const results: ReadMutationResult[] = [];
      let failure: unknown;
      let failed = false;
      let prior = Promise.resolve();
      for (const { channelId, read } of pending) {
        // Reserve each channel's place now, before a newer manual action. Saves
        // still run sequentially; a revoked channel is skipped when its turn arrives.
        const before = prior;
        const write = serialize(channelId, async () => {
          await before;
          if (allowed(channelId)) return read();
        });
        prior = write.then(
          (result) => {
            if (result) results.push(result);
          },
          (error) => {
            if (!failed) failure = error;
            failed = true;
          },
        );
      }
      await prior;
      if (failed) throw failure;
      return results;
    },
    async markUnreadLocal(target) {
      const key = targetKey(target);
      const channelValid = channelIntentValid(target.channelId);
      const valid = () => {
        if (!channelValid()) return false;
        if (target.kind !== "channel")
          requireMessage(
            target,
            target.kind === "thread" ? target.rootId : target.messageId,
          );
        return true;
      };
      if (!valid()) throw new Error("Unread target unavailable");
      const result = await serialize(target.channelId, () =>
        reads.markLocalUnread(key, valid),
      );
      // In a remembered thread, the mark moves back to the reply marked
      // unread, or to the root for a thread or its root, so the cold read
      // reaches it again on later launches; the repair's `learn` keeps it
      // there while the reply stays unread.
      if (target.kind !== "channel") {
        const event = events.get(
          target.kind === "thread" ? target.rootId : target.messageId,
        );
        const rootId =
          target.kind === "thread"
            ? target.rootId
            : event && (threadReference(event)?.rootId ?? event.id);
        if (event && rootId)
          activePass?.pass.lower(
            conversationKey(target.channelId, rootId),
            event.created_at,
          );
      }
      return result;
    },
    async clearUnreadLocal(target) {
      const key = targetKey(target);
      const channelValid = channelIntentValid(target.channelId);
      const valid = () => {
        if (!channelValid()) return false;
        if (target.kind !== "channel")
          requireMessage(
            target,
            target.kind === "thread" ? target.rootId : target.messageId,
          );
        return true;
      };
      if (!valid()) throw new Error("Unread target unavailable");
      return serialize(target.channelId, () =>
        reads.clearLocalUnread(key, [key], valid),
      );
    },
  });
  return {
    capability,
    // Private session evidence lookup; never seeds timeline windows or grants access.
    // Reference-only auxiliaries inherit every owning channel through the same
    // bounded, fail-closed ancestry used for retention.
    event(id: string) {
      if (closed) return;
      const witnessed = witnesses.get(id);
      if (witnessed)
        return allowed(channelOf(witnessed) ?? "") ? witnessed : undefined;
      const event = events.get(id);
      if (!event) return;
      const owners = channelOwnership((targetId) => events.get(targetId))(
        event,
      );
      return owners && [...owners].every(allowed) ? event : undefined;
    },
    // Edits omitted by later relay queries can still affect the shared fold.
    // Discover tombstones before ownership verification can expose retained edits.
    // Display authorization stays in the shared fold; no second edit projection.
    retainedEditIds(ids: readonly string[]) {
      if (closed) return [];
      const targets = new Set(ids);
      const owners = channelOwnership((id) => events.get(id));
      return [...events.values()].flatMap((event) => {
        if (event.kind !== 40003 || deleted(event)) return [];
        const channels = owners(event);
        if (!channels || ![...channels].every(allowed)) return [];
        return event.tags.some(([name, id]) => {
          const target = id && targets.has(id) ? events.get(id) : undefined;
          return (
            name === "e" &&
            target &&
            contentKind(target) &&
            (target.pubkey === event.pubkey ||
              messageAuthor(target, signingAuthority) === event.pubkey ||
              ([9, 40002].includes(target.kind) &&
                event.tags.some(
                  ([name, channel]) =>
                    name === "h" && channel === channelOf(target),
                ))) &&
            !deleted(target)
          );
        })
          ? [event.id]
          : [];
      });
    },
    accept,
    purge,
    /** `covered`: the membership route's replay was continuous, so read state
     * resumes from it instead of reading its snapshot again. */
    /** A repair is still owed: evidence (see `owing`) or read-state markers. */
    owed: () => requested && (owing || reads.owed()),
    reconnect(covered = false) {
      if (requested)
        void (covered ? reads.resume() : reads.refresh()).then(() =>
          repair("background", true),
        );
    },
    stale() {
      epoch++;
      channelReadGenerations.clear();
      freshness = "stale";
      owing = true;
      reads.stale();
      publish();
    },
    /** Settles once the saved record is wiped, rejecting when it was not. */
    clear() {
      epoch++;
      clears++;
      channelReadGenerations.clear();
      resetLookups();
      repairAgain = false;
      indexed = false;
      activePass = undefined;
      remembered = undefined;
      persisted = undefined;
      restoring = undefined;
      early = [];
      unconfirmed.clear();
      waiting = [];
      owed = undefined;
      owedDeletions = undefined;
      mark = undefined;
      complete = false;
      covered.clear();
      whole.clear();
      resample = false;
      absent.clear();
      dropped = [];
      // Wiped as the channel heads are, remembered threads and walk mark
      // included; the next repair saves afresh. A purge has wiped it already.
      const wiped = fenced
        ? Promise.resolve()
        : save({
            participation: NO_THREAD_PARTICIPATION,
            events: [],
            structure: new Set(),
            complete: false,
          }).catch((cause: unknown) => {
            if (!(cause instanceof UnreadRecordPurged)) throw cause;
          });
      partial = false;
      events.clear();
      known.clear();
      forcedMessages.clear();
      entered.clear();
      bytes = 0;
      freshness = "unknown";
      error = undefined;
      publish();
      return wiped;
    },
    dispose() {
      closed = true;
      epoch++;
      channelReadGenerations.clear();
      lifetime.abort();
      resetLookups();
      activePass = undefined;
      membershipListeners.clear();
      for (const stop of [...handles]) stop();
      stopRead();
      stopProfiles?.();
      stopFollows();
      stopChannels();
      listeners.clear();
      snapshots.clear();
      dirty.clear();
      activityListeners.clear();
      activitySnapshots.clear();
      activityDirty.clear();
      events.clear();
      inboxSnapshot = undefined;
      inboxDirty = true;
      inboxListeners.clear();
      forcedMessages.clear();
      entered.clear();
      storage.close();
      reads.dispose();
    },
  };
}

// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The history region must support keyboard scrolling.
import { ActivityExpansion } from "./ActivityExpansion";
import { useChannelIdentityNames } from "../identity-names/react";
import { useMessageSelectionCopy } from "./selection-copy";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import {
  CaretDownIcon,
  ChatCircleIcon,
} from "../../shared/design-system/icons";
import { MembershipRow } from "./MembershipRow";
import {
  membershipRows,
  renderedRowIndex,
  withoutStartingAgents,
} from "./membership-rows";
import { activityGroups, RECENT_ACTIVITY_COUNT } from "./activity-groups";
import { DayDivider } from "./MessageTimestamp";
import type { ConversationExtensions } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import type { MessageAttention } from "../relay/unread";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  Fragment,
  type KeyboardEvent,
} from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { MessageRow, type MessageLinkOrigin } from "./MessageRow";
import { continuesMessageGroup } from "./message-grouping";
import type { Attachment, ChannelWindow } from "../relay/contracts";
import { useRowProfiles } from "../relay/react";
import { geometryFor, geometrySignature } from "./geometry";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { correctScrollTop } from "./scroll-correction";
import { readingPositioned, useReading } from "./use-reading";
import { useMessageReveal } from "./use-message-reveal";
import type { PageNavigation } from "../navigation/service";
import { messageViewKey } from "./view-key";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { moveMessageSelection } from "./message-selection";
import { useMessageSelection } from "./use-message-selection";
import { useMessageVisit } from "./MessageManagement";

// Native upward scrolling can start on a focused message link or button.
// Inner scrollports own the key while they can move. At their top boundary,
// native keyboard chaining differs by engine/OS, even with CSS containment.
// Admit a candidate there; only observed history movement can leave follow.
function scrollsHistoryUp(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.defaultPrevented) return false;
  const modified = event.altKey || event.ctrlKey || event.metaKey;
  // ArrowUp includes native Command/Option/Control+Up variants; Control+Home
  // is the Windows/Linux start chord. These are intent candidates: only an
  // observed upward history scroll can actually leave bottom follow.
  const upward =
    event.key === "ArrowUp" ||
    (!modified &&
      (["PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey))) ||
    (event.key === "Home" && event.ctrlKey && !event.altKey && !event.metaKey);
  if (!upward) return false;
  let target = event.target instanceof HTMLElement ? event.target : null;
  if (!target || !event.currentTarget.contains(target)) return false;
  while (target && target !== event.currentTarget) {
    if (
      target.matches(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='listbox'], [role='slider'], [role='spinbutton']",
      ) ||
      (event.key === " " && target.matches("button, [role='button']"))
    )
      return false;
    const style = getComputedStyle(target);
    if (
      ["auto", "scroll", "overlay"].includes(style.overflowY) &&
      target.scrollTop > 0
    )
      return false;
    target = target.parentElement;
  }
  return target === event.currentTarget;
}

type ReadingPosition = {
  bottom: boolean;
  anchor?: { id: string; y: number };
};
type NewMessageBoundary = {
  token: object;
  session: RelaySession;
  scope: string;
  channelId: string;
  captured: boolean;
  messageId?: string;
};
type NewMessageBoundaryBaseline = {
  token: object;
  session: RelaySession;
  scope: string;
  channelId: string;
  revision?: number;
  messageIds: ReadonlySet<string>;
  attention: Map<string, Pick<MessageAttention, "unread" | "forced"> | null>;
};
// Inline message seeks can unmount the timeline without ending its channel visit.
// Weak keys retain entry evidence only for the existing MessageManagement token.
const visitBoundaries = new WeakMap<
  object,
  { boundary: NewMessageBoundary; baseline: NewMessageBoundaryBaseline }
>();
const unknownUnreadSync = Object.freeze({ completeness: "unknown" as const });
function positionAt(
  element: HTMLElement,
  restoredAnchor?: string,
): ReadingPosition {
  const top = element.getBoundingClientRect().top;
  const mounted = Array.from(
    element.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
  // A resize restoration keeps its chosen message even if wrapping makes its
  // paragraph taller than the viewport. Only a new gesture chooses a new anchor.
  const restored = mounted.find((row) => {
    const rect = row.getBoundingClientRect();
    return (
      row.dataset.messageId === restoredAnchor &&
      rect.bottom > top &&
      rect.top < top + element.clientHeight
    );
  });
  // Otherwise prefer a whole visible message over a partly clipped row.
  const row =
    restored ??
    mounted.find((row) => {
      const text = row.querySelector("p")?.getBoundingClientRect();
      return (
        text && text.top >= top && text.bottom <= top + element.clientHeight
      );
    }) ??
    mounted.find((row) => row.getBoundingClientRect().bottom > top);
  return {
    bottom:
      element.scrollHeight - element.clientHeight - element.scrollTop < 80,
    ...(row?.dataset.messageId
      ? {
          anchor: {
            id: row.dataset.messageId,
            y: row.getBoundingClientRect().top - top,
          },
        }
      : {}),
  };
}
export type ChannelTimelineProps = {
  extensions?: ConversationExtensions | undefined;
  channelId: string;
  scope: string;
  viewer?: string | undefined;
  queries: RelaySession;
  /** A parent keyed by connection generation can preserve its timeline on cache promotion. */
  continuityKey?: string | undefined;
  window: ChannelWindow;
  launchPending?: boolean | undefined;
  /** Solo chats page history on scroll; retain an explicit button for errors. */
  historyControl?: "button" | "scroll";
  /** Personal chats keep their compact initial history spacing. */
  chatPresentation?: boolean | undefined;
  /** False: rows open existing threads but offer none to start; see MessageRow. */
  startsThreads?: boolean | undefined;
  /** A following composer shows conversation activity; the jump button leaves it a lane. */
  activityLane?: boolean | undefined;
  onOpenLink(url: string, origin?: MessageLinkOrigin): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  /** One inline exact visit: focus the verified mounted row, without a page navigation. */
  inlineTarget?:
    | Readonly<{ messageId: string; signal: AbortSignal }>
    | undefined;
  /** Draft context starts at the returned tail, never reads/writes canonical scroll. */
  transient?: boolean | undefined;
  /** False: viewing rows marks nothing read; the owner decides what was read. */
  marksRead?: boolean | undefined;
  navigation?: PageNavigation | undefined;
  onOpenThread?(
    messageId: string,
    threadRootId: string,
    intent?: "reply",
  ): void;
  onOpenMediaReview?(
    messageId: string,
    attachment: Attachment,
    seconds: number,
    hasComments?: boolean,
    initialAttachments?: readonly Attachment[],
  ): void;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ChannelTimeline(props: ChannelTimelineProps) {
  return (
    <Timeline
      key={
        props.continuityKey
          ? JSON.stringify([props.continuityKey, props.scope, props.channelId])
          : messageViewKey(props.queries, props.scope, props.channelId)
      }
      {...props}
    />
  );
}
function Timeline({
  channelId,
  extensions,
  scope,
  viewer,
  queries,
  window,
  launchPending,
  historyControl = "button",
  onOpenLink,
  canOpenLink,
  revealMessageId,
  inlineTarget,
  transient = false,
  marksRead = true,
  navigation,
  onOpenThread,
  onOpenMediaReview,
  chatPresentation = false,
  startsThreads = true,
  activityLane = false,
}: ChannelTimelineProps) {
  useMessageSelectionCopy();
  const [initialPosition] = useState(() =>
    transient
      ? null
      : readView<ReadingPosition | null>(scope, `scroll:${channelId}`, null),
  );
  const savedPosition = useRef(initialPosition);
  // Reload and quit never unmount: also save where scrolling settles. Only a
  // changed place is written; a following reader's own end scrolls are not.
  const written = useRef<string | undefined>(undefined);
  const savePosition = useCallback(() => {
    // A bottom place restores at the latest message; its row is noise.
    const place = savedPosition.current?.bottom
      ? { bottom: true }
      : savedPosition.current;
    const revision = JSON.stringify(place);
    if (transient || revision === written.current) return;
    if (writeView(scope, `scroll:${channelId}`, place))
      written.current = revision;
  }, [channelId, scope, transient]);
  const restoredAnchor = useRef<ReadingPosition["anchor"]>(undefined);
  // The intent under which a saved row absent from the loaded rows still waits
  // for them: the saved IndexedDB head precedes the network head and notice
  // rows. The reader follows the bottom meanwhile; their input retires it.
  const pendingRestore = useRef<number | undefined>(undefined);
  const profiles = useRowProfiles(queries.profiles, window.rows);
  const agentPubkeys = useKnownAgentPubkeys(queries, profiles);
  const visibleRows = useMemo(
    () =>
      chatPresentation
        ? withoutStartingAgents(
            window.rows,
            viewer,
            agentPubkeys,
            // Live trimming can drop the chat's start without restoring hasMore.
            !window.hasMore && !window.historyLimited,
          )
        : window.rows,
    [
      window.rows,
      window.hasMore,
      window.historyLimited,
      chatPresentation,
      viewer,
      agentPubkeys,
    ],
  );
  const rows = useMemo(() => membershipRows(visibleRows), [visibleRows]);
  const messageVisit = useMessageVisit(queries, channelId);
  const ownsMessageVisit = messageVisit !== undefined && messageVisit !== null;
  const [timelineVisit] = useState<object>(() => ({}));
  const visitToken = messageVisit?.token ?? timelineVisit;
  const retainedBoundary = visitBoundaries.get(visitToken);
  const retainedVisit =
    retainedBoundary?.baseline.session === queries &&
    retainedBoundary.baseline.scope === scope &&
    retainedBoundary.baseline.channelId === channelId
      ? retainedBoundary
      : undefined;
  const [newMessageBoundary, setNewMessageBoundary] =
    useState<NewMessageBoundary>(
      () =>
        retainedVisit?.boundary ?? {
          token: visitToken,
          session: queries,
          scope,
          channelId,
          captured: false,
        },
    );
  const boundaryMatchesVisit =
    newMessageBoundary.token === visitToken &&
    newMessageBoundary.session === queries &&
    newMessageBoundary.scope === scope &&
    newMessageBoundary.channelId === channelId;
  const boundaryPending = !boundaryMatchesVisit || !newMessageBoundary.captured;
  const unreadTarget = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribeUnread = useCallback(
    (listener: () => void) =>
      messageVisit?.active === true &&
      messageVisit?.failed === false &&
      boundaryPending
        ? queries.unread.subscribe(unreadTarget, listener)
        : () => {},
    [
      boundaryPending,
      messageVisit?.active,
      messageVisit?.failed,
      queries.unread,
      unreadTarget,
    ],
  );
  const getUnreadSnapshot = useCallback(
    () =>
      ownsMessageVisit ? queries.unread.snapshot(unreadTarget) : undefined,
    [ownsMessageVisit, queries.unread, unreadTarget],
  );
  const unreadSnapshot = useSyncExternalStore(
    subscribeUnread,
    getUnreadSnapshot,
    getUnreadSnapshot,
  );
  const [, setUnreadEvidenceRevision] = useState(0);
  const subscribeUnreadSync = useCallback(
    (listener: () => void) =>
      messageVisit?.active === true &&
      messageVisit?.failed === false &&
      boundaryPending
        ? queries.unread.subscribeSync(() => {
            listener();
            setUnreadEvidenceRevision((revision) => revision + 1);
          })
        : () => {},
    [
      boundaryPending,
      messageVisit?.active,
      messageVisit?.failed,
      queries.unread,
    ],
  );
  const getUnreadSync = useCallback(
    () => (ownsMessageVisit ? queries.unread.sync() : unknownUnreadSync),
    [ownsMessageVisit, queries.unread],
  );
  const unreadSync = useSyncExternalStore(
    subscribeUnreadSync,
    getUnreadSync,
    getUnreadSync,
  );
  const boundaryBaseline = useRef<NewMessageBoundaryBaseline | undefined>(
    retainedVisit?.baseline,
  );
  if (
    !boundaryBaseline.current ||
    boundaryBaseline.current.token !== visitToken ||
    boundaryBaseline.current.session !== queries ||
    boundaryBaseline.current.scope !== scope ||
    boundaryBaseline.current.channelId !== channelId
  )
    boundaryBaseline.current = retainedVisit?.baseline ?? {
      token: visitToken,
      session: queries,
      scope,
      channelId,
      ...(ownsMessageVisit && messageVisit?.active
        ? { revision: messageVisit.entryReadRevision }
        : {}),
      messageIds: messageVisit?.entryMessageIds ?? new Set(),
      attention: new Map(messageVisit?.entryAttention),
    };
  const baseline = boundaryBaseline.current;
  const entryAttention =
    boundaryPending &&
    ownsMessageVisit &&
    messageVisit?.active === true &&
    unreadSync.completeness === "snapshot"
      ? rows
          .filter(
            (row) =>
              !row.membership &&
              !row.huddle &&
              row.audience !== "agents" &&
              row.authorId !== queries.viewer,
          )
          .map((row) => ({
            row,
            attention: queries.unread.attention(channelId, row.id),
          }))
      : [];
  // An unread count without a loaded, classifiable row is not an exact boundary.
  const noUnreadEvidence =
    unreadSnapshot?.observedCount === 0 && unreadSnapshot?.attentionCount === 0;
  const boundaryCandidate = (() => {
    if (!boundaryPending || !ownsMessageVisit || messageVisit?.active !== true)
      return { ready: false };
    // Later paging cannot recover entry-time read evidence for unloaded rows.
    if (!messageVisit.entryHistoryComplete) return { ready: true };
    if (
      baseline.revision !== undefined &&
      queries.unread.revision() !== baseline.revision
    )
      return { ready: true };
    // Remote read merges do not advance the local intent revision. Once a
    // loaded row's read evidence is observed, later changes cannot redefine entry.
    // Null retains unresolved entry evidence rather than adopting its later state.
    if (
      entryAttention.some(({ row, attention }) => {
        const previous = baseline.attention.get(row.id);
        return (
          previous !== undefined &&
          attention.status !== "unknown" &&
          !attention.pending &&
          (previous === null ||
            previous.unread !== attention.unread ||
            previous.forced !== attention.forced)
        );
      })
    )
      return { ready: true };
    if (
      window.status !== "ready" ||
      window.freshness !== "verified" ||
      window.refreshing ||
      window.loadingOlder ||
      window.hasMore ||
      window.historyLimited ||
      unreadSync.completeness !== "snapshot"
    )
      return { ready: false };
    if (
      unreadSnapshot?.coverage !== "observed" ||
      unreadSnapshot?.freshness !== "observed"
    )
      return { ready: false };
    if (!rows.length) return { ready: noUnreadEvidence };
    for (const { row, attention } of entryAttention) {
      // Backdated live arrivals must neither define nor erase the entry boundary.
      if (!baseline.messageIds.has(row.id)) continue;
      if (attention.status === "unknown" || attention.pending)
        return { ready: false };
      // Ineligible means no attention category, not that an incoming row is read.
      if (attention.forced || attention.unread)
        return { ready: true, messageId: row.id };
    }
    return { ready: true };
  })();
  if (!boundaryMatchesVisit)
    setNewMessageBoundary(
      retainedVisit?.boundary ?? {
        token: visitToken,
        session: queries,
        scope,
        channelId,
        captured: false,
      },
    );
  else if (
    !newMessageBoundary.captured &&
    boundaryCandidate.ready &&
    messageVisit?.active === true &&
    messageVisit?.ready === true &&
    messageVisit?.failed === false
  )
    setNewMessageBoundary({
      token: visitToken,
      session: queries,
      scope,
      channelId,
      captured: true,
      ...(boundaryCandidate.messageId
        ? { messageId: boundaryCandidate.messageId }
        : {}),
    });
  useLayoutEffect(() => {
    if (!ownsMessageVisit || !boundaryMatchesVisit || !messageVisit?.active)
      return;
    for (const { row, attention } of entryAttention) {
      if (baseline.messageIds.has(row.id) && !baseline.attention.has(row.id))
        baseline.attention.set(
          row.id,
          attention.status === "unknown" || attention.pending
            ? null
            : { unread: attention.unread, forced: attention.forced },
        );
    }
    visitBoundaries.set(visitToken, { boundary: newMessageBoundary, baseline });
  }, [
    ownsMessageVisit,
    boundaryMatchesVisit,
    messageVisit?.active,
    entryAttention,
    baseline,
    visitToken,
    newMessageBoundary,
  ]);
  const newMessageBoundaryId =
    boundaryMatchesVisit &&
    newMessageBoundary.captured &&
    messageVisit?.active === true &&
    messageVisit?.ready === true &&
    messageVisit?.failed === false
      ? newMessageBoundary.messageId
      : undefined;
  const [expandedActivity, setExpandedActivity] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const activity = useMemo(
    () => (chatPresentation ? activityGroups(rows) : []),
    [rows, chatPresentation],
  );
  // Resolve a saved anchor once, before measuring initial geometry. A bottom
  // restore ignores it; absent/visible anchors must not expand on later loads.
  const [activityRestore, setActivityRestore] = useState(
    initialPosition?.bottom ? undefined : initialPosition?.anchor?.id,
  );
  if (activityRestore && rows.length > 0) {
    setActivityRestore(undefined);
    const older = activity
      .find((group) => group.ids.includes(activityRestore))
      ?.ids.slice(0, -RECENT_ACTIVITY_COUNT);
    if (older?.includes(activityRestore))
      setExpandedActivity((expanded) => new Set([...expanded, ...older]));
  }
  const disclosures = new Map(
    activity.map((group) => [
      group.ids[0],
      {
        ...group,
        expanded: group.ids
          .slice(0, -RECENT_ACTIVITY_COUNT)
          .some((id) => expandedActivity.has(id)),
      },
    ]),
  );
  const hiddenActivity = new Set(
    [...disclosures.values()].flatMap((group) =>
      group.expanded ? [] : group.ids.slice(0, -RECENT_ACTIVITY_COUNT),
    ),
  );
  const resolveName = useChannelIdentityNames(queries, channelId);
  const [geometry] = useState(() => geometryFor(queries.channels));
  const [focusedMessageId, setFocusedMessageId] = useState<string>();
  const [focusedActivityId, setFocusedActivityId] = useState<string>();
  // Holders are counted per row: a report notice and an image viewer can hold
  // the same row, and releasing one must not drop the other's pin.
  const [pinnedIds, setPinnedIds] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const keepRowMounted = useCallback((id: string) => {
    setPinnedIds((ids) => new Map(ids).set(id, (ids.get(id) ?? 0) + 1));
    return () =>
      setPinnedIds((ids) => {
        const next = new Map(ids);
        const count = (ids.get(id) ?? 0) - 1;
        if (count > 0) next.set(id, count);
        else next.delete(id);
        return next;
      });
  }, []);
  // Folding, stacking, and cached measurements share the same visibility.
  const foldedActivity = new Set(
    [...hiddenActivity].filter(
      (id) => id !== focusedMessageId && !pinnedIds.has(id),
    ),
  );
  const contentSignature = useMemo(
    () => geometrySignature(visibleRows, profiles, resolveName),
    [visibleRows, profiles, resolveName],
  );
  const signature = `${contentSignature}:${JSON.stringify([...foldedActivity].sort())}`;
  // Mount the saved boundary before restoration measures its divider inset.
  const keptIndices = rows.flatMap((row, index) =>
    row.id === focusedMessageId ||
    row.id === focusedActivityId ||
    pinnedIds.has(row.id) ||
    (row.id === newMessageBoundaryId &&
      !savedPosition.current?.bottom &&
      row.id === savedPosition.current?.anchor?.id)
      ? [index]
      : [],
  );
  const scroller = useRef<HTMLElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  useMessageSelection(scroller, rows, queries);
  // Keep pagination space through EOF so removing its control cannot change
  // Virtua's start margin in the same measurement cycle as a prepend.
  const [reserveHistorySpace, setReserveHistorySpace] = useState(false);
  if (
    !reserveHistorySpace &&
    (window.hasMore ||
      window.loadingOlder ||
      window.historyLimited ||
      window.error)
  )
    setReserveHistorySpace(true);
  const handle = useRef<VirtualizerHandle>(null);
  const [size, setSize] = useState({ width: 0, height: 0, edgeHeight: 0 });
  const width = size.width;
  const latest = useRef({ signature, width, edgeHeight: size.edgeHeight });
  latest.current = { signature, width, edgeHeight: size.edgeHeight };
  const initialCache = useRef<VirtualizerHandle["cache"] | undefined>(
    undefined,
  );
  const edges = useRef<{
    order: readonly string[];
    ids: ReadonlySet<string>;
    floor: number;
    paging: boolean;
  }>({ order: [], ids: new Set(), floor: 0, paging: false });
  // The reader's anchor row and its offset before this render's rows.
  const reader = useRef<{ id: string | undefined; top: number; y: number }>({
    id: undefined,
    top: 0,
    y: 0,
  });
  const intent = useRef(0);
  const heldReader = useRef<
    { id: string; y: number; intent: number } | undefined
  >(undefined);
  const previousBoundaryId = useRef<string | undefined>(undefined);
  const upwardGesture = useRef<false | "candidate" | "moving">(false);
  const gestureFrame = useRef<number | undefined>(undefined);
  const touchY = useRef<number | undefined>(undefined);
  const measuredPosition = useRef<{
    offset: number;
    height: number;
    width: number;
    viewport: number;
  } | null>(null);
  const olderDemand = useRef(false);
  const settled = useRef(false),
    userScrolled = useRef(false),
    follow = useRef(true);
  // Set when the timeline itself positions a following reader, until the next
  // reader input. Its own end alignment and Virtua's offset corrections can
  // scroll upward before rows re-measure; only reader input may cancel follow.
  const layoutCorrection = useRef(false);
  // A held pointer can drag the scrollbar without directional input events.
  const pointerHeld = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const recordPosition = useCallback(
    (element: HTMLElement, layoutOwned = false) => {
      // A delayed membership event can replace a group's rendered representative.
      // Keep the restored event anchored through that change until reader input.
      const anchor = restoredAnchor.current;
      const renderedAnchor = anchor
        ? rows.find(
            (row) =>
              row.id === anchor.id ||
              row.membershipRows?.some((member) => member.id === anchor.id),
          )?.id
        : undefined;
      const position = positionAt(element, renderedAnchor);
      // A removed saved row cannot keep a restoration alive once a visible row
      // replaces it. A temporarily unmounted row is still pending measurement.
      if (anchor && !renderedAnchor && position.anchor)
        restoredAnchor.current = undefined;
      // A settled standalone row no longer needs correction. Membership groups
      // retain the logical anchor even when their representative is in place.
      if (
        anchor &&
        position.anchor?.id === renderedAnchor &&
        position.anchor?.y === anchor.y &&
        element.scrollHeight - element.clientHeight - element.scrollTop > 1 &&
        !rows.some((row) =>
          row.membershipRows?.some((member) => member.id === anchor.id),
        )
      )
        restoredAnchor.current = undefined;
      // Virtua can emit the restoration scroll before mounting its visible
      // range. An anchorless observation must not erase the saved reading intent.
      // A reader gesture clears restoredAnchor before recording a new position.
      if (anchor && !position.anchor) return;
      // Cold estimates can leave too little height to reach the saved row/Y.
      // A bottom clamp with that row still below its target is restoration,
      // not reader intent. Reachable positions and new gestures remain free.
      if (
        anchor &&
        position.anchor &&
        position.anchor.id === renderedAnchor &&
        position.anchor.y > anchor.y + 1 &&
        element.scrollHeight - element.clientHeight - element.scrollTop <= 1
      )
        return;
      const previous = measuredPosition.current;
      // Reflow can move the offset twice: the browser clamps a shrinking list,
      // then Virtua corrects its measured rows. That combined movement can exceed
      // the height delta, so a contracting list is not evidence of reader input.
      // A measured list-height mutation or the timeline's own end alignment can
      // likewise move the offset upward; until reader input, only explicit
      // upward input may cancel follow.
      // Explicit upward input wins even when shrink and reader movement share
      // one observation. A link-opening click is not directional scroll intent.
      const movedUp =
        previous &&
        (upwardGesture.current ||
          (!layoutOwned &&
            element.clientWidth === previous.width &&
            element.clientHeight === previous.viewport &&
            element.scrollHeight >= previous.height)) &&
        element.scrollTop < previous.offset;
      // One smooth key scroll or scrollbar drag can cross several frames.
      // Keep observed upward movement until scrollend or a newer intent, even
      // when its first event has not left the near-bottom threshold yet.
      if (movedUp) upwardGesture.current = "moving";
      if (follow.current && !movedUp && (previous || !userScrolled.current))
        position.bottom = true;
      // Restoration can scroll before Virtua measures rows beneath the anchor,
      // briefly reaching the estimated bottom. Only reader input may follow.
      if (restoredAnchor.current) position.bottom = false;
      if (pendingRestore.current !== intent.current)
        savedPosition.current = position;
      follow.current = position.bottom;
      measuredPosition.current = {
        offset: element.scrollTop,
        height: element.scrollHeight,
        width: element.clientWidth,
        viewport: element.clientHeight,
      };
    },
    [rows],
  );
  const updateJumpToLatest = useCallback((element: HTMLElement) => {
    const bottom =
      element.scrollHeight - element.clientHeight - element.scrollTop < 80;
    setShowJumpToLatest(!bottom);
    if (bottom) setNewMessageCount(0);
  }, []);
  const jumpToLatest = useCallback(() => {
    if (!handle.current || !rows.length) return;
    intent.current++;
    follow.current = true;
    restoredAnchor.current = undefined;
    userScrolled.current = false;
    upwardGesture.current = false;
    scroller.current?.focus({ preventScroll: true });
    setShowJumpToLatest(false);
    setNewMessageCount(0);
    layoutCorrection.current = true;
    handle.current.scrollToIndex(rows.length - 1, {
      align: "end",
    });
  }, [rows.length]);
  const inlineSignal = inlineTarget?.signal;
  const targetId =
    inlineTarget?.messageId ??
    (navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined);
  const targetIndex = rows.findIndex((row) => row.id === targetId);
  // The reveal keeps its row in place through late measurement until any newer
  // intent: reader input, a send or Jump to latest.
  const targetIntent = useRef<number | undefined>(undefined);
  const holdTarget = useCallback(
    () => intent.current === targetIntent.current,
    [],
  );
  const prepareTarget = useCallback(() => {
    if (!handle.current) return;
    targetIntent.current = ++intent.current;
    follow.current = false;
    upwardGesture.current = false;
    restoredAnchor.current = undefined;
    settled.current = false;
    handle.current.scrollToIndex(targetIndex, { align: "center" });
  }, [targetIndex]);
  const targetPlaced = useCallback(() => {
    const list = handle.current;
    const element = scroller.current;
    if (!list || !element) return;
    // Replace the mounting request with the reveal's exact position. Retain
    // that same item-relative offset through Virtua's late measurements.
    list.scrollToIndex(targetIndex, {
      align: "start",
      offset:
        element.scrollTop -
        latest.current.edgeHeight -
        list.getItemOffset(targetIndex),
    });
  }, [targetIndex]);
  const targetSignal = inlineSignal ?? navigation?.signal;
  const activityReveal = useRef<AbortSignal | string | undefined>(undefined);
  useLayoutEffect(() => {
    const id = targetId ?? revealMessageId;
    const request = targetSignal ?? revealMessageId;
    if (!id || !request || request === activityReveal.current) return;
    if (!rows.some((row) => row.id === id)) return;
    activityReveal.current = request;
    const older = activity
      .find((group) => group.ids.includes(id))
      ?.ids.slice(0, -RECENT_ACTIVITY_COUNT);
    if (older?.includes(id) && foldedActivity.has(id))
      setExpandedActivity((expanded) => new Set([...expanded, ...older]));
  }, [activity, rows, targetId, targetSignal, revealMessageId, foldedActivity]);
  // Positioning waits for the exact reveal, then must run again: a reveal that
  // leaves the reader at the bottom keeps following late row measurement.
  const [revealedSignal, setRevealedSignal] = useState<AbortSignal>();
  const completeTarget = useCallback(() => {
    const element = scroller.current;
    // Only a reveal clamped at the scroll limit follows. A near-bottom reveal
    // keeps its row where it placed it instead of re-aligning to the end.
    if (
      element &&
      element.scrollHeight - element.clientHeight - element.scrollTop > 1
    )
      follow.current = false;
    navigation?.complete({ status: "opened" });
    setRevealedSignal(targetSignal);
  }, [navigation, targetSignal]);
  useMessageReveal({
    scroller,
    focus: !(
      navigation?.target.kind === "conversation" &&
      navigation.target.panel === "members"
    ),
    settled,
    messageId: targetId,
    signal: targetSignal,
    ready: !!size.width && !!size.height && targetIndex >= 0,
    prepare: prepareTarget,
    placed: targetPlaced,
    complete: completeTarget,
    hold: holdTarget,
  });
  // A pending saved row is the reader's place: following the latest message
  // until it loads is not catching up past it.
  const restoring = useCallback(
    () => pendingRestore.current === intent.current,
    [],
  );
  useReading({
    session: queries,
    channelId,
    scroller,
    settled,
    restoring,
    latestMessageId: window.rows
      .filter((row) => !row.membership && !row.huddle)
      .at(-1)?.id,
    enabled: marksRead,
  });
  // Shift keeps the distance from the end, so it holds the reader only while
  // the rows from their first visible item to the end are kept. Relay pages
  // break same-second ties by id, rows by send time: a page can land below the
  // first row, or around the reader, who is then scrolled back to their row.
  const previous = edges.current.order;
  const reading = previous.slice(
    handle.current?.findItemIndex(handle.current.scrollOffset) ?? 0,
  );
  const retained =
    heldReader.current?.intent === intent.current
      ? heldReader.current
      : undefined;
  const held = previous.indexOf(
    retained?.id ?? savedPosition.current?.anchor?.id ?? "",
  );
  reader.current = {
    id: previous[held],
    top: held < 0 ? 0 : (handle.current?.getItemOffset(held) ?? 0),
    y: retained?.y ?? savedPosition.current?.anchor?.y ?? 0,
  };
  const prepend =
    !!previous.length &&
    (previous[0] !== rows[0]?.id || rows.length !== previous.length) &&
    reading.every(
      (id, index) => rows[rows.length - reading.length + index]?.id === id,
    );
  // Without shift, rows landing above the reader push them down. Scroll by
  // that height before paint, so input that follows starts from the reader's
  // row. Rows that moved keep another row's size until they measure; hold the
  // reader's latest row through those measurements, until reader input that
  // follows them ends.
  useLayoutEffect(() => {
    const boundaryChanged = previousBoundaryId.current !== newMessageBoundaryId;
    previousBoundaryId.current = newMessageBoundaryId;
    const element = scroller.current;
    const list = element?.querySelector("ol");
    const index = rows.findIndex((row) => row.id === reader.current.id);
    if (index < 0) heldReader.current = undefined;
    if (
      prepend ||
      !settled.current ||
      follow.current ||
      index < 0 ||
      !element ||
      !list ||
      !handle.current
    )
      return;
    const moved = handle.current.getItemOffset(index) - reader.current.top;
    const id = reader.current.id;
    if (
      !id ||
      (!moved &&
        !boundaryChanged &&
        rows.length <= edges.current.order.length &&
        !(
          heldReader.current?.id === id &&
          heldReader.current.intent === intent.current
        ))
    )
      return;
    // New rows can leave the initial offset unchanged. Hold through their
    // measurements, but leave ordinary prepend follow-up renders to Virtua.
    const row = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(id)}"]`,
    );
    // A divider changes the anchor's inset inside its virtual item before
    // Virtua commits the new item height. Hold the same message through both.
    const delta =
      boundaryChanged && row
        ? row.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          reader.current.y
        : moved;
    // WebKit truncates fractional scrollTop writes; use the nearest pixel
    // when a caption's fractional line height changes the message inset.
    correctScrollTop(element, boundaryChanged ? Math.round(delta) : delta);
    // The row's offset from the viewport, as last placed by the reader.
    // A live append must not choose a newly inserted row while the older
    // page is still measuring; keep the reader's original row and offset.
    const anchor = { id, y: reader.current.y, intent: intent.current };
    heldReader.current = anchor;
    const top = () =>
      element
        .querySelector(`[data-message-id="${CSS.escape(anchor.id)}"]`)
        ?.getBoundingClientRect().top;
    const logicalTop = () => {
      const index = rows.findIndex((row) => row.id === anchor.id);
      const virtualizer = handle.current;
      return index < 0 || !virtualizer
        ? undefined
        : virtualizer.getItemOffset(index) - element.scrollTop;
    };
    let logical = logicalTop();
    let offset = element.scrollTop;
    // A drag can carry the reader away from that row, and Virtua unmounts
    // rows the reader leaves. Hold the row they read instead, or correcting
    // for the old one would move the rows in view.
    const read = () => {
      const position = positionAt(element, anchor.id).anchor;
      // Keep the ideal Y through integer scrollTop rounding; only a handover
      // adopts rendered geometry. Our own corrections contribute no user delta.
      if (position?.id === anchor.id) anchor.y += offset - element.scrollTop;
      else if (position) Object.assign(anchor, position);
      offset = element.scrollTop;
      logical = logicalTop();
    };
    let height = list.style.height;
    const since = intent.current;
    // Virtua re-observes moved rows in the next frame and, as patched, applies
    // their sizes in the frame after (patches/README.md), whether or not their
    // height changed. Input that ended before then releases the frame after.
    let measured = false;
    let ended = false;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        measured = true;
        if (ended) frame = requestAnimationFrame(() => release());
      });
    });
    const hold = new MutationObserver((mutations) => {
      // Ignore list-only pointer-events changes during input. A row's offsets
      // can change even when the sum of its siblings' heights does not.
      if (
        list.style.height === height &&
        !mutations.some((mutation) => mutation.target.parentNode === list)
      )
        return;
      height = list.style.height;
      const row = top();
      const next = logicalTop();
      if (settled.current && !follow.current) {
        let delta =
          row === undefined
            ? 0
            : row - element.getBoundingClientRect().top - anchor.y;
        // The range can evict the reader before the correction's scroll event.
        // Follow the same item's delta without mixing its inner DOM offset in.
        if (row === undefined && next !== undefined && logical !== undefined)
          delta = next - logical;
        correctScrollTop(element, boundaryChanged ? Math.round(delta) : delta);
      }
      offset = element.scrollTop;
      logical = logicalTop();
    });
    const release = (keepAnchor = false) => {
      if (!keepAnchor && heldReader.current === anchor)
        heldReader.current = undefined;
      cancelAnimationFrame(frame);
      hold.disconnect();
      element.removeEventListener("scroll", read);
      element.removeEventListener("scrollend", end);
      element.ownerDocument.removeEventListener("pointerup", done);
      element.ownerDocument.removeEventListener("pointercancel", done);
    };
    const done = () => {
      if (measured) release();
      else ended = true;
    };
    // A held pointer can drag across more moved rows; it ends when released.
    const end = () => {
      if (intent.current !== since && !pointerHeld.current) done();
    };
    // Row measurements can redistribute offsets without changing total height.
    hold.observe(list, {
      attributes: true,
      attributeFilter: ["style"],
      subtree: true,
    });
    element.addEventListener("scroll", read);
    element.addEventListener("scrollend", end);
    // A drag can end outside the scroller.
    element.ownerDocument.addEventListener("pointerup", done);
    element.ownerDocument.addEventListener("pointercancel", done);
    return () => release(true);
  }, [rows, prepend, newMessageBoundaryId]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measured = element.clientWidth;
    initialCache.current = geometry.get(
      channelId,
      latest.current.signature,
      measured,
    );
    let measuredSize = { width: 0, height: 0, edgeHeight: 0 };
    const measure = () => {
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        edgeHeight: edge.current?.getBoundingClientRect().height ?? 0,
      };
      if (
        next.width === measuredSize.width &&
        next.height === measuredSize.height &&
        next.edgeHeight === measuredSize.edgeHeight
      )
        return;
      // A growing composer shrinks the viewport. Pin a reader who was at the
      // bottom before paint so history rises with it; the restore lands later.
      if (
        follow.current &&
        settled.current &&
        next.height < measuredSize.height &&
        element.scrollHeight - measuredSize.height - element.scrollTop < 2
      )
        element.scrollTop = element.scrollHeight;
      measuredSize = next;
      settled.current = false;
      setSize(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (edge.current) observer.observe(edge.current);
    const page = element.ownerDocument.defaultView;
    page?.addEventListener("pagehide", savePosition);
    return () => {
      if (gestureFrame.current !== undefined)
        cancelAnimationFrame(gestureFrame.current);
      gestureFrame.current = undefined;
      upwardGesture.current = false;
      olderDemand.current = false;
      settled.current = false;
      page?.removeEventListener("pagehide", savePosition);
      savePosition();
      observer.disconnect();
      if (handle.current)
        geometry.set(
          channelId,
          latest.current.signature,
          latest.current.width,
          handle.current.cache,
        );
    };
    // Initial signature only; mutations invalidate the saved cache on remount.
  }, [channelId, geometry, savePosition]);
  // A reveal completes when its scroll runs. Until then it stays pending under
  // the intent that scheduled it: a row update that cancels its frame (an echo,
  // an edit, an older-history prepend) reschedules it, while any newer intent
  // (reader input, jump to latest, a message target) retires it for good.
  const revealed = useRef<string | undefined>(undefined);
  const pendingReveal = useRef<{ id: string; intent: number } | undefined>(
    undefined,
  );
  // A page lands in the commit that ends its load. Track loading apart from
  // positioning, which must not rerun when a load starts.
  const loadingOlder = useRef(false);
  useLayoutEffect(() => {
    loadingOlder.current = window.loadingOlder;
    if (window.loadingOlder) edges.current.paging = true;
  }, [window.loadingOlder]);
  useLayoutEffect(() => {
    if (
      pendingReveal.current &&
      pendingReveal.current.intent !== intent.current
    ) {
      revealed.current = pendingReveal.current.id;
      pendingReveal.current = undefined;
    }
    // Row updates include edits/reactions/replies, not only new message IDs.
    // Above-bottom reading and prepend anchoring remain Virtua's responsibility.
    const revealIndex =
      revealMessageId && revealed.current !== revealMessageId
        ? rows.findIndex(
            (row) =>
              row.id === revealMessageId ||
              row.membershipRows?.some(
                (member) => member.id === revealMessageId,
              ),
          )
        : -1;
    const previousIds = edges.current.ids;
    // Rows before the loaded first row's second are history. A page also
    // returns rows of that second, and can land after a retained first row:
    // when one lands, only rows after the previous last row are new.
    const { floor, order } = edges.current;
    const paged = edges.current.paging && !loadingOlder.current;
    const tail = rows.findIndex((row) => row.id === order.at(-1));
    const arrivals = rows.filter(
      (row, index) =>
        !previousIds.has(row.id) &&
        (!paged || index > tail) &&
        (row.createdAt > floor || (row.createdAt === floor && !paged)),
    ).length;
    edges.current = {
      order: rows.map((row) => row.id),
      ids: new Set(rows.map((row) => row.id)),
      floor: rows[0]?.createdAt ?? 0,
      paging: loadingOlder.current,
    };
    if (
      arrivals > 0 &&
      previousIds.size > 0 &&
      !follow.current &&
      (!targetId || revealedSignal === targetSignal)
    ) {
      setNewMessageCount((count) => count + arrivals);
    }
    if (
      (targetId && targetSignal && revealedSignal !== targetSignal) ||
      !size.width ||
      !size.height ||
      !rows.length ||
      (revealIndex < 0 &&
        settled.current &&
        (!follow.current ||
          (prepend && pendingRestore.current !== intent.current)))
    )
      return;
    // A send supersedes saved reading intent before the first scroll event.
    // This effect also retains its height observer through late measurements.
    if (revealIndex >= 0 && revealMessageId) {
      intent.current++;
      pendingReveal.current = { id: revealMessageId, intent: intent.current };
      follow.current = true;
      restoredAnchor.current = undefined;
      savedPosition.current = { bottom: true };
      measuredPosition.current = null;
      userScrolled.current = false;
      upwardGesture.current = false;
    }
    // virtua attaches its scroller in an effect; wait through the StrictMode probe.
    // A new gesture wins over restoration queued before that gesture.
    const scheduledIntent = intent.current;
    const saved =
      (!settled.current || pendingRestore.current === scheduledIntent) &&
      savedPosition.current &&
      !savedPosition.current.bottom
        ? savedPosition.current
        : null;
    const anchor = saved?.anchor;
    const restoreIndex = anchor
      ? renderedRowIndex(rows, visibleRows, anchor.id)
      : -1;
    // Only a loaded row is a place to return to. Until it loads, an opening
    // reader follows the latest message and the saved row stays pending; a
    // place without a row to wait for is forgotten. A placed reader stays put.
    const restore = restoreIndex >= 0 ? saved : null;
    if (saved && !restore && follow.current) {
      if (anchor) pendingRestore.current = scheduledIntent;
      else savedPosition.current = { bottom: true };
    }
    let observer: MutationObserver | undefined;
    const restorePosition = () => {
      if (intent.current !== scheduledIntent || !handle.current) return;
      const row = rows[restoreIndex];
      if (anchor && row) {
        pendingRestore.current = undefined;
        restoredAnchor.current = { id: row.id, y: anchor.y };
        const message =
          row.id === newMessageBoundaryId
            ? scroller.current?.querySelector<HTMLElement>(
                `[data-message-id="${CSS.escape(row.id)}"]`,
              )
            : undefined;
        const item = message?.closest("li");
        const inset =
          message && item
            ? message.getBoundingClientRect().top -
              item.getBoundingClientRect().top
            : 0;
        handle.current.scrollToIndex(restoreIndex, {
          align: "start",
          offset: inset - anchor.y,
        });
        follow.current = false;
      } else if (follow.current) {
        layoutCorrection.current = true;
        handle.current.scrollToIndex(
          revealIndex >= 0 ? revealIndex : rows.length - 1,
          { align: "end" },
        );
        if (revealIndex >= 0) {
          revealed.current = revealMessageId;
          pendingReveal.current = undefined;
        }
      }
    };
    let frame = requestAnimationFrame(() => {
      if (intent.current === scheduledIntent && handle.current) {
        // Input can move the DOM before its scroll event is delivered.
        if (!restore && scroller.current && measuredPosition.current)
          recordPosition(scroller.current);
        if (!restore && !follow.current) {
          settled.current = true;
          readingPositioned(scroller.current);
          return;
        }
        restorePosition();
        // Width changes can measure after Virtua's imperative-scroll scheduler
        // expires. Retain the same reading anchor (or bottom intent) through
        // those late measurements, never through a new reader gesture.
        const list = scroller.current?.querySelector("ol");
        if (list) {
          // Virtua measures children in ResizeObserver and synchronously writes
          // this parent height. Observing the parent box would create skipped
          // resize notifications; watch only Virtua's committed height instead.
          let height = list.style.height;
          observer = new MutationObserver(() => {
            if (list.style.height === height) return;
            height = list.style.height;
            // Capture a native clamp while its shrink is still observable.
            // Another append can grow the list before the queued scroll event.
            if (
              !restore &&
              measuredPosition.current &&
              intent.current === scheduledIntent &&
              scroller.current
            ) {
              recordPosition(scroller.current, true);
              layoutCorrection.current = true;
            }
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(restorePosition);
          });
          observer.observe(list, {
            attributes: true,
            attributeFilter: ["style"],
          });
        }
      }
      settled.current = true;
      readingPositioned(scroller.current);
      if (scroller.current) updateJumpToLatest(scroller.current);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      // A row refresh can arrive before the first deferred measurement or
      // cancel its correction. Keep restoration until newer reader input.
      if (restore && !follow.current && intent.current === scheduledIntent) {
        // Carry the original geometry with the resolved membership identity.
        savedPosition.current =
          restore.anchor && restoredAnchor.current
            ? {
                ...restore,
                anchor: { ...restore.anchor, id: restoredAnchor.current.id },
              }
            : restore;
        settled.current = false;
      }
    };
  }, [
    rows,
    visibleRows,
    size,
    prepend,
    recordPosition,
    targetId,
    targetSignal,
    revealedSignal,
    updateJumpToLatest,
    revealMessageId,
    newMessageBoundaryId,
  ]);
  // After positioning reads it: a load that ends without rows lands no page.
  useLayoutEffect(() => {
    if (!window.loadingOlder) edges.current.paging = false;
  }, [window.loadingOlder]);
  const loadNearTop = useCallback(
    (element: HTMLElement, resume = false) => {
      olderDemand.current = false;
      if (
        !handle.current ||
        !userScrolled.current ||
        window.status !== "ready" ||
        !window.hasMore ||
        window.historyLimited ||
        window.loadingOlder ||
        window.error ||
        element.scrollTop >= Math.max(3000, element.clientHeight * 4)
      )
        return;
      // Cached does not mean blocked: disconnected windows can still page over
      // HTTP. Try ordinary demand first, retaining only a blocked cached gesture.
      // A retained gesture waits for verification, not every cached row update.
      if (resume && window.freshness === "cached") {
        olderDemand.current = true;
        return;
      }
      queries.channels.loadOlder(channelId);
      const after = queries.channels.window(channelId);
      olderDemand.current =
        window.freshness === "cached" &&
        after.status === "ready" &&
        after.hasMore &&
        !after.loadingOlder &&
        !after.historyLimited &&
        !after.error;
    },
    [window, queries, channelId],
  );
  useLayoutEffect(() => {
    if (olderDemand.current && scroller.current)
      loadNearTop(scroller.current, true);
  }, [loadNearTop]);
  const gesture = (upward = false) => {
    const restoring = pendingRestore.current === intent.current;
    restoredAnchor.current = undefined;
    layoutCorrection.current = false;
    intent.current++;
    userScrolled.current = true;
    if (scroller.current) recordPosition(scroller.current);
    // Retiring a pending restore lets the bottom be caught up. Wake dwell: a
    // wheel or touch at the end cannot scroll, so nothing else would.
    if (restoring) readingPositioned(scroller.current);
    upwardGesture.current = upward ? "candidate" : false;
    if (gestureFrame.current !== undefined)
      cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = undefined;
    if (upward)
      gestureFrame.current = requestAnimationFrame(() => {
        gestureFrame.current = undefined;
        // Input is only a candidate: an inner scrollport can consume it without
        // moving history or emitting scrollend. Sample native movement before
        // retiring the candidate so input+shrink still wins in this observation,
        // even when the browser has not delivered its scroll event yet.
        if (upwardGesture.current && scroller.current)
          recordPosition(scroller.current);
        if (upwardGesture.current === "candidate")
          upwardGesture.current = false;
      });
    // At a restored top edge, input cannot move the DOM and emits no scroll.
    if (scroller.current && scroller.current.scrollTop <= 0)
      loadNearTop(scroller.current);
  };
  return (
    <section
      ref={scroller}
      data-message-scroller
      data-chat-presentation={chatPresentation || undefined}
      className={styles.feed}
      data-channel-timeline={channelId}
      data-buzz-launch-pending={launchPending ? "settling" : undefined}
      data-jump-visible={showJumpToLatest || undefined}
      onWheel={(event) => gesture(event.deltaY < 0 && !event.ctrlKey)}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY;
      }}
      onTouchMove={(event) => {
        const next = event.touches[0]?.clientY;
        gesture(
          next !== undefined &&
            touchY.current !== undefined &&
            next > touchY.current,
        );
        touchY.current = next;
      }}
      onKeyDown={(event) => {
        moveMessageSelection(event);
        gesture(scrollsHistoryUp(event));
      }}
      onPointerDown={() => {
        pointerHeld.current = true;
        // A press can end outside history.
        const document = scroller.current?.ownerDocument;
        const up = () => {
          pointerHeld.current = false;
          document?.removeEventListener("pointerup", up);
          document?.removeEventListener("pointercancel", up);
        };
        document?.addEventListener("pointerup", up);
        document?.addEventListener("pointercancel", up);
        gesture();
      }}
      onPointerUp={() => {
        pointerHeld.current = false;
      }}
      onPointerCancel={() => {
        pointerHeld.current = false;
      }}
      onScrollEnd={(event) => {
        // Virtual rows can finish measuring after the last scroll event,
        // especially at the top where reflow cannot change scrollTop.
        const element = event.currentTarget;
        if (
          settled.current &&
          element.clientWidth === size.width &&
          element.clientHeight === size.height
        )
          recordPosition(
            element,
            layoutCorrection.current && !pointerHeld.current,
          );
        upwardGesture.current = false;
        savePosition();
      }}
      onFocus={(event) => {
        setFocusedActivityId(
          event.target.closest<HTMLElement>("[data-activity-group-id]")?.dataset
            .activityGroupId,
        );
        setFocusedMessageId(
          event.target.closest<HTMLElement>("[data-message-id]")?.dataset
            .messageId,
        );
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusedMessageId(undefined);
          setFocusedActivityId(undefined);
        }
      }}
      tabIndex={0}
      aria-label="Channel message history"
      onScroll={(event) => {
        // React may receive this event before Virtua updates its handle metrics.
        const element = event.currentTarget;
        const v = handle.current;
        if (
          v &&
          settled.current &&
          element.clientWidth === size.width &&
          element.clientHeight === size.height
        ) {
          recordPosition(
            element,
            layoutCorrection.current && !pointerHeld.current,
          );
          updateJumpToLatest(element);
        }
        loadNearTop(element);
      }}
    >
      <div
        ref={edge}
        className={styles.edge}
        data-history-space={reserveHistorySpace || undefined}
      >
        {window.error && <span role="alert">{window.error}</span>}
        {window.historyLimited ? (
          <span>History window limit reached</span>
        ) : window.hasMore && (historyControl === "button" || window.error) ? (
          <Button
            type="button"
            disabled={window.loadingOlder}
            onClick={() => {
              queries.channels.loadOlder(channelId);
              const after = queries.channels.window(channelId);
              if (after.loadingOlder || after.error || after.status !== "ready")
                olderDemand.current = false;
            }}
          >
            {window.loadingOlder
              ? "Loading older…"
              : window.error
                ? "Retry older messages"
                : "Load older messages"}
          </Button>
        ) : window.loadingOlder ? (
          <span role="status">Loading older…</span>
        ) : null}
      </div>
      <JumpToLatestButton
        visible={showJumpToLatest}
        newMessageCount={newMessageCount}
        onClick={jumpToLatest}
        activityLane={
          activityLane ? { session: queries, channelId } : undefined
        }
      />
      {width > 0 && (
        <Virtualizer
          ref={handle}
          scrollRef={scroller}
          // Before Virtua measures its viewport there is no reading position
          // to preserve; shifting then can freeze its initial empty range.
          shift={prepend && !!handle.current?.viewportSize}
          bufferSize={1600}
          // Reflow must not evict the focused control or a row's open report.
          keepMounted={keptIndices}
          onResize={() => {
            const element = scroller.current;
            // Rows can measure after native scrollend without moving the
            // scroll offset. Do not carry their estimated Y into the next hold.
            if (
              element &&
              settled.current &&
              element.clientWidth === size.width &&
              element.clientHeight === size.height &&
              !follow.current &&
              !restoredAnchor.current &&
              pendingRestore.current !== intent.current &&
              heldReader.current?.intent !== intent.current
            )
              // A size change refreshes geometry, never bottom-follow intent.
              savedPosition.current = { ...positionAt(element), bottom: false };
          }}
          as="ol"
          item="li"
          startMargin={size.edgeHeight}
          {...(initialCache.current ? { cache: initialCache.current } : {})}
        >
          {rows.map((row, index) => {
            const disclosure = disclosures.get(row.id);
            const hidden = foldedActivity.has(row.id);
            const previousRow = rows[index - 1];
            const nextRow = rows[index + 1];
            const day =
              index === 0
                ? true
                : new Date(
                    (rows[index - 1]?.createdAt ?? 0) * 1000,
                  ).toDateString() !==
                  new Date(row.createdAt * 1000).toDateString();
            return (
              <Fragment key={row.id}>
                {disclosure && (
                  <div
                    className={styles.activityDisclosure}
                    data-activity-group-id={row.id}
                  >
                    {day && <DayDivider createdAt={row.createdAt} />}
                    <Button
                      variant="plain"
                      size="inline"
                      shape="control"
                      aria-expanded={disclosure.expanded}
                      onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        // Opening history is explicit reading intent, even at
                        // the bottom: new activity must not pull it away.
                        intent.current++;
                        follow.current = false;
                        userScrolled.current = true;
                        restoredAnchor.current = undefined;
                        const next = new Set(expandedActivity);
                        for (const id of disclosure.expanded
                          ? disclosure.ids
                          : disclosure.ids.slice(0, -RECENT_ACTIVITY_COUNT)) {
                          if (disclosure.expanded) next.delete(id);
                          else next.add(id);
                        }
                        setExpandedActivity(next);
                      }}
                    >
                      {disclosure.expanded
                        ? "Show fewer"
                        : `Show ${disclosure.ids.length - RECENT_ACTIVITY_COUNT} previous ${disclosure.ids.length - RECENT_ACTIVITY_COUNT === 1 ? "step" : "steps"}`}
                      <CaretDownIcon
                        className={styles.activityChevron}
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                )}
                {row.id === newMessageBoundaryId && (
                  <div
                    className={styles.newMessages}
                    data-new-messages-boundary
                  >
                    <hr
                      className="sr-only select-none"
                      aria-label="New messages"
                    />
                    <span className="select-none" aria-hidden="true">
                      New messages
                    </span>
                  </div>
                )}
                <ActivityExpansion
                  open={!hidden}
                  enabled={row.audience === "agents"}
                >
                  {row.membership ? (
                    <MembershipRow
                      resolveName={resolveName}
                      names={queries.names}
                      row={row}
                      profiles={profiles}
                      viewer={viewer}
                      media={queries.media}
                      agentPubkeys={agentPubkeys}
                      day={day}
                      onOpenLink={onOpenLink}
                      canOpenLink={canOpenLink}
                    />
                  ) : (
                    <MessageRow
                      stackPrevious={
                        !!previousRow &&
                        !foldedActivity.has(previousRow.id) &&
                        continuesMessageGroup(previousRow, row)
                      }
                      stackNext={
                        !!nextRow &&
                        !foldedActivity.has(nextRow.id) &&
                        continuesMessageGroup(row, nextRow)
                      }
                      session={queries}
                      scope={scope}
                      row={row}
                      unread={queries.unread}
                      extensions={extensions}
                      profile={profiles.get(row.authorId)}
                      participantProfiles={profiles}
                      agentPubkeys={agentPubkeys}
                      media={queries.media}
                      onOpenLink={onOpenLink}
                      canOpenLink={canOpenLink}
                      onOpenThread={onOpenThread}
                      startsThreads={startsThreads}
                      {...(onOpenMediaReview ? { onOpenMediaReview } : {})}
                      retry={queries.outbox?.retry}
                      keepMounted={keepRowMounted}
                      day={day && !disclosure}
                    />
                  )}
                </ActivityExpansion>
                {index === rows.length - 1 && (
                  <div className={styles.timelineEnd} aria-hidden="true" />
                )}
              </Fragment>
            );
          })}
        </Virtualizer>
      )}
      {!rows.length &&
        !window.hasMore &&
        window.status === "ready" &&
        !window.error &&
        !window.loadingOlder && (
          <div className={styles.emptyConversation}>
            <EmptyState
              icon={<ChatCircleIcon />}
              title="No messages yet."
              description={
                queries.channels.get?.(channelId)?.readOnly
                  ? undefined
                  : "Start the conversation below."
              }
            />
          </div>
        )}
    </section>
  );
}

import {
  BellIcon,
  BellSlashIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type MouseEvent,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { useAgentOwnerEvidence } from "../profiles/useAgentOwnerEvidence";
import type { ChannelMessage } from "../relay/contracts";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { MessageAttention } from "../relay/unread";
import type { AgentOwnerAuthorization } from "../relay/messages";
import type { OutgoingEvent } from "../relay/outbox";
import { MessageEditScope, useMessageEditScope } from "./MessageEditScope";
import { useAfterMessageMenuClose } from "./MessageActionBar";
import { lastEditableMessage } from "./useMessageEdit";
import styles from "./Messages.module.css";

// A channel tab and its thread can coexist, but unread state owns one visit.
const visits = new WeakMap<
  RelaySession,
  Map<string, { count: number; ready: Promise<void> }>
>();
function enterVisit(session: RelaySession, channelId: string) {
  let channels = visits.get(session);
  if (!channels) {
    channels = new Map();
    visits.set(session, channels);
  }
  let visit = channels.get(channelId);
  if (!visit) {
    visit = { count: 0, ready: session.unread.enterChannel(channelId) };
    channels.set(channelId, visit);
  }
  visit.count++;
  return {
    ready: visit.ready,
    leave() {
      if (--visit.count === 0) {
        channels.delete(channelId);
        session.unread.leaveChannel(channelId);
      }
    },
  };
}

const emptyOperations: readonly OutgoingEvent[] = Object.freeze([]);
const empty = () => emptyOperations;
const noop = () => () => {};
type Deletion = {
  row: ChannelMessage;
  authorization?: AgentOwnerAuthorization | undefined;
  done?: ((focus: boolean) => void) | undefined;
  focus?: (() => HTMLElement | null) | undefined;
};
const Management = createContext<
  | {
      remove(
        row: ChannelMessage,
        done?: (focus: boolean) => void,
        focus?: () => HTMLElement | null,
        authorization?: AgentOwnerAuthorization,
      ): void;
      report(error: string | undefined): void;
      operations: readonly OutgoingEvent[];
      session: RelaySession;
      channelId?: string | undefined;
    }
  | undefined
>(undefined);
type MessageVisit = Readonly<{
  session: RelaySession;
  channelId: string | undefined;
  token: object;
  entryMessageIds: ReadonlySet<string>;
  entryHistoryComplete: boolean;
  entryReadRevision: number;
  entryAttention: ReadonlyMap<
    string,
    Pick<MessageAttention, "unread" | "forced"> | null
  >;
  active: boolean;
  ready: boolean;
  failed: boolean;
}>;
const MessageVisitContext = createContext<MessageVisit | undefined>(undefined);

/** The channel visit that owns automatic reading and its entry reconciliation. */
export function useMessageVisit(
  session: RelaySession,
  channelId: string,
): MessageVisit | null | undefined {
  const visit = useContext(MessageVisitContext);
  if (!visit) return undefined;
  return visit.session === session && visit.channelId === channelId
    ? visit
    : null;
}

export function useMessageDeletion() {
  const management = useContext(Management);
  const editor = useMessageEditScope();
  return management
    ? (row: ChannelMessage, done?: (focus: boolean) => void) =>
        management.remove(row, done, () => editor?.focusTarget() ?? null)
    : undefined;
}

/**
 * Selected-message keys act as the message menu does, read when the key is
 * pressed. Delete covers your own messages; the menu also deletes for agent
 * owners, which needs ownership evidence a key cannot wait for.
 */
export function useMessageKeyActions(session: RelaySession) {
  const management = useContext(Management);
  const editor = useMessageEditScope();
  return useMemo(() => {
    if (!management) return undefined;
    const joined = (row: ChannelMessage) => {
      const channel = session.channels
        .list()
        .channels.find((item) => item.id === row.channelId);
      return channel &&
        !channel.cached &&
        (!channel.readOnly || channel.viewerRole === "guest") &&
        !row.membership &&
        !row.diff &&
        (!row.delivery || ["accepted", "seen"].includes(row.delivery))
        ? channel
        : undefined;
    };
    return {
      canDelete(row: ChannelMessage) {
        const channel = joined(row);
        return (
          !!channel &&
          !channel.readOnly &&
          !channel.archived &&
          !!session.viewer &&
          row.authorId === session.viewer &&
          !!session.outbox?.supports(5)
        );
      },
      remove(row: ChannelMessage) {
        management.remove(row, undefined, () => editor?.focusTarget() ?? null);
      },
      canMarkUnread(row: ChannelMessage) {
        if (!joined(row)) return false;
        const attention = session.unread.attention(row.channelId, row.id);
        return !attention.unread && !attention.forced;
      },
      markUnread(row: ChannelMessage) {
        management.report(undefined);
        void session.unread
          .markMessageUnread(row.channelId, row.id)
          .catch((cause) =>
            management.report(
              cause instanceof Error
                ? cause.message
                : "Could not update unread state. Try again.",
            ),
          );
      },
    };
  }, [management, editor, session]);
}

/** Recovery stays outside virtualized rows; each conversation has one edit destination. */
export function MessageManagement({
  session,
  channelId,
  active = true,
  children,
}: {
  session: RelaySession;
  channelId?: string | undefined;
  active?: boolean | undefined;
  children: ReactNode;
}) {
  const presented = useConversationPresentation();
  const [selection, setSelection] = useState<Deletion>();
  const completions = useRef(new Map<string, () => void>());
  if (!presented && selection) setSelection(undefined);
  const operations = useSyncExternalStore(
    session.outbox?.subscribe ?? noop,
    session.outbox?.snapshot ?? empty,
  );
  // Receipt/verified echo owns success; journal dismissal is not acceptance.
  useEffect(() => {
    const pending = completions.current;
    const stop = session.outbox?.observeSend((event) =>
      event.kind === 5
        ? () => {
            const done = pending.get(event.id);
            pending.delete(event.id);
            done?.();
          }
        : undefined,
    );
    return () => {
      stop?.();
      pending.clear();
    };
  }, [session]);
  useEffect(() => {
    for (const id of completions.current.keys())
      if (!operations.some((item) => item.event.id === id))
        completions.current.delete(id);
  }, [operations]);
  const deletable = useListedChannel(
    session.channels,
    selection?.row.channelId,
    (channel) =>
      !!channel &&
      !channel.cached &&
      (!channel.readOnly ||
        (channel.viewerRole === "guest" && !!selection?.authorization)),
  );
  const available =
    !selection ||
    ((!channelId || channelId === selection.row.channelId) &&
      (selection.row.delivery === "failed" || deletable));
  useEffect(() => {
    if (!available) setSelection(undefined);
  }, [available]);
  const visitChannelId = useListedChannel(
    session.channels,
    channelId,
    (channel) =>
      active &&
      channel &&
      !channel.cached &&
      session.viewer &&
      channel.members?.includes(session.viewer)
        ? channel.id
        : undefined,
  );
  // The timeline may mount only after loading or an inline seek completes.
  // Entry membership and provisional read evidence belong to this visit, not
  // to that later render or the first complete read snapshot.
  const captureVisit = () => {
    const window = channelId ? session.channels.window(channelId) : undefined;
    const rows = window?.rows ?? [];
    const entryAttention = new Map<
      string,
      Pick<MessageAttention, "unread" | "forced"> | null
    >();
    if (channelId)
      for (const row of rows) {
        const attention = session.unread.attention(channelId, row.id);
        entryAttention.set(
          row.id,
          attention.status === "unknown" || attention.pending
            ? null
            : { unread: attention.unread, forced: attention.forced },
        );
      }
    return {
      session,
      channelId,
      visitChannelId,
      entryMessageIds: new Set(rows.map((row) => row.id)),
      entryHistoryComplete:
        window?.status === "ready" &&
        window.freshness === "verified" &&
        !window.refreshing &&
        !window.loadingOlder &&
        !window.hasMore &&
        !window.historyLimited,
      entryReadRevision: session.unread.revision(),
      entryAttention,
    };
  };
  const [notice, setNotice] = useState<{
    visit: ReturnType<typeof captureVisit>;
    error?: string | undefined;
    entryReady: boolean;
    entryFailed: boolean;
  }>(() => ({
    visit: captureVisit(),
    entryReady: false,
    entryFailed: false,
  }));
  const { visit } = notice;
  const currentVisit =
    visit.session === session &&
    visit.channelId === channelId &&
    visit.visitChannelId === visitChannelId;
  if (!currentVisit)
    setNotice({
      visit: captureVisit(),
      error: undefined,
      entryReady: false,
      entryFailed: false,
    });
  // Captured reporters cannot overwrite errors from a later visit, even to
  // the same channel. Reset during render so stale alerts never reach children.
  // Consumers include every message row; a new value would re-render them all.
  const management = useMemo(
    () => ({
      session,
      channelId,
      operations,
      report: (error: string | undefined) =>
        setNotice((current) =>
          current.visit === visit ? { ...current, error } : current,
        ),
      remove(
        row: ChannelMessage,
        done?: (focus: boolean) => void,
        focus?: () => HTMLElement | null,
        authorization?: AgentOwnerAuthorization,
      ) {
        setSelection({ row, done, focus, authorization });
      },
    }),
    [session, channelId, operations, visit],
  );
  const messageVisit = useMemo(
    () => ({
      session: visit.session,
      channelId: visit.channelId,
      token: visit,
      entryMessageIds: visit.entryMessageIds,
      entryHistoryComplete: visit.entryHistoryComplete,
      entryReadRevision: visit.entryReadRevision,
      entryAttention: visit.entryAttention,
      active: !!visit.visitChannelId,
      ready: notice.visit === visit && notice.entryReady,
      failed: notice.visit === visit && notice.entryFailed,
    }),
    [visit, notice.visit, notice.entryReady, notice.entryFailed],
  );
  useEffect(() => {
    const { session, visitChannelId } = visit;
    let active = true;
    const presence = visitChannelId
      ? enterVisit(session, visitChannelId)
      : undefined;
    if (presence)
      void presence.ready.then(
        () => {
          if (active)
            setNotice((current) =>
              current.visit === visit
                ? { ...current, entryReady: true }
                : current,
            );
        },
        (cause) => {
          if (active)
            setNotice((current) =>
              current.visit === visit
                ? {
                    ...current,
                    entryReady: true,
                    entryFailed: true,
                    error:
                      cause instanceof Error
                        ? cause.message
                        : "Could not restore unread state.",
                  }
                : current,
            );
        },
      );
    else
      setNotice((current) =>
        current.visit === visit
          ? { ...current, entryReady: true, entryFailed: false }
          : current,
      );
    return () => {
      active = false;
      presence?.leave();
    };
  }, [visit]);
  return (
    <Management.Provider value={management}>
      <MessageVisitContext.Provider value={messageVisit}>
        <MessageEditScope>{children}</MessageEditScope>
      </MessageVisitContext.Provider>
      {currentVisit && notice.error && <p role="alert">{notice.error}</p>}
      {presented && selection && available && (
        <DeleteMessageDialog
          key={selection.row.id}
          session={session}
          selection={selection}
          operations={operations}
          dispatched={(id, dialog) => {
            const done = selection.done;
            if (done && !completions.current.has(id))
              completions.current.set(id, () =>
                done(
                  document.activeElement === document.body ||
                    !!selection.focus?.()?.contains(document.activeElement) ||
                    !!dialog?.contains(document.activeElement),
                ),
              );
          }}
          close={() => setSelection(undefined)}
        />
      )}
    </Management.Provider>
  );
}

/** Personal read/follow actions need current membership, not writing access. */
function useManagedMessage(row: ChannelMessage, session: RelaySession) {
  const management = useContext(Management);
  const joined = useListedChannel(
    session.channels,
    row.channelId,
    (channel) =>
      !!channel &&
      !channel.cached &&
      (!channel.readOnly || channel.viewerRole === "guest"),
  );
  return management &&
    joined &&
    !row.membership &&
    !row.diff &&
    (!row.delivery || ["accepted", "seen"].includes(row.delivery))
    ? management
    : undefined;
}

export function MessageReadStateItem({
  row,
  session,
}: {
  row: ChannelMessage;
  session: RelaySession;
}) {
  const management = useManagedMessage(row, session);
  const target = {
    kind: "message" as const,
    channelId: row.channelId,
    messageId: row.id,
  };
  useSyncExternalStore(
    (listener) => session.unread.subscribe(target, listener),
    () => session.unread.snapshot(target),
  );
  if (!management) return null;
  const attention = session.unread.attention(row.channelId, row.id);
  const unread = attention.unread || attention.forced;
  return (
    <MenuItem
      onClick={() => {
        management.report(undefined);
        void (
          unread
            ? session.unread.markMessageRead(row.channelId, row.id)
            : session.unread.markMessageUnread(row.channelId, row.id)
        ).catch((cause) =>
          management.report(
            cause instanceof Error
              ? cause.message
              : "Could not update unread state. Try again.",
          ),
        );
      }}
    >
      <MenuIcon>{unread ? <EnvelopeOpenIcon /> : <EnvelopeIcon />}</MenuIcon>
      {unread ? "Mark read" : "Mark unread"}
    </MenuItem>
  );
}

export function MessageManagementItems({
  row,
  session,
}: {
  row: ChannelMessage;
  session: RelaySession;
}) {
  return row.delivery === "failed" ? (
    <UnsentMessageItems row={row} session={session} />
  ) : (
    <ManagedMessageItems row={row} session={session} />
  );
}

/** The relay never stored a failed send, so Delete, which discards it from this
 * device, is its only item, and channel state does not gate it. */
function UnsentMessageItems({
  row,
  session,
}: {
  row: ChannelMessage;
  session: RelaySession;
}) {
  const management = useContext(Management);
  const editor = useMessageEditScope();
  const afterClose = useAfterMessageMenuClose();
  if (
    !management ||
    row.authorId !== session.viewer ||
    row.membership ||
    row.diff
  )
    return null;
  const remove = () =>
    management.remove(row, undefined, () => editor?.focusTarget() ?? null);
  return (
    <MenuItem onClick={() => (afterClose ? afterClose(remove) : remove())}>
      <MenuIcon>
        <TrashIcon size={14} />
      </MenuIcon>
      Delete message
    </MenuItem>
  );
}

function ManagedMessageItems({
  row,
  session,
}: {
  row: ChannelMessage;
  session: RelaySession;
}) {
  const management = useManagedMessage(row, session);
  const editor = useMessageEditScope();
  const afterClose = useAfterMessageMenuClose();
  const archived = useListedChannel(
    session.channels,
    row.channelId,
    (channel) => !!channel?.archived,
  );
  const dm = useListedChannel(
    session.channels,
    row.channelId,
    (channel) => channel?.channelType === "dm",
  );
  const writable = useListedChannel(
    session.channels,
    row.channelId,
    (channel) => !!channel && !channel.readOnly && !channel.cached,
  );
  const threadRootId = row.threadRootId ?? row.id;
  const following = useSyncExternalStore(session.unread.subscribeSync, () =>
    session.unread.following(row.channelId, threadRootId),
  );
  const ownership = useAgentOwnerEvidence(
    session,
    management && !archived && row.authorId !== session.viewer
      ? row.authorId
      : undefined,
  );
  if (!management) return null;
  const busy = management.operations.some(
    (item) =>
      ["sending", "accepted"].includes(item.delivery) &&
      [5, 40003].includes(item.event.kind) &&
      item.event.tags.some(([name, id]) => name === "e" && id === row.id),
  );
  const own = row.authorId === session.viewer && !archived;
  const canEdit =
    writable && own && editor?.current && lastEditableMessage(session, [row]);
  const authorization =
    row.authorId !== session.viewer &&
    session.viewer &&
    ownership.status === "ready" &&
    ownership.owner === session.viewer
      ? { agentId: row.authorId, ownerId: session.viewer }
      : undefined;
  const canDelete =
    ((writable && own) || !!authorization) && session.outbox?.supports(5);
  const act = (action: () => void) =>
    afterClose ? afterClose(action) : action();
  return (
    <>
      {canEdit && (
        <MenuItem
          disabled={
            busy ||
            management.operations.some(
              (item) =>
                item.event.kind === 5 &&
                item.event.tags.some(
                  ([name, id]) => name === "e" && id === row.id,
                ),
            )
          }
          onClick={() => act(() => editor.current?.(row))}
        >
          <MenuIcon>
            <PencilSimpleIcon size={14} />
          </MenuIcon>
          Edit message
        </MenuItem>
      )}
      {canDelete && (
        <MenuItem
          disabled={
            busy ||
            management.operations.some(
              (item) =>
                item.event.kind === 40003 &&
                item.event.tags.some(
                  ([name, id]) => name === "e" && id === row.id,
                ),
            )
          }
          onClick={() =>
            act(() =>
              management.remove(
                row,
                undefined,
                () => editor?.focusTarget() ?? null,
                authorization,
              ),
            )
          }
        >
          <MenuIcon>
            <TrashIcon size={14} />
          </MenuIcon>
          Delete message
        </MenuItem>
      )}
      {!dm && (
        <MenuItem
          onClick={() => {
            management.report(undefined);
            try {
              session.unread.follow(row.channelId, threadRootId, !following);
            } catch (cause) {
              management.report(
                cause instanceof Error
                  ? cause.message
                  : "Could not save thread follow. Try again.",
              );
            }
          }}
        >
          <MenuIcon>{following ? <BellSlashIcon /> : <BellIcon />}</MenuIcon>
          {following ? "Unfollow thread" : "Follow thread"}
        </MenuItem>
      )}
    </>
  );
}

function DeleteMessageDialog({
  session,
  selection,
  operations,
  dispatched,
  close,
}: {
  session: RelaySession;
  selection: Deletion;
  operations: readonly OutgoingEvent[];
  dispatched(id: string, dialog: Element | null): void;
  close(): void;
}) {
  const { row, authorization } = selection;
  const [operationId, setOperationId] = useState(
    () =>
      operations.find(
        (item) =>
          item.event.kind === 5 &&
          item.event.tags.some(([name, id]) => name === "e" && id === row.id),
      )?.event.id,
  );
  const cancelAction = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string>();
  // The relay never stored a failed send; deleting it discards the outbox intent.
  const unsent = row.delivery === "failed";
  const [discarding, setDiscarding] = useState(false);
  const operation = operations.find((item) => item.event.id === operationId);
  const pending = operation?.delivery === "sending" || discarding;
  const retryable =
    operation?.delivery === "failed" || operation?.delivery === "unknown";
  useEffect(() => {
    if (
      operationId &&
      (!operation ||
        operation.delivery === "seen" ||
        operation.delivery === "accepted")
    ) {
      close();
    }
  }, [operationId, operation, close]);
  const run = async (event: MouseEvent<HTMLButtonElement>) => {
    const dialog = event.currentTarget.closest('[role="alertdialog"]');
    setError(undefined);
    try {
      if (
        !unsent &&
        !session.channels
          .list()
          .channels.some(
            (channel) =>
              channel.id === row.channelId &&
              !channel.archived &&
              !channel.cached &&
              (!channel.readOnly ||
                (channel.viewerRole === "guest" && !!authorization)),
          )
      )
        throw new Error(
          "This conversation is no longer available for changes.",
        );
      if (unsent) {
        // dismiss() leaves a send that is retrying alone, without an error.
        if (
          !session.outbox
            ?.snapshot()
            .some(
              (item) => item.event.id === row.id && item.delivery === "failed",
            )
        )
          throw new Error(
            "This message’s delivery changed. Cancel to see its current status.",
          );
        setDiscarding(true);
        await session.outbox.dismiss(row.id);
        close();
      } else if (operationId) {
        session.outbox?.retry(operationId);
        dispatched(operationId, dialog);
      } else {
        const id = session.messages.remove([row.id], authorization);
        setOperationId(id);
        dispatched(id, dialog);
      }
    } catch (cause) {
      setDiscarding(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete this message. Try again.",
      );
    }
  };
  return (
    <AlertDialog
      title="Delete message?"
      initialFocus={cancelAction}
      description={
        unsent
          ? "This message wasn’t sent. Deleting it removes it from this device. This cannot be undone."
          : "This requests removal of this message from Buzz’s relay. People may still have copies. This cannot be undone."
      }
      pending={pending}
      finalFocus={() =>
        operationId || discarding ? (selection.focus?.() ?? true) : true
      }
      onClose={close}
      actions={
        <>
          <Button ref={cancelAction} disabled={pending} onClick={close}>
            {operationId ? "Close" : "Cancel"}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={run}>
            {pending ? "Deleting…" : retryable ? "Retry" : "Delete"}
          </Button>
        </>
      }
    >
      {(error || retryable) && (
        <p role="alert">
          {error ??
            operation?.error ??
            "Delivery could not be confirmed. Retry sends the same operation."}
        </p>
      )}
    </AlertDialog>
  );
}

/** Recovery survives a removed row, closed dialog, navigation and restored outbox. */
export function MessageManagementStatus() {
  const management = useContext(Management);
  const [error, setError] = useState<string>();
  if (!management) return null;
  const { session, channelId, operations } = management;
  const pending = operations.filter(
    (item) =>
      (item.event.kind === 40003 ||
        (item.event.kind === 5 &&
          item.event.tags.some(
            ([name, kind]) =>
              name === "k" && ["9", "40002"].includes(kind ?? ""),
          ))) &&
      item.event.tags.some(([name, id]) => name === "h" && id === channelId) &&
      ["failed", "unknown"].includes(item.delivery),
  );
  return (
    <>
      {pending.map((item) => (
        <div
          key={item.event.id}
          className={styles.messageActionNotice}
          role="status"
        >
          <p>
            {item.event.kind === 40003 ? "Message edit" : "Message deletion"}:{" "}
            {item.error ?? "Delivery could not be confirmed."}
          </p>
          {item.event.kind === 40003 && <p>{item.event.content}</p>}
          {item.delivery === "unknown" && (
            <p>
              This may already have reached the conversation. Retry sends the
              same operation; dismissing does not undo it.
            </p>
          )}
          <RetryMessageUpdate session={session} event={item.event} />
          <Button
            onClick={async () => {
              try {
                await session.outbox?.dismiss(item.event.id);
                setError(undefined);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not dismiss the operation.",
                );
              }
            }}
          >
            {item.delivery === "failed"
              ? "Discard failed update"
              : "Dismiss unconfirmed update"}
          </Button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </>
  );
}

function RetryMessageUpdate({
  session,
  event,
}: {
  session: RelaySession;
  event: OutgoingEvent["event"];
}) {
  const eligible = useSyncExternalStore(
    (listener) => {
      const offChannels = session.channels.subscribeList(listener);
      const offProfiles = session.profiles.subscribe(listener);
      return () => {
        offChannels();
        offProfiles();
      };
    },
    () => session.messages.canRetry(event),
  );
  return (
    <Button
      disabled={!eligible}
      onClick={() => session.outbox?.retry(event.id)}
    >
      Retry message update
    </Button>
  );
}

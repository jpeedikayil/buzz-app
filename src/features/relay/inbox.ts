import type { ReadTarget } from "./read-state-model";

/** A conversation projected from the unread owner's bounded verified evidence. */
export type InboxItem = Readonly<{
  id: string;
  channelId: string;
  target: ReadTarget;
  /** Oldest observed unread message, otherwise newest relevant message. */
  messageId: string;
  latestMessageId: string;
  /** Exact verified group members, for pending preview evidence across regrouping. */
  messageIds: readonly string[];
  rootId?: string;
  authorId: string;
  workflowOwnerId?: string | undefined;
  preview: string;
  /** The message the preview shows, which may be outside `messageIds`. */
  previewMessageId?: string;
  createdAt: number;
  mentioned: boolean;
  /** Verified group members with time and viewer-mention classification. */
  messages: readonly Readonly<{
    id: string;
    createdAt: number;
    mentioned: boolean;
  }>[];
  /** The same conversation projected from explicit mention evidence only. */
  mention?: InboxItem | undefined;
  thread: boolean;
  unreadCount: number;
  manual: boolean;
  /** Explicit prefixes; a thread prefix never acknowledges its top-level root. */
  readThrough: readonly Readonly<{ target: ReadTarget; messageId: string }>[];
}>;
export type InboxSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  items: readonly InboxItem[];
  /** `observing`: evidence is shown while a repair still reads the roster. */
  freshness: "unknown" | "observing" | "observed" | "stale";
  /** The last repair dropped some channel windows or thread reads after a
   * retry; those channels or threads stay as they were until the next
   * repair. */
  partial?: true;
  error?: string | undefined;
}>;

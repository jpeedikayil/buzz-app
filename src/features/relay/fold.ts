import { workflowOwner } from "./workflow-attribution";
import type { CustomEmoji } from "./emoji";
import { validatedBlurhash } from "./blurhash";
import { threadReference } from "./thread-reference";
import { agentAudience } from "./audience";
import { emojiTags } from "./emoji";
import { objectBody } from "./body";
import { huddleRoom } from "../huddle/lifecycle";
import { newer } from "./events";
import type { EventData } from "./events";
import {
  MAX_ATTACHMENT_DURATION_SECONDS,
  type Attachment,
  type ChannelMessage,
} from "./contracts";
import {
  IMETA_DIM,
  projectMarkdownAttachments,
  relayHashBasename,
  safeAttachmentName,
  safeMessageUrl,
} from "./message-content";

import { channelRowKind, membershipChange } from "./membership";
import { compareMessages, eventMs } from "./message-order";
const HEX64 = /^[0-9a-f]{64}$/;

function isLegacyVoiceNote(mime: string | undefined, name: string | undefined) {
  // Old Buzz uploads voice notes as video/mp4: a 16x16 H.264 black track plus AAC
  // because the relay video validator requires a video track; classify by filename convention.
  return (
    (mime === "video/mp4" || mime?.startsWith("video/mp4;") === true) &&
    name?.startsWith("voice-note-") === true &&
    name.endsWith(".mp4")
  );
}

function attachmentKind(
  fields: Record<string, string>,
  url: string,
  detectionName: string | undefined,
): Attachment["kind"] {
  const mime = fields.m?.toLowerCase();
  const voiceNoteName = detectionName?.toLowerCase();
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/") || isLegacyVoiceNote(mime, voiceNoteName))
    return "audio";
  if (mime?.startsWith("video/")) return "video";
  if (fields.m) return "file";
  if (/\.(mp4|webm)(?:\?|$)/i.test(url)) return "video";
  if (/\.(png|jpe?g|gif|webp|avif)(?:\?|$)/i.test(url)) return "image";
  return "file";
}

function attachmentName(url: string): string | undefined {
  const segment = new URL(url).pathname.split("/").pop();
  if (!segment) return undefined;
  try {
    const decoded = decodeURIComponent(segment);
    return !relayHashBasename(decoded)
      ? safeAttachmentName(decoded)
      : undefined;
  } catch {
    return !relayHashBasename(segment)
      ? safeAttachmentName(segment)
      : undefined;
  }
}

export function imetaAttachmentUrls(event: EventData): ReadonlySet<string> {
  const urls = new Set<string>();
  for (const entry of event.tags) {
    if (entry[0] !== "imeta") continue;
    const fields = Object.fromEntries(
      entry.slice(1).map((field) => {
        const split = field.indexOf(" ");
        return [field.slice(0, split), field.slice(split + 1)];
      }),
    );
    const url = fields.url ? safeMessageUrl(fields.url) : undefined;
    if (url) urls.add(url);
  }
  return urls;
}

export function parseAttachments(
  event: EventData,
  markdownImages: readonly string[],
  markdownLinkNames: ReadonlyMap<string, string> = new Map(),
): Attachment[] {
  const result: Attachment[] = [];
  const seen = new Set<string>();
  for (const entry of event.tags) {
    if (entry[0] !== "imeta") continue;
    const fields = Object.fromEntries(
      entry.slice(1).map((field) => {
        const split = field.indexOf(" ");
        return [field.slice(0, split), field.slice(split + 1)];
      }),
    );
    const url = fields.url ? safeMessageUrl(fields.url) : undefined;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // Treat signed metadata as untrusted layout input. Invalid/missing dimensions
    // use the renderer's stable fallback rather than image-load-driven geometry.
    const dim = IMETA_DIM.exec(fields.dim ?? "");
    const width = Number(dim?.[1]),
      height = Number(dim?.[2]);
    const blurhash = validatedBlurhash(fields.blurhash);
    const previewUrl =
      fields.image || fields.thumb
        ? safeMessageUrl(fields.image ?? fields.thumb ?? "")
        : undefined;
    const parsedSize = /^[1-9]\d*$/.test(fields.size ?? "")
      ? Number(fields.size)
      : undefined;
    // Treat signed metadata as untrusted layout input. Invalid/unbounded duration
    // uses a stable unknown-duration fallback.
    const parsedDuration = /^\d+(?:\.\d+)?$/.test(fields.duration ?? "")
      ? Number(fields.duration)
      : undefined;
    const duration =
      parsedDuration !== undefined &&
      parsedDuration > 0 &&
      parsedDuration <= MAX_ATTACHMENT_DURATION_SECONDS
        ? parsedDuration
        : undefined;
    const filename = fields.filename
      ? safeAttachmentName(fields.filename)
      : undefined;
    const basename = attachmentName(url);
    const name = markdownLinkNames.get(url) ?? filename ?? basename;
    const detectionName = filename ?? markdownLinkNames.get(url) ?? basename;
    const kind = attachmentKind(fields, url, detectionName);
    result.push({
      url,
      kind,
      ...(fields.m ? { mime: fields.m } : {}),
      ...(parsedSize !== undefined && Number.isSafeInteger(parsedSize)
        ? { size: parsedSize }
        : {}),
      ...(name ? { name } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(kind === "audio" &&
      detectionName?.toLowerCase().startsWith("voice-note-")
        ? { voiceNote: true as const }
        : {}),
      ...(() => {
        const waveform = fields.waveform?.trim().split(/\s+/).map(Number);
        return waveform?.length &&
          waveform.length <= 100 &&
          waveform.every((n) => Number.isInteger(n) && n >= 0 && n <= 100)
          ? { waveform }
          : {};
      })(),
      ...(blurhash ? { blurhash } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      ...(width > 0 && height > 0 ? { dimensions: { width, height } } : {}),
    });
  }
  for (const url of markdownImages) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (/\.(mp4|webm)(?:\?|$)/i.test(url)) result.push({ url, kind: "video" });
    else result.push({ url, kind: "image" });
  }
  return result;
}

function parseSummary(
  event: EventData | undefined,
): Pick<ChannelMessage, "replyCount" | "participants"> {
  if (!event) return { replyCount: 0, participants: Object.freeze([]) };
  try {
    const body = objectBody(event.content);
    if (!body) return { replyCount: 0, participants: Object.freeze([]) };
    const replyCount =
      typeof body.descendant_count === "number" &&
      Number.isInteger(body.descendant_count) &&
      body.descendant_count >= 0
        ? body.descendant_count
        : typeof body.reply_count === "number" &&
            Number.isInteger(body.reply_count) &&
            body.reply_count >= 0
          ? body.reply_count
          : 0;
    const participants = Array.isArray(body.participants)
      ? body.participants.filter(
          (value): value is string =>
            typeof value === "string" && HEX64.test(value),
        )
      : [];
    return {
      replyCount,
      participants: Object.freeze([...new Set(participants)]),
    };
  } catch {
    return { replyCount: 0, participants: Object.freeze([]) };
  }
}

/** Base Buzz's displayed author: output signed by the relay's explicit NIP-11
 * `self` names its author in `actor`, else a leading `p` on channel events.
 * Any other signer, including a contact-key fallback, is the author. */
export function messageAuthor(
  event: EventData,
  signingAuthority: string | undefined,
) {
  if (!signingAuthority || event.pubkey !== signingAuthority)
    return event.pubkey;
  const actor = event.tags.find(
    ([name, value]) => name === "actor" && HEX64.test(value ?? ""),
  )?.[1];
  if (actor) return actor;
  const [name, value] = event.tags[0] ?? [];
  return name === "p" &&
    value &&
    HEX64.test(value) &&
    event.tags.some(([tag]) => tag === "h")
    ? value
    : event.pubkey;
}

/** A relay-verified NIP-09 that passed the relay's author/agent-owner check
 * removes its target. Keep this predicate shared by timeline and unread evidence.
 * Attributed owner deletion applies only to message kinds; reactions retain
 * ordinary raw-author deletion semantics. */
export function deletionApplies(
  deletion: EventData,
  event: EventData,
  signingAuthority: string | undefined,
) {
  const messageKind = [9, 40002].includes(event.kind);
  const nip09 = deletion.kind === 5 || deletion.kind === 9005;
  return (
    (nip09 && deletion.pubkey === event.pubkey) ||
    (nip09 &&
      messageKind &&
      deletion.pubkey === messageAuthor(event, signingAuthority)) ||
    (deletion.kind === 5 &&
      messageKind &&
      deletion.tags.some(
        ([name, value]) => name === "k" && value === String(event.kind),
      ))
  );
}

/** Folds one window's top-level messages with their aux overlays: author deletes (5/9005),
 * author edits (40003, latest wins), reactions (7) and relay-signed thread summaries (39005).
 * Replies stay out of the top level; when they are not rows, the non-deleted `pendingReplies`
 * of a root layer on top of its summary: they add to `replyCount` and their authors lead
 * `participants`, so an own reply counts and shows before the relay's summary round trip.
 * Output is ascending by time; ties break on id so windows merge deterministically. */
export function foldMessages(
  channelId: string,
  relayAuthor: string,
  events: readonly EventData[],
  {
    includeReplies = false,
    collapseHuddles = true,
    signingAuthority,
    agentOwner,
    pendingReplies,
  }: {
    includeReplies?: boolean;
    collapseHuddles?: boolean;
    signingAuthority?: string | undefined;
    agentOwner?: ((pubkey: string) => string | undefined) | undefined;
    /** Retained reply sends of this client's that no relay summary has counted yet
     * (MessageProjection decides that by observation order); absent means every
     * summary is complete. */
    pendingReplies?: ReadonlySet<string> | undefined;
  } = {},
): ChannelMessage[] {
  const overlays = new Map<string, EventData[]>();
  const summaries = new Map<string, EventData>();
  const replies = new Map<string, EventData[]>();
  for (const event of events) {
    if (channelRowKind(event.kind)) {
      // Most folds pass no pending replies; skip parsing their references.
      const rootId = pendingReplies?.has(event.id)
        ? threadReference(event)?.rootId
        : undefined;
      if (
        rootId &&
        event.tags.some((entry) => entry[0] === "h" && entry[1] === channelId)
      ) {
        const list = replies.get(rootId) ?? [];
        list.push(event);
        replies.set(rootId, list);
      }
      continue;
    }
    if (event.kind === 39005) {
      const target = event.tags.find((entry) => entry[0] === "e")?.[1];
      if (target && event.pubkey === relayAuthor)
        summaries.set(target, newer(summaries.get(target), event));
      continue;
    }
    for (const entry of event.tags) {
      if (entry[0] !== "e" || !entry[1]) continue;
      const list = overlays.get(entry[1]) ?? [];
      list.push(event);
      overlays.set(entry[1], list);
    }
  }
  // Relay-signed author attribution and NIP-09 owner deletion are both
  // independently verified before these events enter the fold. Only the
  // message target kinds gain the owner path; reactions remain author-only.
  const byAuthor = (item: EventData, event: EventData) =>
    item.pubkey === event.pubkey ||
    item.pubkey === messageAuthor(event, signingAuthority) ||
    ([9, 40002].includes(event.kind) &&
      item.tags.some((entry) => entry[0] === "h" && entry[1] === channelId) &&
      item.pubkey === agentOwner?.(messageAuthor(event, signingAuthority)));
  const deleted = (event: EventData) =>
    overlays
      .get(event.id)
      ?.some((item) => deletionApplies(item, event, signingAuthority)) ?? false;
  const rows: ChannelMessage[] = [];
  for (const event of events) {
    if (!channelRowKind(event.kind)) continue;
    if (!event.tags.some((entry) => entry[0] === "h" && entry[1] === channelId))
      continue;
    if (
      !includeReplies &&
      event.tags.some((entry) => entry[0] === "e" && entry[3] === "reply") &&
      !event.tags.some((entry) => entry[0] === "broadcast" && entry[1] === "1")
    )
      continue;
    const aux = overlays.get(event.id) ?? [];
    if (deleted(event)) continue;
    if (event.kind === 48100 || event.kind === 48103) {
      const room = huddleRoom(event);
      if (!room || room === channelId) continue;
      // End authority is checked with matching starts when cards are collapsed.
      rows.push(
        Object.freeze({
          id: event.id,
          channelId,
          authorId: event.pubkey,
          createdAt: event.created_at,
          content: event.kind === 48100 ? "Huddle started" : "Huddle ended",
          huddle: {
            room,
            state:
              event.kind === 48100 ? ("started" as const) : ("ended" as const),
          },
          mentions: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
          participants: [],
        }),
      );
      continue;
    }
    if (event.kind === 40099) {
      const membership = membershipChange(event, relayAuthor);
      if (membership)
        rows.push(
          Object.freeze({
            id: event.id,
            channelId,
            authorId: event.pubkey,
            createdAt: event.created_at,
            createdAtMs: eventMs(event),
            content: "",
            membership,
            mentions: Object.freeze([]),
            attachments: Object.freeze([]),
            reactions: Object.freeze([]),
            replyCount: 0,
            participants: Object.freeze([]),
          }),
        );
      continue;
    }
    const edits = aux
      .filter(
        (item) =>
          item.kind === 40003 && byAuthor(item, event) && !deleted(item),
      )
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    let content = edits[0]?.content ?? event.content;
    if (event.kind === 40002) {
      const body = objectBody(content);
      if (typeof body?.content === "string") content = body.content;
    }
    const attachmentEvent =
      edits.find((edit) => edit.tags.some(([name]) => name === "imeta")) ??
      event;
    const imetaUrls = imetaAttachmentUrls(attachmentEvent);
    // Every CommonMark image begins with `![`, and every attachment title link
    // needs an imeta URL match; avoid parsing ordinary messages.
    const projected =
      event.kind !== 40008 && (content.includes("![") || imetaUrls.size)
        ? projectMarkdownAttachments(content, imetaUrls)
        : {
            content,
            seams: Object.freeze([] as number[]),
            urls: Object.freeze([] as string[]),
            names: Object.freeze([]),
          };
    const attachmentNames = new Map<string, string>();
    for (const { url, name } of projected.names)
      if (!attachmentNames.has(url)) attachmentNames.set(url, name);
    const authorId = messageAuthor(event, signingAuthority);
    const summary = parseSummary(summaries.get(event.id));
    const pending = includeReplies
      ? []
      : (replies.get(event.id)?.filter((reply) => !deleted(reply)) ?? []);
    // The relay lists participants by signer, so a pending reply whose signer
    // it lists but not its author (a relay-signed workflow reply) leads as that
    // signer rather than adding a second identity.
    const repliers = pending.map((reply) => {
      const author = messageAuthor(reply, signingAuthority);
      return !summary.participants.includes(author) &&
        summary.participants.includes(reply.pubkey)
        ? reply.pubkey
        : author;
    });
    rows.push(
      Object.freeze({
        id: event.id,
        channelId,
        threadRootId: threadReference(event)?.rootId,
        replyParentId: threadReference(event)?.parentId,
        sentFromThread: (() => {
          const tag = event.tags.find(
            ([name, id]) =>
              name === "buzz:sent-from-thread" && id && HEX64.test(id),
          );
          return tag?.[1]
            ? {
                rootId: tag[1],
                excerpt: tag[2]
                  ? Array.from(tag[2]).slice(0, 64).join("")
                  : undefined,
              }
            : undefined;
        })(),
        authorId,
        ...(authorId !== event.pubkey ? { signerId: event.pubkey } : {}),
        workflowOwnerId: workflowOwner(event, signingAuthority),
        createdAt: event.created_at,
        createdAtMs: eventMs(event),
        content: projected.content,
        ...(projected.content !== content ? { sourceContent: content } : {}),
        ...(event.kind === 40002 ? { agentEnvelope: true as const } : {}),
        ...(agentAudience(event) ? { audience: "agents" as const } : {}),
        ...(event.kind === 40008
          ? {
              diff: Object.freeze({
                filePath: event.tags.find(([name]) => name === "file")?.[1],
                repoUrl: event.tags.find(([name]) => name === "repo")?.[1],
                commitSha: event.tags.find(([name]) => name === "commit")?.[1],
                description: event.tags.find(
                  ([name]) => name === "description",
                )?.[1],
                truncated: event.tags.some(
                  ([name, value]) => name === "truncated" && value === "true",
                ),
              }),
            }
          : {}),
        ...(edits.length ? { edited: true as const } : {}),
        ...(projected.seams.length ? { attachmentSeams: projected.seams } : {}),
        mentionReferences: Object.freeze([
          ...new Set(
            event.tags.flatMap((tag) =>
              tag.length === 2 &&
              tag[0] === "mention" &&
              tag[1] &&
              HEX64.test(tag[1])
                ? [tag[1]]
                : [],
            ),
          ),
        ]),
        mentions: Object.freeze([
          ...new Set(
            event.tags.flatMap(([name, value]) =>
              name === "p" && value && HEX64.test(value) ? [value] : [],
            ),
          ),
        ]),
        ...(attachmentEvent !== event
          ? { attachmentSourceId: attachmentEvent.id }
          : {}),
        attachments: Object.freeze(
          parseAttachments(attachmentEvent, projected.urls, attachmentNames),
        ),
        emoji: emojiTags(
          edits[0]?.tags.some(([name]) => name === "emoji") ? edits[0] : event,
        ),
        reactions: groupReactions(
          aux.filter((item) => item.kind === 7),
          deleted,
        ),
        replyCount: summary.replyCount + pending.length,
        // Pending repliers lead, returning ones included, so they stay within
        // the visible avatar stack.
        participants: Object.freeze([
          ...new Set([...repliers, ...summary.participants]),
        ]),
      }),
    );
  }
  return (collapseHuddles ? collapseHuddleCards(rows, relayAuthor) : rows).sort(
    compareMessages,
  );
}

/** Count people, but retain event IDs for author-only removal and duplicate cleanup. */
export function groupReactions(
  events: readonly EventData[],
  deleted: (event: EventData) => boolean = () => false,
) {
  const groups = new Map<
    string,
    {
      content: string;
      emoji?: CustomEmoji;
      events: { id: string; authorId: string }[];
      firstAt: number;
      firstId: string;
    }
  >();
  for (const event of events) {
    const emoji = emojiTags(event).find(
      (entry) => event.content.toLowerCase() === `:${entry.shortcode}:`,
    );
    const content = emoji ? `:${emoji.shortcode}:` : event.content;
    const key = JSON.stringify([content, emoji?.url]);
    const group = groups.get(key) ?? {
      content,
      ...(emoji ? { emoji } : {}),
      events: [],
      firstAt: event.created_at,
      firstId: event.id,
    };
    if (
      event.created_at < group.firstAt ||
      (event.created_at === group.firstAt && event.id < group.firstId)
    ) {
      group.firstAt = event.created_at;
      group.firstId = event.id;
    }
    if (!deleted(event) && !group.events.some((entry) => entry.id === event.id))
      group.events.push(
        Object.freeze({ id: event.id, authorId: event.pubkey }),
      );
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.values()]
      .filter((group) => group.events.length > 0)
      .sort(
        (a, b) => a.firstAt - b.firstAt || a.firstId.localeCompare(b.firstId),
      )
      .map(({ content, emoji, events }) =>
        Object.freeze({
          content,
          ...(emoji ? { emoji } : {}),
          events: Object.freeze(events),
        }),
      ),
  );
}

/** Keep the start ID stable without discarding its retained authoritative end. */
export function collapseHuddleCards(
  rows: ChannelMessage[],
  relayAuthor: string,
): ChannelMessage[] {
  const key = (row: ChannelMessage) => `${row.channelId}:${row.huddle?.room}`;
  const starts = new Map<string, ChannelMessage>();
  for (const row of rows) {
    if (row.huddle?.state !== "started") continue;
    const previous = starts.get(key(row));
    if (
      !previous ||
      row.createdAt < previous.createdAt ||
      (row.createdAt === previous.createdAt && row.id < previous.id)
    )
      starts.set(key(row), row);
  }
  const authorized = rows.filter((row) => {
    if (row.huddle?.state !== "ended" || row.authorId === relayAuthor)
      return true;
    const start = starts.get(key(row));
    return start?.authorId === row.authorId && start.createdAt <= row.createdAt;
  });
  if (!starts.size) return authorized;
  const ends = new Map<string, number>();
  for (const row of authorized) {
    if (row.huddle?.state === "ended")
      ends.set(key(row), Math.max(ends.get(key(row)) ?? 0, row.createdAt));
  }
  return authorized.flatMap((row) => {
    if (row.huddle?.state === "ended" && starts.has(key(row))) return [];
    if (row.huddle?.state === "started" && starts.get(key(row)) !== row)
      return [];
    const endedAt = ends.get(key(row));
    return row.huddle?.state === "started" &&
      endedAt !== undefined &&
      endedAt >= row.createdAt
      ? [Object.freeze({ ...row, huddle: { ...row.huddle, endedAt } })]
      : [row];
  });
}

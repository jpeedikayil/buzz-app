import type { ReadFilter } from "./events";

/** Content kinds the unread owner observes: messages, agent posts and files. */
export const UNREAD_CONTENT_KINDS: readonly number[] = [9, 40002, 40008];
/** Filters per unread repair request: every joined channel's window, the
 * viewer's authored page and the viewer's thread reads ride together, so the
 * repair costs one or two round trips instead of one per four channels. */
export const UNREAD_WINDOW_BATCH = 128;

const HEX_64 = /^[0-9a-f]{64}$/;
const CHANNEL_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const hexes = (value: unknown, most: number) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= most &&
  value.every((id) => typeof id === "string" && HEX_64.test(id));
const keysAre = (filter: object, names: readonly string[]) => {
  const keys = Object.keys(filter);
  return keys.length === names.length && names.every((n) => keys.includes(n));
};

/** An unread repair request, exempt from the four-filters-per-read rule the
 * reader and hosts otherwise enforce: up to UNREAD_WINDOW_BATCH content-kind
 * filters with `include_aux`, each one of the repair's shapes — a channel
 * window (`#h` of one channel, `since`), the viewer's authored page
 * (`authors` of one key, at most once, `since` the last walk or none), a
 * thread read (`#h` of one channel and up to 100 `#e` roots, whole or
 * `since` the threads' newest time) or a fetch of up to 100 `ids` with the
 * same `limit`. The relay honours each filter's own limit, which keeps the
 * events one request returns bounded. */
export function isUnreadWindowBatch(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > UNREAD_WINDOW_BATCH
  )
    return false;
  const windows = new Set<string>();
  let authored = false;
  return value.every((filter: Partial<ReadFilter> | null) => {
    if (
      !filter ||
      typeof filter !== "object" ||
      !Array.isArray(filter.kinds) ||
      filter.kinds.length !== UNREAD_CONTENT_KINDS.length ||
      !UNREAD_CONTENT_KINDS.every((kind) => filter.kinds?.includes(kind)) ||
      filter.include_aux !== true ||
      !Number.isInteger(filter.limit) ||
      (filter.limit as number) < 1 ||
      (filter.limit as number) > 500
    )
      return false;
    const channel = filter["#h"];
    const channelled =
      Array.isArray(channel) &&
      channel.length === 1 &&
      typeof channel[0] === "string" &&
      CHANNEL_ID.test(channel[0]);
    const since =
      filter.since === undefined ||
      (Number.isInteger(filter.since) && filter.since >= 0);
    const shape = (names: readonly string[]) =>
      keysAre(filter, names) ||
      (filter.since !== undefined && keysAre(filter, [...names, "since"]));
    if (keysAre(filter, ["kinds", "#h", "since", "include_aux", "limit"])) {
      if (
        !channelled ||
        filter.since === undefined ||
        !since ||
        windows.has(channel[0])
      )
        return false;
      windows.add(channel[0]);
      return true;
    }
    if (shape(["kinds", "authors", "include_aux", "limit"])) {
      if (authored || !hexes(filter.authors, 1) || !since) return false;
      authored = true;
      return true;
    }
    if (shape(["kinds", "#h", "#e", "include_aux", "limit"]))
      return channelled && hexes(filter["#e"], 100) && since;
    if (keysAre(filter, ["kinds", "ids", "include_aux", "limit"]))
      return hexes(filter.ids, 100) && filter.limit === filter.ids?.length;
    return false;
  });
}

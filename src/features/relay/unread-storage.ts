import { byteSize, listByteSize } from "./budget";
import type { RelayEvent } from "./events";
import {
  THREAD_PARTICIPATION_LIMIT,
  type ThreadMark,
  type ThreadParticipation,
} from "./thread-participation";

/** What the Inbox keeps on this device between launches, per relay and
 * viewer: the threads the viewer is part of and signed evidence. A record is
 * read whole or not at all, so nothing starts from part of one. Events are
 * signed wire records; read back from storage they are untrusted until the
 * owner re-verifies them, and one that fails discards them. `structure`
 * names the events kept only to group replies (roots and parents a lookup
 * fetched), which never count. `complete` says the events hold everything
 * the next warm repair would read. `mark` is the newest relay time the last
 * catch-up that read every chunk of the roster returned, with when this
 * device confirmed it, in its own clock's seconds; `roster` names the
 * channels that mark covers, each read since this device saw it joined, so
 * one outside it is read once before the mark vouches for it; `whole` names
 * remembered threads read whole, whose later replies the mark's reads bring;
 * `through` names remembered threads whose replies up to the mark this device
 * read, so a full repair from the mark reads only their replies since it;
 * `absent` names roots the relay returned nothing for when asked by ID, so a
 * deleted root does not leave the record incomplete. */
export type UnreadRecord<Event = RelayEvent> = Readonly<{
  participation: ThreadParticipation;
  events: readonly Event[];
  structure: ReadonlySet<string>;
  complete: boolean;
  mark?: UnreadMark;
  roster?: ReadonlySet<string>;
  whole?: ReadonlySet<string>;
  through?: ReadonlySet<string>;
  absent?: ReadonlySet<string>;
}>;
export type UnreadMark = Readonly<{ at: number; checked: number }>;
/** A save refused because the partition was purged during this storage's
 * session: nothing the session holds may be saved back. */
export class UnreadRecordPurged extends Error {
  constructor() {
    super("Unread record was purged by another window");
  }
}
export type UnreadStorage = Readonly<{
  /** The saved record, or undefined when none is saved or it is unusable. */
  read(): Promise<UnreadRecord<unknown> | undefined>;
  /** Replaces the record: its events become exactly those given. A record
   * beyond the bounds is refused and the saved one kept, as is any record
   * once the partition was purged during this storage's session
   * (`UnreadRecordPurged`). */
  save(record: UnreadRecord): Promise<void>;
  close(): void;
}>;

/** What one launch re-verifies, and half the in-memory evidence budget. */
export const UNREAD_RECORD_EVENTS = 2048;
export const UNREAD_RECORD_BYTES = 4 * 1024 * 1024;
/** Far beyond any roster seen. */
const ROSTER_LIMIT = 4096;
const VERSION = 1;

type StoredMeta = {
  version: typeof VERSION;
  participation: {
    roots: ([string, number] | [string, number, string])[];
    walk?: { since: number };
  };
  structure?: string[];
  complete?: boolean;
  mark?: { at: number; checked: number };
  roster?: string[];
  whole?: string[];
  through?: string[];
  absent?: string[];
  /** The partition's last purge, kept by every record written after it. */
  purged?: string;
};

const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
function parseRoot(entry: unknown): [string, ThreadMark] | undefined {
  if (!Array.isArray(entry) || entry.length < 2 || entry.length > 3) return;
  const [key, at, newestId] = entry as unknown[];
  if (typeof key !== "string" || key.length > 256 || !time(at)) return;
  if (newestId === undefined) return [key, { at }];
  if (typeof newestId === "string" && newestId.length <= 64)
    return [key, { at, newestId }];
}
function parseMark(raw: unknown): UnreadMark | undefined {
  const { at, checked } = (raw ?? {}) as { at?: unknown; checked?: unknown };
  return time(at) && time(checked) ? { at, checked } : undefined;
}
const ids = (raw: unknown, bound: number, length = 64): raw is string[] =>
  Array.isArray(raw) &&
  raw.length <= bound &&
  raw.every((id) => typeof id === "string" && id.length <= length);
/** Storage is untrusted: a meta of another version or any malformed part of
 * its participation, or events beyond the bounds, read as no record. Fields
 * added later under this version read leniently instead, a missing or
 * malformed one as incomplete, so a record from an older build keeps its
 * threads and only owes a full repair (a missing or malformed `mark`,
 * `whole`, `through` or `absent` reads as none); without `structure` no event can be
 * told apart from structure, so none is restored. Event validity is left to
 * the owner's re-verification. */
function parse(
  raw: unknown,
  events: readonly unknown[],
): UnreadRecord<unknown> | undefined {
  if (!raw || typeof raw !== "object") return;
  const meta = raw as { version?: unknown; participation?: unknown };
  if (meta.version !== VERSION) return;
  if (!meta.participation || typeof meta.participation !== "object") return;
  const { roots, walk } = meta.participation as {
    roots?: unknown;
    walk?: unknown;
  };
  if (!Array.isArray(roots) || roots.length > THREAD_PARTICIPATION_LIMIT)
    return;
  const marks = new Map<string, ThreadMark>();
  for (const entry of roots) {
    const root = parseRoot(entry);
    if (!root) return;
    marks.set(...root);
  }
  const since = (walk as { since?: unknown } | null | undefined)?.since;
  if (walk !== undefined && !time(since)) return;
  if (events.length > UNREAD_RECORD_EVENTS) return;
  try {
    if (byteSize(events) > UNREAD_RECORD_BYTES) return;
  } catch {
    return;
  }
  const { structure, complete, roster, whole, through, absent } = raw as {
    structure?: unknown;
    complete?: unknown;
    roster?: unknown;
    whole?: unknown;
    through?: unknown;
    absent?: unknown;
  };
  const known = ids(structure, UNREAD_RECORD_EVENTS);
  const covered = ids(roster, ROSTER_LIMIT, 128);
  const mark = parseMark((raw as { mark?: unknown }).mark);
  return {
    participation: time(since)
      ? { roots: marks, walk: { since } }
      : { roots: marks },
    events: known ? events : [],
    structure: new Set(known ? structure : []),
    complete: known && covered && complete === true,
    ...(mark ? { mark } : {}),
    ...(covered && roster.length ? { roster: new Set(roster) } : {}),
    ...(ids(whole, THREAD_PARTICIPATION_LIMIT, 256) && whole.length
      ? { whole: new Set(whole) }
      : {}),
    ...(ids(through, THREAD_PARTICIPATION_LIMIT, 256) && through.length
      ? { through: new Set(through) }
      : {}),
    ...(ids(absent, THREAD_PARTICIPATION_LIMIT) && absent.length
      ? { absent: new Set(absent) }
      : {}),
  };
}
const purgeOf = (raw: unknown) => {
  const purged = (raw as { purged?: unknown } | null | undefined)?.purged;
  return typeof purged === "string" ? purged : undefined;
};
/** When a purge was made: it is written as `time:token`. */
const purgedAt = (purge: string) => Number(purge.split(":", 1)[0]);
/** The stored meta, refusing a record that would not read back. */
function stored({
  participation,
  events,
  structure,
  complete,
  mark,
  roster,
  whole,
  through,
  absent,
}: UnreadRecord): StoredMeta {
  const meta: StoredMeta = {
    version: VERSION,
    participation: {
      roots: [...participation.roots].map(([key, { at, newestId }]) =>
        newestId === undefined ? [key, at] : [key, at, newestId],
      ),
      ...(participation.walk
        ? { walk: { since: participation.walk.since } }
        : {}),
    },
    structure: [...structure],
    complete,
    ...(mark ? { mark: { at: mark.at, checked: mark.checked } } : {}),
    roster: [...(roster ?? [])],
    ...(whole?.size ? { whole: [...whole] } : {}),
    ...(through?.size ? { through: [...through] } : {}),
    ...(absent?.size ? { absent: [...absent] } : {}),
  };
  if (
    events.length > UNREAD_RECORD_EVENTS ||
    listByteSize(events) > UNREAD_RECORD_BYTES ||
    !parse(meta, [])
  )
    throw new RangeError("Unread record exceeds its storage bounds");
  return meta;
}

export function memoryUnreadStorage(): UnreadStorage {
  let saved: UnreadRecord | undefined;
  return {
    read: async () => saved,
    save: async (record) => {
      stored(record);
      const { roots, walk } = record.participation;
      saved = {
        participation: { roots: new Map(roots), ...(walk ? { walk } : {}) },
        events: [...record.events],
        structure: new Set(record.structure),
        complete: record.complete,
        ...(record.mark ? { mark: { ...record.mark } } : {}),
        ...(record.roster?.size ? { roster: new Set(record.roster) } : {}),
        ...(record.whole?.size ? { whole: new Set(record.whole) } : {}),
        ...(record.through?.size ? { through: new Set(record.through) } : {}),
        ...(record.absent?.size ? { absent: new Set(record.absent) } : {}),
      };
    },
    close() {},
  };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-unread-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("meta");
      request.result
        .createObjectStore("events", { keyPath: ["scope", "id"] })
        .createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to open saved unread state"));
  });
}
function settle(
  tx: IDBTransaction,
  resolve: () => void,
  reject: (cause: unknown) => void,
) {
  tx.oncomplete = () => resolve();
  tx.onabort = () =>
    reject(tx.error ?? new Error("Unread storage transaction aborted"));
  tx.onerror = () => reject(tx.error);
}
/** Device-local and partitioned by relay and viewer, like read state: one
 * meta entry per partition, and its events keyed by partition and ID so a
 * save writes only what changed. A sibling database rather than more stores
 * in `buzz-read-state-v1`, so neither owner's schema version gates the other.
 *
 * Leaving a community purges its partition while another window may still
 * hold a session for it, until that window reloads. Its saves would bring
 * the left community's evidence back, so each storage keeps the purge it
 * first finds, by read or save, and refuses to save over a later one; a
 * session started after the purge, such as one for rejoining, saves as usual.
 * A purge it first finds that is newer than the storage itself was made
 * during its session, and refuses its saves too, so a first read that failed
 * neither holds an earlier purge against it nor lets it save over a later
 * one. A host without IndexedDB keeps nothing: a read finds no record, and a
 * save has nothing to write. */
export function browserUnreadStorage(scope: string): UnreadStorage {
  const created = Date.now();
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  let read = false;
  let purged: string | undefined;
  let refused = false;
  function first(found: string | undefined) {
    if (read) return;
    read = true;
    purged = found;
    refused = found !== undefined && purgedAt(found) > created;
  }
  function open() {
    if (closed) return Promise.reject(new Error("Unread storage closed"));
    // A failed open is not held against the next read or save.
    database ??= openDatabase().catch((cause: unknown) => {
      database = undefined;
      throw cause;
    });
    return database;
  }
  return {
    async read() {
      if (typeof indexedDB === "undefined") return undefined;
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(["meta", "events"], "readonly");
        const meta = tx.objectStore("meta").get(scope);
        // One past the bound is enough to refuse the record.
        const rows = tx
          .objectStore("events")
          .index("scope")
          .getAll(IDBKeyRange.only(scope), UNREAD_RECORD_EVENTS + 1);
        settle(
          tx,
          () => {
            first(purgeOf(meta.result));
            resolve(
              parse(
                meta.result,
                rows.result.map((row: { event?: unknown }) => row?.event),
              ),
            );
          },
          reject,
        );
      });
    },
    /** One transaction over both stores reads which events the partition
     * holds, puts the missing ones, deletes the rest and writes the meta, so
     * saves from two windows leave exactly the last writer's record. */
    async save(record) {
      const meta = stored(record);
      if (typeof indexedDB === "undefined") return;
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(["meta", "events"], "readwrite");
        const events = tx.objectStore("events");
        const selected = new Map(
          record.events.map((event) => [event.id, event]),
        );
        const current = tx.objectStore("meta").get(scope);
        const keys = events.index("scope").getAllKeys(IDBKeyRange.only(scope));
        // Requests succeed in order, so the meta has been read by now.
        keys.onsuccess = () => {
          first(purgeOf(current.result));
          if (refused || purgeOf(current.result) !== purged)
            return reject(new UnreadRecordPurged());
          const held = new Set<string>();
          for (const key of keys.result) {
            const id = (key as [string, string])[1];
            if (selected.has(id)) held.add(id);
            else events.delete(key);
          }
          for (const [id, event] of selected)
            if (!held.has(id)) events.put({ scope, id, event });
          tx.objectStore("meta").put(
            purged === undefined ? meta : { ...meta, purged },
            scope,
          );
        };
        settle(tx, resolve, reject);
      });
    },
    close() {
      closed = true;
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
/** Forgets one partition's record once the viewer has left that community,
 * leaving only a mark of the purge that reads as no record. */
export async function purgeUnreadStorage(scope: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["meta", "events"], "readwrite");
      const events = tx.objectStore("events");
      const keys = events.index("scope").getAllKeys(IDBKeyRange.only(scope));
      keys.onsuccess = () => {
        for (const key of keys.result) events.delete(key);
      };
      tx.objectStore("meta").put(
        { version: VERSION, purged: `${Date.now()}:${crypto.randomUUID()}` },
        scope,
      );
      settle(tx, resolve, reject);
    });
  } finally {
    db.close();
  }
}

/** The newest message time seen in a thread and, when known, the ID of the
 * newest reply seen at that time: a read since the time is inclusive, and
 * the reply with that ID is the one already seen. */
export type ThreadMark = Readonly<{ at: number; newestId?: string }>;
/** Threads the viewer is part of, keyed `channel:root` with the newest
 * message seen in each: written or replied in, mentioned in, or explicitly
 * followed. Unread reads these threads on every repair so a participated
 * thread stays in the Inbox after the per-channel windows and the viewer's
 * own recent messages no longer reach it. `walk` is the newest time of the
 * viewer's authored messages a repair has read through: the first repair on
 * a device walks the viewer's whole authored history to learn their threads,
 * later ones read only what was authored since. */
export type ThreadParticipation = Readonly<{
  roots: ReadonlyMap<string, ThreadMark>;
  walk?: Readonly<{ since: number }>;
}>;
export type ThreadParticipationStorage = Readonly<{
  read(): Promise<ThreadParticipation>;
  write(participation: ThreadParticipation): Promise<void>;
  close(): void;
}>;

/** Newest threads win, as the reference desktop seeds 1,000 activity rows
 * per identity and relay. Only the newest few are reread whole each repair;
 * the rest are asked for replies since their newest time, so the cap bounds
 * the filters a repair sends, not its events. */
export const THREAD_PARTICIPATION_LIMIT = 1000;

export const NO_THREAD_PARTICIPATION: ThreadParticipation = {
  roots: new Map(),
};

export function memoryThreadParticipation(): ThreadParticipationStorage {
  let saved = NO_THREAD_PARTICIPATION;
  return {
    read: async () => saved,
    write: async ({ roots, walk }) => {
      saved = { roots: new Map(roots), ...(walk ? { walk } : {}) };
    },
    close() {},
  };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-thread-participation-v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("partitions");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(
        new Error("Close other Buzz windows to open thread participation"),
      );
  });
}
/** Storage is untrusted: anything but a bounded list of `[key, time,
 * newestId?]` entries reads as nothing remembered, anything but an event ID
 * as no newest reply known, and anything but a time as no walk. The record
 * was the bare list before it carried the walk, and its entries `[key, time]`
 * pairs before they carried the newest reply; both forms still read. */
function parse(raw: unknown): ThreadParticipation {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { roots?: unknown; walk?: { since?: unknown } })
      : { roots: raw };
  const roots = new Map(
    (Array.isArray(record.roots) ? record.roots : [])
      .filter(
        (entry): entry is [string, number, unknown?] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          entry[0].length <= 256 &&
          Number.isSafeInteger(entry[1]) &&
          entry[1] >= 0,
      )
      .slice(0, THREAD_PARTICIPATION_LIMIT)
      .map(([key, at, newestId]): [string, ThreadMark] => [
        key,
        typeof newestId === "string" && newestId.length <= 64
          ? { at, newestId }
          : { at },
      ]),
  );
  const since = record.walk?.since;
  return Number.isSafeInteger(since) && (since as number) >= 0
    ? { roots, walk: { since: since as number } }
    : { roots };
}
/** Device-local and partitioned by relay and viewer, like read state. A
 * sibling database rather than a second store in `buzz-read-state-v1`, so
 * neither owner's schema version gates the other. */
export function browserThreadParticipation(
  scope: string,
): ThreadParticipationStorage {
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  function open() {
    if (closed)
      return Promise.reject(new Error("Thread participation storage closed"));
    // A failed open is not held against the next read or write.
    database ??= openDatabase().catch((cause: unknown) => {
      database = undefined;
      throw cause;
    });
    return database;
  }
  return {
    async read() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db
          .transaction("partitions", "readonly")
          .objectStore("partitions")
          .get(scope);
        request.onsuccess = () => resolve(parse(request.result));
        request.onerror = () => reject(request.error);
      });
    },
    async write({ roots, walk }) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("partitions", "readwrite");
        tx.objectStore("partitions").put(
          {
            roots: [...roots]
              .slice(0, THREAD_PARTICIPATION_LIMIT)
              .map(([key, { at, newestId }]) =>
                newestId === undefined ? [key, at] : [key, at, newestId],
              ),
            ...(walk ? { walk: { since: walk.since } } : {}),
          },
          scope,
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(tx.error ?? new Error("Thread participation save aborted"));
        tx.onerror = () => reject(tx.error);
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
/** Forgets one partition's threads once the viewer has left that community. */
export async function purgeThreadParticipation(scope: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("partitions", "readwrite");
      tx.objectStore("partitions").delete(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("Thread participation purge aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

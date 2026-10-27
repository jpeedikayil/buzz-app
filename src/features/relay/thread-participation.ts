/** Threads the viewer is part of, keyed `channel:root` with the newest
 * message time seen in each: written or replied in, mentioned in, or
 * explicitly followed. Unread refetches these threads on every repair so a
 * participated thread stays in the Inbox after the per-channel windows and
 * the viewer's own recent messages no longer reach it. */
export type ThreadParticipation = ReadonlyMap<string, number>;
export type ThreadParticipationStorage = Readonly<{
  read(): Promise<ThreadParticipation>;
  write(roots: ThreadParticipation): Promise<void>;
  close(): void;
}>;

/** Newest threads win, as the reference desktop keeps 100 activity rows per
 * identity and relay. Each remembered root costs one `#e` read per repair,
 * grouped by channel, so the cap also bounds repair. */
export const THREAD_PARTICIPATION_LIMIT = 100;

export function memoryThreadParticipation(): ThreadParticipationStorage {
  let saved: ThreadParticipation = new Map();
  return {
    read: async () => saved,
    write: async (roots) => {
      saved = new Map(roots);
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
/** Storage is untrusted: anything but a bounded list of `[key, time]` pairs
 * reads as nothing remembered. */
function parse(raw: unknown): ThreadParticipation {
  if (!Array.isArray(raw)) return new Map();
  return new Map(
    raw
      .filter(
        (entry): entry is [string, number] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          entry[0].length <= 256 &&
          Number.isSafeInteger(entry[1]) &&
          entry[1] >= 0,
      )
      .slice(0, THREAD_PARTICIPATION_LIMIT),
  );
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
    database ??= openDatabase();
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
    async write(roots) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("partitions", "readwrite");
        tx.objectStore("partitions").put(
          [...roots].slice(0, THREAD_PARTICIPATION_LIMIT),
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

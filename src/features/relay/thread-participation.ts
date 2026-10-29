/** The newest time of a reply the viewer wrote or read in a thread (or of
 * its root) and, when known, the ID of the newest reply at that time: a read
 * since the time is inclusive, and the reply with that ID is the one already
 * read. An unread reply advances neither, so it is read again until read; a
 * reply marked unread below the time moves it back to itself, and a thread
 * or root marked unread holds it at the root. */
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
/** Newest threads win, as the reference desktop seeds 1,000 activity rows
 * per identity and relay. Only the newest few are reread whole each repair;
 * the rest are asked for replies since their newest time, so the cap bounds
 * the filters a repair sends, not its events. */
export const THREAD_PARTICIPATION_LIMIT = 1000;

export const NO_THREAD_PARTICIPATION: ThreadParticipation = {
  roots: new Map(),
};

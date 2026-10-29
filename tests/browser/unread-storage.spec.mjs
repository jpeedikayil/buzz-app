import { test, expect } from "./source-fixture.mjs";

// Real IndexedDB boundary of the Inbox's device record; what the owner
// restores from it is in src/features/relay/unread-restore.test.ts.
test("unread record survives reload, keeps the last record over a refused write, and is purged with only its partition", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/unread-storage-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Unread storage boundary</title>",
    }),
  );
  const peer = await context.newPage();
  for (const window of [page, peer])
    await window.goto(`${sourceOrigin}/unread-storage-test`);
  // Runs `work` with a storage for `scope` in `window`: it reads first, as a
  // session does, and the result reports the record read and the save's
  // outcome.
  const session = (window, scope, save) =>
    window.evaluate(
      async ({ scope, save }) => {
        const { browserUnreadStorage } = await import(
          "/src/features/relay/unread-storage.ts"
        );
        window.stores ??= {};
        window.stores[scope] ??= browserUnreadStorage(scope);
        const store = window.stores[scope];
        const describe = (record) =>
          record && {
            roots: [...record.participation.roots],
            walk: record.participation.walk,
            events: record.events.map((event) => event.id),
            structure: [...record.structure],
            complete: record.complete,
          };
        const before = describe(await store.read());
        if (!save) return { before };
        const event = (id, extra = {}) => ({
          id,
          pubkey: "a".repeat(64),
          kind: 9,
          created_at: 1,
          tags: [["h", "team"]],
          content: id.slice(0, 1),
          sig: "f".repeat(128),
          ...extra,
        });
        try {
          await store.save({
            participation: {
              roots: new Map([
                [save.root, { at: 5, newestId: "b".repeat(64) }],
              ]),
              walk: { since: 3 },
            },
            events: save.events.map((id) =>
              // A function is not cloneable: the write fails inside the
              // transaction, after the events were read.
              save.uncloneable === id
                ? event(id, { extra: () => {} })
                : event(id),
            ),
            structure: new Set(save.structure ?? []),
            complete: true,
          });
          return { before, saved: true };
        } catch (error) {
          return { before, saved: false, error: String(error) };
        }
      },
      { scope, save },
    );
  const forget = (window) =>
    window.evaluate(() => {
      for (const store of Object.values(window.stores ?? {})) store.close();
      window.stores = {};
    });
  const [one, two, three] = ["1", "2", "3"].map((digit) => digit.repeat(64));
  try {
    expect(
      await session(page, "here", {
        root: "team:a",
        events: [one, two],
        structure: [two],
      }),
    ).toEqual({ before: undefined, saved: true });
    await session(page, "neighbor", { root: "team:n", events: [three] });
    await page.reload();
    const record = {
      roots: [["team:a", { at: 5, newestId: "b".repeat(64) }]],
      walk: { since: 3 },
      events: [one, two],
      structure: [two],
      complete: true,
    };
    expect(await session(page, "here")).toEqual({ before: record });
    // Another window holds a session for the same partition.
    expect(await session(peer, "here")).toEqual({ before: record });

    // A write that fails partway leaves the last record whole.
    const refused = await session(page, "here", {
      root: "team:b",
      events: [two, three],
      uncloneable: three,
    });
    expect(refused).toMatchObject({ saved: false });
    await forget(page);
    expect(await session(page, "here")).toEqual({ before: record });

    // Leaving the community purges its partition alone.
    await page.evaluate(async () => {
      const { purgeUnreadStorage } = await import(
        "/src/features/relay/unread-storage.ts"
      );
      await purgeUnreadStorage("here");
    });
    await forget(page);
    expect(await session(page, "neighbor")).toEqual({
      before: {
        roots: [["team:n", { at: 5, newestId: "b".repeat(64) }]],
        walk: { since: 3 },
        events: [three],
        structure: [],
        complete: true,
      },
    });
    // The other window's session, which read before the purge, cannot save
    // the left community's evidence back, even after reading again.
    expect(
      await session(peer, "here", { root: "team:a", events: [one] }),
    ).toMatchObject({
      saved: false,
      error: expect.stringContaining("purged by another window"),
    });
    expect(
      await session(peer, "here", { root: "team:a", events: [one] }),
    ).toMatchObject({ before: undefined, saved: false });
    // A session started after the purge, as for rejoining, saves as usual.
    expect(
      await session(page, "here", { root: "team:c", events: [two] }),
    ).toEqual({ before: undefined, saved: true });
    await forget(page);
    expect(await session(page, "here")).toMatchObject({
      before: { roots: [["team:c", expect.anything()]], events: [two] },
    });
  } finally {
    for (const window of [page, peer]) await forget(window);
    await peer.close();
  }
});

// Built-app boundary: real IndexedDB across a reload, and the broker's minute
// recovery tick, which lower layers stub. What each pass reads is pinned in
// src/features/relay/unread-restore.test.ts and live-session.test.ts.
import { test as appTest } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// The session hook, to wait for a pass to settle.
appTest.use({ pluginFixtures: true });

appTest.describe("warm relaunch", () => {
  appTest.use({
    productionBroker: true,
    readState: true,
    threadUnread: true,
    // The viewer joined the peer's thread with a reply only the membership
    // lookup returns, so no channel read shows that they took part.
    threadUnreadJoined: true,
    historyCounts: { alpha: 2, beta: 1 },
  });

  appTest(
    "a warm relaunch shows the saved rows before the relay answers and reads only the delta, as the minute tick does, which drops a reply deleted meanwhile",
    async ({ page, app }) => {
      // Two relaunches and the broker's real minute tick.
      appTest.setTimeout(240_000);
      // A reply in a thread the viewer started, the class of a reply below
      // its channel's catch-up mark (R1), which no window reads.
      const question = app.append(
        "primary",
        "beta",
        "Viewer question",
        false,
        true,
      );
      app.append("primary", "beta", "Peer answer", false, false, question.id);
      const inbox = page.getByRole("region", { name: "Inbox", exact: true });
      const loading = inbox.getByText("Checking recent activity…");
      const row = (text) =>
        inbox
          .getByRole("list", { name: "Inbox conversations" })
          .getByRole("listitem")
          .filter({ hasText: text });
      // That answer, and the peer thread the viewer joined, the class of a
      // thread older than the reads reach (a lost thread).
      const saved = ["Peer answer", "Unread reply 1"];
      // What the unread owner reads: not channel heads or the mention feed.
      const unreadReads = (from) =>
        app.report.queries
          .slice(from)
          .filter(
            ({ community, filter }) =>
              community === "primary" &&
              filter.kinds?.includes(9) &&
              !filter.top_level &&
              !filter["#p"],
          )
          .map(({ filter }) => filter);
      const delta = ({ at }) => ({
        kinds: expect.arrayContaining([9, 40002, 40008, 40003, 5, 9005]),
        "#h": ["alpha", "beta"],
        since: at - 1865,
        limit: 500,
      });
      // Settles the running pass and those queued behind it.
      const settled = () =>
        page.evaluate(() =>
          window.fixtureRelay.snapshot().session.unread.ensure(),
        );
      // The saved record of the one community, read without creating it.
      const record = () =>
        page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const request = indexedDB.open("buzz-unread-v1");
              request.onupgradeneeded = () => request.transaction.abort();
              request.onerror = () => resolve(undefined);
              request.onsuccess = () => {
                const db = request.result;
                const all = db.transaction("meta").objectStore("meta").getAll();
                all.onsuccess = () => {
                  db.close();
                  const [meta, ...more] = all.result;
                  if (more.length) reject(new Error("More than one record"));
                  else
                    resolve(
                      meta && { complete: meta.complete, mark: meta.mark },
                    );
                };
                all.onerror = () => {
                  db.close();
                  reject(all.error);
                };
              };
            }),
        );
      // Relaunches with the relay's unread answers held, so what shows before
      // they land is what the record restored, and returns the reads sent.
      const relaunch = async (shown) => {
        const { mark } = await record();
        const from = app.report.queries.length;
        app.relay.holdUnread();
        try {
          await page.reload();
          await openPage(page, "Inbox");
          await expect
            .poll(() => app.report.unreadHolds.some((hold) => hold.pending))
            .toBe(true);
          for (const text of shown) await expect(row(text)).toBeVisible();
          // Loading until the delta's first page lands.
          await expect(loading).toBeVisible();
          expect(unreadReads(from)).toEqual([delta(mark)]);
        } finally {
          app.relay.releaseUnread();
        }
        await settled();
        await expect(loading).toHaveCount(0);
        expect(unreadReads(from)).toEqual([delta(mark)]);
      };

      // A fresh launch reads in full, and saves a record caught up to now.
      await page.goto(app.origin);
      await openPage(page, "Inbox");
      for (const text of saved) await expect(row(text)).toBeVisible();
      await settled();
      expect(await record()).toMatchObject({
        complete: true,
        mark: { at: expect.any(Number) },
      });

      await relaunch(saved);
      for (const text of saved) await expect(row(text)).toBeVisible();

      // The broker's recovery tick comes a minute after its socket
      // authenticated, and catches up with the delta alone.
      const { mark } = await record();
      const from = app.report.queries.length;
      await expect
        .poll(() => unreadReads(from).length, { timeout: 75_000 })
        .toBeGreaterThan(0);
      await settled();
      expect(unreadReads(from)).toEqual([delta(mark)]);

      // Deleted on the relay while the device was closed: the record still
      // shows it until the delta returns its deletion.
      app.deleteThreadReply("Unread reply 1");
      await relaunch(saved);
      await expect(row("Unread reply 1")).toHaveCount(0);
      await expect(row("Peer answer")).toBeVisible();
    },
  );
});

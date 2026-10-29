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
      await session(page, "here", { root: "team:a", events: [one, two] }),
    ).toEqual({ before: undefined, saved: true });
    await session(page, "neighbor", { root: "team:n", events: [three] });
    await page.reload();
    const record = {
      roots: [["team:a", { at: 5, newestId: "b".repeat(64) }]],
      walk: { since: 3 },
      events: [one, two],
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

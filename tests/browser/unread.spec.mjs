import { openChannelDetails } from "./channel-details.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import {
  readJournal as journal,
  holdReadingFocus,
  releaseReadingFocus,
} from "./reading.mjs";

const alphaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test.use({
  productionBroker: true,
  readState: true,
  pluginFixtures: true, // Existing read-only session exposure for owner barriers.
  channelIds: [alphaId, "beta"],
  channelNames: { [alphaId]: "Alpha" },
  historyCounts: { [alphaId]: 640, beta: 20 },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const alpha = (page) => page.getByRole("button", { name: /^Alpha/ });
const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });
// Focus outside the reading surface. The timeline and its own composer both
// read after dwell; a focused sidebar row selects and reads nothing.
const park = (page) => alpha(page).focus();
async function visible(page) {
  return history(page).evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return [...element.querySelectorAll("[data-message-id]")]
      .filter((row) => {
        const b = row.getBoundingClientRect();
        return (
          b.width > 0 &&
          b.height > 0 &&
          b.top >= viewport.top &&
          b.bottom <= viewport.bottom &&
          b.left >= viewport.left &&
          b.right <= viewport.right
        );
      })
      .map((row) => row.dataset.messageId);
  });
}
async function options(page, clockPaused = false) {
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  const opening = !(await panel.isVisible());
  if (opening) await openChannelDetails(page, { clockPaused });
  else
    await page
      .getByRole("button", { name: "Close Channel settings tab", exact: true })
      .click();
  if (opening) {
    // The details and lifecycle readers finish independently. Observe both before
    // checking diagnostics so a late details alert cannot escape the assertion.
    await expect(
      page.getByRole("complementary", {
        name: "Channel settings",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveAttribute("aria-busy", "false");
    await expect(
      page.getByRole("button", { name: "Leave channel", exact: true }),
    ).toBeVisible();
    await page.getByText("Diagnostics", { exact: true }).click();
  }
}

// The real startup composition must order optional catalog reads after channel
// authority; completing that first roster cancels reads already in flight.
test("Messages startup waits for channel discovery before loading templates", async ({
  page,
  app,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let catalogRequested = false;
  page.on("request", (request) => {
    if (!request.url().endsWith("/query")) return;
    const filters = request.postDataJSON();
    if (filters.some((filter) => filter["#t"]?.includes("buzz-channel-kit-v1")))
      catalogRequested = true;
  });
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (filters.some((filter) => filter.kinds?.includes(39002) && filter["#p"]))
      await gate;
    await route.continue();
  });
  // Emoji loading is a later effect in the same mounted Messages workspace.
  // Observing it establishes that the earlier template effect has run.
  const workspaceStarted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/query") &&
      request.postDataJSON().some((filter) => filter.kinds?.includes(30030)),
  );
  const catalogLoaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/query") &&
      response
        .request()
        .postDataJSON()
        .some((filter) => filter["#t"]?.includes("buzz-channel-kit-v1")),
  );
  try {
    await page.goto(app.origin);
    await workspaceStarted;
    expect(catalogRequested).toBe(false);
  } finally {
    release();
  }
  await catalogLoaded;
  await composer(page).waitFor();
  await settle(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("built sidebar → visible dwell → durable journal → encrypted broker publication; reload preserves intent", async ({
  page,
  app,
}) => {
  // Messages starts with its composer focused, and composer focus is reading.
  // On a slow runner that dwell can read Alpha before the search palette takes
  // focus, so hold reading focus until the unread baseline is observed.
  await holdReadingFocus(page);
  await open(page, app);
  await expect
    .poll(() =>
      app.report.queries.some(({ filter }) => filter.read_state_snapshot === 1),
    )
    .toBe(true);
  // Wait for the bounded roster-wide repair, not merely the first 20-row head.
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    /^500 observed unread messages/,
  );
  await park(page);
  await releaseReadingFocus(page);
  // Install after startup and focus cancellation have settled on the real
  // clock; pause at a fixed instant rather than the page's ticking clock.
  const base = Date.now();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 20_000);
  await page.clock.runFor(900); // Sidebar focus is not reading, even past dwell.
  expect((await journal(page)).state.frontiers).toEqual({});
  expect(app.report.readPublications).toEqual([]);
  const ids = await visible(page);
  expect(ids.length).toBeGreaterThan(0);
  // Typing under the conversation is reading it: the composer shares the
  // timeline's edit scope, so its focus earns the same dwell as the list's.
  await composer(page).focus();
  await page.clock.runFor(299);
  expect((await journal(page)).state.frontiers).toEqual({});
  await page.clock.runFor(1);
  // Catch-up reads every visible ordinary message, so none needs its own mark.
  await expect
    .poll(async () => Object.keys((await journal(page)).state.frontiers))
    .toEqual([`activity:${alphaId}`]);
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
  await page.clock.resume();
  const stored = await journal(page);
  expect(stored.state.frontiers[alphaId]).toBeUndefined();
  // The normal debounce, signing, NIP-44, NIP-98 and publication/readback all run.
  await expect
    .poll(() => app.report.readPublications.length, { timeout: 12000 })
    .toBe(1);
  await expect
    .poll(async () => (await journal(page)).acceptedRevision)
    .toBe(stored.revision);
  const { event, blob } = app.report.readPublications[0];
  expect(blob.contexts).toEqual(stored.state.frontiers);
  expect(event.content).not.toContain(ids[0]);
  expect(blob.contexts[alphaId]).toBeUndefined();
  await page.reload();
  await openPage(page, "Messages");
  await composer(page).waitFor();
  await settle(page);
  expect((await journal(page)).slot).toBe(stored.slot);
  expect((await journal(page)).state.frontiers).toEqual(stored.state.frontiers);
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
});

test("focus cancellation and local manual-unread survive reload until explicit mark-through or reading to the bottom", async ({
  page,
  app,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const markerRequested = page.waitForRequest(
    (request) =>
      request.url().endsWith("/query") &&
      request.postDataJSON().some((filter) => filter.read_state_snapshot === 1),
  );
  await page.route("**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.read_state_snapshot === 1)
    )
      await gate;
    await route.continue();
  });
  try {
    await open(page, app);
    await markerRequested;
    // Mounted history is not proof that the serial durable owner is ready.
    expect(
      await page.evaluate(
        () => window.fixtureRelay.snapshot().session.unread.sync().completeness,
      ),
    ).toBe("unknown");
  } finally {
    release();
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sync = window.fixtureRelay.snapshot().session.unread.sync();
        return { status: sync.status, completeness: sync.completeness };
      }),
    )
    .toEqual({ status: "reconciled", completeness: "snapshot" });
  await park(page);
  // As above: install after startup and focus cancellation, then pause at
  // fixed instants from one base.
  const base = Date.now();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 20_000);
  await history(page).focus();
  const ids = await visible(page);
  expect(ids.length).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        ({ ids, alphaId }) =>
          ids.every(
            (id) =>
              window.fixtureRelay
                .snapshot()
                .session.unread.attention(alphaId, id).viewing,
          ),
        { ids, alphaId },
      ),
    )
    .toBe(true);
  await page.clock.runFor(299);
  await park(page);
  await page.clock.runFor(900);
  // Keep policy time paused through the durable action and UI round trips;
  // runner delays must not overtake a later fixed pause target.
  await options(page, true);
  await page
    .getByRole("button", { name: "Mark unread on this device", exact: true })
    .click();
  // This durable action is ordered behind any erroneous dwell mutation in the
  // same read-state queue; a separate IndexedDB read alone is not a barrier.
  await expect
    .poll(async () => (await journal(page)).localUnread[alphaId])
    .toBeGreaterThan(0);
  expect((await journal(page)).state.frontiers).toEqual({});
  await options(page, true);
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await park(page);
  await page.clock.resume();
  app.relay.holdContent(); // Reload must use verified disk evidence, not wait for network repair.
  await page.reload();
  await openPage(page, "Messages");
  await composer(page).waitFor();
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await options(page);
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect
    .poll(async () => (await journal(page)).localUnread[alphaId])
    .toBeUndefined();
  const newest = app.histories.get(`primary/${alphaId}`).at(-1).created_at;
  await expect
    .poll(async () => (await journal(page)).state.frontiers[alphaId])
    .toBe(newest);
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
  // Reading to the live bottom also ends a manual unread, without moving the
  // channel mark. Channel settings stays open from Mark read so the timeline
  // keeps its layout. Reload does not promise the live bottom, so scroll there
  // as a reader would.
  await park(page);
  await page
    .getByRole("button", { name: "Mark unread on this device", exact: true })
    .click();
  await expect
    .poll(async () => (await journal(page)).localUnread[alphaId])
    .toBeGreaterThan(0);
  await history(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    page.getByRole("button", { name: "Jump to latest", exact: true }),
  ).toBeHidden();
  await history(page).focus();
  await expect
    .poll(async () => (await journal(page)).localUnread[alphaId])
    .toBeUndefined();
  expect((await journal(page)).state.frontiers[alphaId]).toBe(newest);
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
});

test("a surviving window publishes a closed window's durable read intent", async ({
  page,
  context,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  await park(page);
  const survivor = await context.newPage();
  app.watchPageErrors(survivor);
  survivor.on("console", (message) => {
    if (message.type() === "error")
      app.report.consoleErrors.push(message.text());
  });
  try {
    await holdReadingFocus(survivor);
    await open(survivor, app);
    await park(survivor);
    await options(survivor);
    await survivor.getByText("Unread status", { exact: true }).click();
    await expect(
      survivor.getByText(/Read sync: frontier-sync · reconciled/),
    ).toBeVisible();
    for (const window of [page, survivor])
      await window.evaluate(() =>
        window.fixtureRelay.snapshot().session.unread.ensure(),
      );
    // Both windows are parked and their durable owners are ready before the
    // context-wide clock is installed. No ticking startup interval to overtake.
    const base = Date.now();
    await page.clock.install({ time: base });
    await page.clock.pauseAt(base + 20_000);
    expect((await journal(page)).state.frontiers).toEqual({});
    await page.bringToFront();
    const ids = await visible(page);
    expect(ids.length).toBeGreaterThan(0);
    await releaseReadingFocus(page);
    await history(page).focus();
    await page.clock.runFor(300);
    // One dwell writes catch-up. It reads each visible ordinary message, so
    // none needs its own mark. A positive revision alone can be an
    // intermediate durable state, not the publication baseline.
    await expect
      .poll(async () => Object.keys((await journal(page)).state.frontiers))
      .toEqual([`activity:${alphaId}`]);
    await park(page);
    const stored = await journal(page);
    await expect(
      survivor.getByText(/Read sync: frontier-sync · pending/),
    ).toBeVisible();
    expect(app.report.readPublications).toEqual([]);
    await page.close(); // Cancel the origin publisher before its normal five-second debounce.
    await survivor.clock.resume(); // The controlled clock is shared by this context.
    await expect
      .poll(() => app.report.readPublications.length, { timeout: 12000 })
      .toBe(1);
    await expect
      .poll(async () => (await journal(survivor)).acceptedRevision)
      .toBe(stored.revision);
    expect(app.report.readPublications[0].blob.contexts).toEqual(
      stored.state.frontiers,
    );
    await expect(
      survivor.getByText(/Read sync: frontier-sync · reconciled/),
    ).toBeVisible();
  } finally {
    await survivor.close();
  }
});

test.describe("explicit mark-through with membership activity", () => {
  test.use({ membershipActivity: true });

  for (const activityOnly of [false, true]) {
    test(
      activityOnly
        ? "activity-only history explains the missing message without clearing manual unread"
        : "chat followed by membership activity clears manual unread through the newest chat",
      async ({ page, app }) => {
        // Model only upstream signed history; the app must load and verify it.
        const loaded = app.histories.get(`primary/${alphaId}`).slice(-4);
        app.histories.set(
          `primary/${alphaId}`,
          activityOnly
            ? loaded.filter((event) => event.kind === 40099)
            : loaded,
        );
        const lastChat = loaded.findLast((event) => event.kind === 9);
        // Startup composer focus must not read the unread baseline.
        await holdReadingFocus(page);
        await open(page, app);
        await park(page);
        // Startup sidebar layout can report WebKit's ResizeObserver loop, which
        // page-errors.mjs classifies as an engine report. Hold the raw check to
        // this journey, which starts once the channel has opened.
        const startupErrors = app.report.errors.length;
        await expect(
          history(page).locator("[data-membership-row]"),
        ).toHaveCount(1);
        if (!activityOnly) {
          await expect(alpha(page).getByRole("img")).toHaveAttribute(
            "aria-label",
            /^2 observed unread messages/,
          );
        }
        await options(page);
        await page
          .getByRole("button", {
            name: "Mark unread on this device",
            exact: true,
          })
          .click();
        await expect(alpha(page).getByRole("img")).toHaveAttribute(
          "aria-label",
          "Marked unread on this device only",
        );
        const before = await journal(page);
        await page
          .getByRole("button", {
            name: "Mark read through loaded messages",
            exact: true,
          })
          .click();
        if (activityOnly) {
          await expect(page.getByRole("alert")).toHaveText(
            "Load a verified message before marking through it.",
          );
          const after = await journal(page);
          expect(after.localUnread[alphaId]).toBe(before.localUnread[alphaId]);
          expect(after.state.frontiers).toEqual(before.state.frontiers);
          expect(after.revision).toBe(before.revision);
        } else {
          await expect
            .poll(async () => (await journal(page)).state.frontiers[alphaId])
            .toBe(lastChat.created_at);
          expect((await journal(page)).localUnread[alphaId]).toBeUndefined();
          await expect(alpha(page).getByRole("img")).toHaveCount(0);
          await expect(page.getByRole("alert")).toHaveCount(0);
        }
        // Do not let the shared fixture's legacy WebKit exception mask this path.
        expect(app.report.errors.slice(startupErrors)).toEqual([]);
      },
    );
  }
});

test.describe("automatic catch-up after membership rows", () => {
  test.use({
    membershipActivity: true,
    historyCounts: { [alphaId]: 20, beta: 1 },
  });
  test("own-composer focus quiets a channel whose last visible row is membership activity", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect(
      history(page).locator("[data-membership-row]"),
    ).toBeInViewport();
    await composer(page).focus();
    const latest = app.histories
      .get(`primary/${alphaId}`)
      .findLast((row) => row.kind === 9);
    await expect
      .poll(
        async () =>
          (await journal(page))?.state.frontiers[`activity:${alphaId}`],
      )
      .toBe(latest.created_at);
    await expect(alpha(page).getByText("Alpha", { exact: true })).toHaveCSS(
      "font-weight",
      "400",
    );
  });
});

// AIDA-2318: a burst of joins filled the first history page, so the messages
// unread counted never loaded and opening the channel could not read them.
test.describe("a join burst longer than a history page", () => {
  test.use({ membershipBurst: 40, historyCounts: { [alphaId]: 20, beta: 1 } });
  test("opening the channel reads the messages behind the joins", async ({
    page,
    app,
  }) => {
    // Startup focus would read Alpha before the unread baseline is observed.
    await holdReadingFocus(page);
    await open(page, app);
    await expect(alpha(page).locator("[data-channel-unread]")).toHaveCount(1);
    await releaseReadingFocus(page);
    await composer(page).focus();
    const latest = app.histories
      .get(`primary/${alphaId}`)
      .findLast((row) => row.kind === 9);
    await expect
      .poll(
        async () =>
          (await journal(page))?.state.frontiers[`activity:${alphaId}`],
      )
      .toBe(latest.created_at);
    await expect(alpha(page).locator("[data-channel-unread]")).toHaveCount(0);
  });
});

// Browser boundary: real app reading → strict IndexedDB under pressure → reload.
// Lower-layer tests own unseen/manual/override matrices; no new fixture controls.
test.describe("local receipt reserve", () => {
  test.use({ historyCounts: { [alphaId]: 20, beta: 1400 } });
  test("a viewport receipt survives other-channel pressure and app reload", async ({
    page,
    app,
  }) => {
    // Startup and reload must not earn bottom catch-up before the isolated read.
    await holdReadingFocus(page);
    await open(page, app);
    const ids = await visible(page);
    expect(ids.length).toBeGreaterThan(0);
    const key = `msg:${ids[0]}`;
    // Read one visible row without a dwell at the bottom: a catch-up mark
    // would cover it and leave no message mark for pressure to evict.
    await page.evaluate(
      async ({ alphaId, id }) => {
        const reading = window.fixtureRelay
          .snapshot()
          .session.unread.reading(alphaId);
        try {
          await reading.observe([id]);
        } finally {
          reading.dispose();
        }
      },
      { alphaId, id: ids[0] },
    );
    await expect
      .poll(async () => (await journal(page)).state.frontiers[key])
      .toBeDefined();
    expect(
      (await journal(page)).state.frontiers[`activity:${alphaId}`],
    ).toBeUndefined();
    await park(page);
    await page.evaluate(() =>
      window.fixtureRelay.snapshot().session.channels.ensure("beta"),
    );
    const ready = () =>
      expect
        .poll(() =>
          page.evaluate(() => {
            const view = window.fixtureRelay
              .snapshot()
              .session.channels.window("beta");
            return view.status === "ready" && !view.loadingOlder;
          }),
        )
        .toBe(true);
    await ready();
    while (true) {
      const more = await page.evaluate(async () => {
        const { channels, unread } = window.fixtureRelay.snapshot().session;
        const view = channels.window("beta");
        const reading = unread.reading("beta");
        try {
          for (const row of view.rows) await reading.observe([row.id]);
        } finally {
          reading.dispose();
        }
        return view.hasMore;
      });
      if (!more) break;
      const pending = app.pending.length;
      await page.evaluate(() =>
        window.fixtureRelay.snapshot().session.channels.loadOlder("beta"),
      );
      // This fixture deliberately gates every older-history response.
      await expect.poll(() => app.pending.length).toBe(pending + 1);
      app.pending[pending].release();
      await ready();
    }
    const stored = await journal(page);
    expect(stored.state.frontiers[key]).toBeUndefined();
    expect(stored.reserve[key]).toBeDefined();
    await expect
      .poll(async () => (await journal(page)).acceptedRevision, {
        timeout: 12000,
      })
      .toBe(stored.revision);
    expect(
      app.report.readPublications.at(-1).blob.contexts[key],
    ).toBeUndefined();
    await page.reload();
    await openPage(page, "Messages");
    await composer(page).waitFor();
    await settle(page);
    await page.evaluate(() =>
      window.fixtureRelay.snapshot().session.unread.ensure(),
    );
    expect((await journal(page)).reserve[key]).toBe(stored.reserve[key]);
    expect(
      await page.evaluate(
        ({ alphaId, id }) =>
          window.fixtureRelay.snapshot().session.unread.attention(alphaId, id)
            .unread,
        { alphaId, id: ids[0] },
      ),
    ).toBe(false);
  });
});

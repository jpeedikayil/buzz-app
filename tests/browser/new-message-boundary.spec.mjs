import { test as appTest } from "./fixture.mjs";
import { test as sourceTest } from "./source-fixture.mjs";
import { expect } from "./playwright-test.mjs";
import { openChannelDetails } from "./channel-details.mjs";
import {
  anchor,
  expectAnchor,
  keyScroll,
  open,
  settle,
  upper,
  wheel,
} from "./timeline.mjs";
import {
  holdReadingFocus,
  readJournal,
  releaseReadingFocus,
} from "./reading.mjs";

appTest.use({
  productionBroker: true,
  readState: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 1 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const separator = (page) =>
  history(page).locator("[data-new-messages-boundary]");
const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });
const messageAfter = (element) =>
  element.evaluate((separator) => {
    let sibling = separator.nextElementSibling;
    while (sibling) {
      const row = sibling.matches("[data-message-id]")
        ? sibling
        : sibling.querySelector("[data-message-id]");
      if (row) return row.dataset.messageId;
      sibling = sibling.nextElementSibling;
    }
    return null;
  });

// Only a real virtualizer with a warm measured cache can omit the saved row
// without changing list height when restoration mounts it.
sourceTest(
  "restores the boundary message at its saved offset with warm virtualized geometry",
  async ({ page }) => {
    await page.goto("/tests/fixtures/boundary-restoration.html");
    const targetId = await page.evaluate(
      () => window.boundaryRestoration.boundaryId,
    );
    const target = history(page).locator(`[data-message-id="${targetId}"]`);
    await expect(separator(page)).toBeVisible();
    await settle(page);
    await expect(target).toBeInViewport();
    const before = await anchor(page, targetId);
    const height = await history(page)
      .locator("ol")
      .evaluate((list) => list.style.height);
    expect(
      await history(page).locator("[data-message-id]").count(),
    ).toBeLessThan(180);

    await page
      .getByRole("button", { name: "Hide timeline", exact: true })
      .click();
    await expect(history(page)).toHaveCount(0);
    const saved = await page.evaluate(() => window.boundaryRestoration.saved());
    expect(saved.anchor.id).toBe(targetId);
    expect(saved.bottom).toBe(false);
    await page
      .getByRole("button", { name: "Restore timeline", exact: true })
      .click();
    await expect(separator(page)).toBeVisible();
    await settle(page);
    await expect(history(page).locator("ol")).toHaveCSS("height", height);
    await expectAnchor(page, before);
  },
);

async function reachEdge(page, direction) {
  const scroller = history(page);
  const distance = () =>
    scroller.evaluate(
      (element, direction) =>
        direction < 0
          ? element.scrollTop
          : element.scrollHeight - element.scrollTop - element.clientHeight,
      direction,
    );
  await scroller.hover();
  for (let gesture = 0; gesture < 8; gesture++) {
    const before = await distance();
    if (before < 4) break;
    await wheel(page, direction * before, scroller);
    await expect
      .poll(distance, { message: "wheel progresses toward timeline edge" })
      .toBeLessThan(before);
  }
  expect(await distance(), "timeline reaches the requested edge").toBeLessThan(
    4,
  );
}

async function scrollBoundaryIntoView(page) {
  const scroller = history(page);
  await scroller.hover();
  const offset = await scroller.evaluate((element) => {
    const boundary = element.querySelector("[data-new-messages-boundary]");
    return (
      boundary.getBoundingClientRect().top - element.getBoundingClientRect().top
    );
  });
  const delta = offset - 32;
  if (Math.abs(delta) > 4) await wheel(page, delta, scroller);
  await expect(separator(page)).toBeInViewport();
  await settle(page);
}

async function unavailableSnapshot(page, app) {
  let unavailable = true;
  await page.route("**/query", async (route) => {
    if (
      unavailable &&
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.read_state_snapshot === 1)
    ) {
      app.report.relayFailures ??= [];
      app.report.relayFailures.push(route.request().url());
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic snapshot unavailable" }),
      });
    }
    await route.continue();
  });
  return () => {
    unavailable = false;
  };
}

async function snapshotRetry(page) {
  await openChannelDetails(page);
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await expect(settings).toHaveAttribute("aria-busy", "false");
  await page.getByText("Diagnostics", { exact: true }).click();
  await page.getByText("Unread status", { exact: true }).click();
  const retry = page.getByRole("button", {
    name: "Retry read sync",
    exact: true,
  });
  await expect(retry).toBeVisible();
  return retry;
}

appTest(
  "keeps the first unread boundary stable through reading and live appends",
  async ({ page, app }, testInfo) => {
    await holdReadingFocus(page);
    const releaseSnapshot = await unavailableSnapshot(page, app);
    await open(page, app);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const { status, completeness } = window.fixtureRelay
            .snapshot()
            .session.unread.sync();
          return { status, completeness };
        }),
      )
      .toEqual({ status: "error", completeness: "unknown" });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const history = window.fixtureRelay
            .snapshot()
            .session.channels.window("alpha");
          return {
            status: history.status,
            freshness: history.freshness,
            refreshing: history.refreshing === true,
            hasMore: history.hasMore,
          };
        }),
      )
      .toEqual({
        status: "ready",
        freshness: "verified",
        refreshing: false,
        hasMore: false,
      });
    await expect(separator(page)).toHaveCount(0);

    // Cold entry has no proven membership. Re-enter loaded history while
    // read sync stays unavailable, so recovery can exercise divider insertion.
    await page.getByRole("button", { name: /^Beta/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Alpha/ }).click();
    await expect(composer(page)).toBeVisible();
    await settle(page);

    // Keep the recovery control open before measuring. Holding a request
    // through wheel input would race the real read-state network deadline.
    const retrySnapshot = await snapshotRetry(page);

    await reachEdge(page, -1);
    await settle(page);
    await page.mouse.move(0, 0);
    const beforePath = testInfo.outputPath("boundary-before.png");
    await history(page).screenshot({ path: beforePath });
    await testInfo.attach("boundary-before.png", {
      path: beforePath,
      contentType: "image/png",
    });
    const boundaryId = app.histories.get("primary/alpha")[0].id;
    await history(page)
      .locator(`[data-message-id="${boundaryId}"] p`)
      .evaluate((paragraph) => {
        paragraph.style.minHeight = "640px";
      });
    await settle(page);
    await history(page).hover();
    await wheel(page, 240);
    await settle(page);
    expect(
      await history(page).evaluate((element) => element.scrollTop),
      "reader is partway through the tall first row",
    ).toBeGreaterThan(0);
    const beforeBoundaryAnchor = await anchor(page);
    const beforeBoundaryBubble = await history(page)
      .locator(`[data-message-id="${boundaryId}"] [data-bubble]`)
      .boundingBox();
    expect(beforeBoundaryBubble).not.toBeNull();
    await expect(separator(page)).toHaveCount(0);
    await page.mouse.move(0, 0);

    releaseSnapshot();
    await retrySnapshot.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.fixtureRelay.snapshot().session.unread.sync().completeness,
        ),
      )
      .toBe("snapshot");
    await expect(separator(page)).toHaveCount(1);
    await expectAnchor(page, beforeBoundaryAnchor);
    const copied = await history(page).evaluate((element) => {
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        const clipboardData = new DataTransfer();
        element.dispatchEvent(
          new ClipboardEvent("copy", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
        return {
          html: clipboardData.getData("text/html"),
          text: clipboardData.getData("text/plain"),
        };
      } finally {
        selection.removeAllRanges();
      }
    });
    for (const value of Object.values(copied)) {
      expect(value).toContain(
        app.histories.get("primary/alpha")[0].content.split("\n")[0],
      );
      expect(value).not.toContain("New messages");
    }
    expect(copied.html).not.toContain("<hr>");
    const boundaryRow = history(page).locator(
      `[data-message-id="${boundaryId}"] [data-layout="timeline"]`,
    );
    await expect(boundaryRow).toHaveCount(1);
    await expect(
      boundaryRow.locator("xpath=..").locator("[data-day]"),
    ).toHaveCount(1);
    await expect(boundaryRow).toHaveAttribute("data-stack-next", "true");
    const boundaryPath = testInfo.outputPath("t001-boundary.png");
    await history(page).screenshot({ path: boundaryPath });
    await testInfo.attach("t001-boundary.png", {
      path: boundaryPath,
      contentType: "image/png",
    });
    const entryMessageBounds = await history(page)
      .locator(`[data-message-id="${boundaryId}"] [data-bubble]`)
      .boundingBox();
    expect(entryMessageBounds).not.toBeNull();
    expect(entryMessageBounds.y).toBeCloseTo(beforeBoundaryBubble.y, 0);
    expect(await messageAfter(separator(page))).toBe(boundaryId);

    // The tall row proves clipped-reader anchoring, not whole-row reading.
    // Restore the normal fixture geometry before earning visible-row dwell.
    await page
      .getByRole("button", { name: "Close Channel settings tab", exact: true })
      .click();
    await history(page)
      .locator(`[data-message-id="${boundaryId}"] p`)
      .evaluate((paragraph) => paragraph.style.removeProperty("min-height"));
    await settle(page);
    await reachEdge(page, -1);

    await releaseReadingFocus(page);
    await composer(page).focus();
    await expect(composer(page)).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const { unread } = window.fixtureRelay.snapshot().session;
          return unread.attention("alpha", id).viewing;
        }, boundaryId),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        Object.hasOwn(
          (await readJournal(page)).state.frontiers,
          `msg:${boundaryId}`,
        ),
      )
      .toBe(true);
    await expect(separator(page)).toHaveCount(1);
    expect(await messageAfter(separator(page))).toBe(boundaryId);

    await reachEdge(page, -1);
    await page.mouse.move(10, 10);
    await expect(
      history(page).getByRole("group", { name: "Message actions" }).first(),
    ).toHaveCSS("opacity", "0");
    const afterPath = testInfo.outputPath("boundary-after.png");
    await history(page).screenshot({ path: afterPath });
    await testInfo.attach("boundary-after.png", {
      path: afterPath,
      contentType: "image/png",
    });

    const targetId = await messageAfter(separator(page));
    expect(targetId).toBe(boundaryId);
    const alphaSidebar = page.getByRole("button", { name: /^Alpha/ });
    await alphaSidebar.focus();
    await expect(alphaSidebar).toBeFocused();
    await composer(page).focus();
    await expect(composer(page)).toBeFocused();
    await expect(separator(page)).toHaveCount(1);
    expect(await messageAfter(separator(page))).toBe(boundaryId);

    await page.getByRole("button", { name: /^Beta/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Alpha/ }).click();
    await expect(composer(page)).toBeVisible();
    await expect(separator(page)).toBeVisible();
    const revisitBoundaryId = await page.evaluate(
      (ids) => {
        const { unread } = window.fixtureRelay.snapshot().session;
        return ids.find((id) => {
          const attention = unread.attention("alpha", id);
          return (
            attention.status !== "unknown" &&
            !attention.pending &&
            (attention.forced || attention.unread)
          );
        });
      },
      app.histories.get("primary/alpha").map((row) => row.id),
    );
    expect(revisitBoundaryId).toBeTruthy();
    const revisitBoundary = history(page).locator(
      `[data-message-id="${revisitBoundaryId}"] [data-layout="timeline"]`,
    );
    await expect(revisitBoundary).toHaveAttribute(
      "data-stack-previous",
      "true",
    );
    const actualBoundaryId = await messageAfter(separator(page));
    const actualBoundaryIndex = app.histories
      .get("primary/alpha")
      .findIndex((row) => row.id === actualBoundaryId);
    expect(actualBoundaryId).toBe(revisitBoundaryId);
    expect(actualBoundaryIndex).toBeGreaterThan(0);
    await scrollBoundaryIntoView(page);
    await page.mouse.move(0, 0);
    await expect(separator(page)).toBeVisible();
    const labelBounds = await separator(page)
      .getByText("New messages", { exact: true })
      .boundingBox();
    const wideHistoryBounds = await history(page).boundingBox();
    const messageBounds = await history(page)
      .locator(`[data-message-id="${revisitBoundaryId}"] [data-bubble]`)
      .boundingBox();
    expect(labelBounds).not.toBeNull();
    expect(wideHistoryBounds).not.toBeNull();
    expect(messageBounds).not.toBeNull();
    expect(labelBounds.y).toBeGreaterThanOrEqual(wideHistoryBounds.y);
    expect(labelBounds.y + labelBounds.height).toBeLessThanOrEqual(
      wideHistoryBounds.y + wideHistoryBounds.height,
    );
    expect(
      labelBounds.y + labelBounds.height,
      "the boundary label clears the first unread message bubble",
    ).toBeLessThanOrEqual(messageBounds.y);
    const revisitPath = testInfo.outputPath("boundary-revisit-grouped.png");
    await history(page).screenshot({ path: revisitPath });
    await testInfo.attach("boundary-revisit-grouped.png", {
      path: revisitPath,
      contentType: "image/png",
    });

    await reachEdge(page, 1);
    await upper(page);
    const heldAnchor = await anchor(page);
    const live = app.append(
      "primary",
      "alpha",
      "Synthetic live follow-up",
      true,
      false,
    );
    await expectAnchor(page, heldAnchor);

    await reachEdge(page, 1);
    await expect(
      history(page).locator(`[data-message-id="${live.id}"]`),
    ).toBeVisible();
    await reachEdge(page, -1);
    expect(await messageAfter(separator(page))).toBe(revisitBoundaryId);

    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
      document.documentElement.dataset.fontSize = "larger";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await scrollBoundaryIntoView(page);
    await page.mouse.move(0, 0);
    await expect(separator(page)).toBeVisible();
    await expect(separator(page)).toHaveText("New messages");
    const bounds = await separator(page).boundingBox();
    const viewport = await history(page).boundingBox();
    const narrowBubble = await history(page)
      .locator(`[data-message-id="${revisitBoundaryId}"] [data-bubble]`)
      .boundingBox();
    expect(bounds).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(narrowBubble).not.toBeNull();
    expect(bounds.x).toBeGreaterThanOrEqual(viewport.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      viewport.x + viewport.width,
    );
    expect(bounds.y).toBeGreaterThanOrEqual(viewport.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(narrowBubble.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      viewport.y + viewport.height,
    );
    const narrowPath = testInfo.outputPath("boundary-narrow-dark.png");
    await history(page).screenshot({ path: narrowPath });
    await testInfo.attach("boundary-narrow-dark.png", {
      path: narrowPath,
      contentType: "image/png",
    });

    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "light";
      delete document.documentElement.dataset.fontSize;
    });
    await page.setViewportSize({ width: 1280, height: 850 });
    await settle(page);
    // Reflow leaves offscreen rows estimated. Start at a known edge before
    // comparing offsets so measuring those rows cannot masquerade as PageUp.
    await reachEdge(page, -1);
    await history(page).focus();
    await expect(history(page)).toBeFocused();
    const beforeKeyScroll = await history(page).evaluate((element) =>
      Math.round(element.scrollTop),
    );
    await keyScroll(page, "PageDown");
    await expect
      .poll(() =>
        history(page).evaluate((element) => Math.round(element.scrollTop)),
      )
      .toBeGreaterThan(beforeKeyScroll);
    await expect(separator(page)).toHaveCount(1);
  },
);

appTest.describe("pending entry membership", () => {
  appTest.use({ historyCounts: { alpha: 0, beta: 1 } });
  appTest(
    "does not turn a backdated live arrival into an entry boundary",
    async ({ page, app }) => {
      let latest;
      for (let index = 0; index < 3; index++)
        latest = app.append(
          "primary",
          "alpha",
          `Own entry message ${index}`,
          false,
        );
      await holdReadingFocus(page);
      const releaseSnapshot = await unavailableSnapshot(page, app);
      await open(page, app);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const { unread } = window.fixtureRelay.snapshot().session;
            return {
              completeness: unread.sync().completeness,
              count: unread.snapshot({ kind: "channel", channelId: "alpha" })
                .observedCount,
            };
          }),
        )
        .toEqual({ completeness: "unknown", count: 0 });
      const retry = await snapshotRetry(page);
      const late = app.append(
        "primary",
        "alpha",
        "Backdated live message",
        true,
        false,
        undefined,
        undefined,
        [],
        latest.created_at - 10,
      );
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const { unread, channels } = window.fixtureRelay.snapshot().session;
            return {
              loaded: channels
                .window("alpha")
                .rows.some((row) => row.id === id),
              unread: unread.attention("alpha", id).unread,
              latest: unread.snapshot({ kind: "channel", channelId: "alpha" })
                .latestMessage?.id,
            };
          }, late.id),
        )
        .toEqual({ loaded: true, unread: true, latest: latest.id });
      releaseSnapshot();
      await retry.click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.fixtureRelay.snapshot().session.unread.sync().completeness,
          ),
        )
        .toBe("snapshot");
      await settle(page);
      await expect(separator(page)).toHaveCount(0);
      expect(
        await page.evaluate(
          (id) =>
            window.fixtureRelay.snapshot().session.unread.attention("alpha", id)
              .unread,
          late.id,
        ),
      ).toBe(true);
    },
  );
});

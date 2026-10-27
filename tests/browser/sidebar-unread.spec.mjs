import { selectCommunity } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";
import { test as base, expect } from "./fixture.mjs";
import { streamEvidence } from "./stream-evidence.mjs";
import { open } from "./timeline.mjs";
import { holdReadingFocus, releaseReadingFocus } from "./reading.mjs";

// Preserve the failing handoff and capture original-reader delivery on Linux.
const test = base.extend({
  streamEvidence: [streamEvidence, { auto: true }],
});
test.use({
  productionBroker: true,
  readState: true,
  largeSidebar: true,
  sidebarUnread: true,
  historyCounts: { alpha: 20, beta: 20 },
});
const sidebar = (page) =>
  page.getByRole("complementary", { name: "Sidebar", exact: true });
const list = (page) =>
  page.getByRole("navigation", { name: "Subscribed channels" });
const cue = (page, edge) =>
  sidebar(page).locator(`button[data-edge="${edge}"]`);
// Exit animation retains the button, but it must not remain actionable.
const expectCueHidden = async (page, edge) => {
  const button = cue(page, edge);
  await expect(button).toHaveCount(1);
  await expect(button.locator("..")).toHaveAttribute("inert", "");
  await expect(button.locator("..")).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar(page).getByRole("button").and(button)).toHaveCount(0);
  await expect(button).toBeHidden();
};
const row = (page, id) =>
  list(page).locator(`button[data-channel-id="${id.toLowerCase()}"]`);
const removeDm = async (page, id) => {
  const dm = row(page, id);
  await dm.click({ button: "right" });
  const menu = page.getByRole("menu", { name: /Actions for / });
  const remove = menu.getByRole("menuitem", {
    name: "Remove from Team",
    exact: true,
  });
  await expect(remove).toBeVisible();
  await remove.click();
};
const scroll = (page, top) =>
  list(page).evaluate((el, top) => {
    el.scrollTop = top;
  }, top);
const scrollRowAbove = (page, id) =>
  row(page, id).evaluate((el) => {
    const viewport = el.closest("nav");
    if (!viewport) throw new Error("Channel row is outside the channel list");
    const rowRect = el.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    viewport.scrollTop += rowRect.bottom - viewportRect.top + 1;
  });
const inView = (page, id) =>
  row(page, id).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const viewport = el.closest("nav").getBoundingClientRect();
    return (
      rect.height > 0 &&
      rect.top >= viewport.top &&
      rect.bottom <= viewport.bottom
    );
  });
const heads = (app) =>
  app.report.queries.filter(
    ({ filter }) => filter.kinds?.includes(9) && filter["#h"]?.length === 1,
  );

test("DM hide control removes a row and a new message restores it", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const dm = row(page, "dm-030");
  await expect(dm).toBeVisible();
  const badge = dm.locator("[data-channel-unread]");
  await expect(badge).toBeVisible();
  const badgePosition = () =>
    dm.evaluate((button) => {
      const badge = button.querySelector("[data-channel-unread]");
      if (!badge) throw new Error("DM unread indicator is missing");
      const row = button.getBoundingClientRect();
      const marker = badge.getBoundingClientRect();
      return { x: marker.x - row.x, y: marker.y - row.y };
    });
  const before = await badgePosition();
  const container = dm.locator("xpath=ancestor::*[@data-channel-sidebar-row]");
  await container.screenshot({ path: info.outputPath("dm-row-default.png") });
  await dm.hover();
  await container.screenshot({ path: info.outputPath("dm-row-hover.png") });
  const after = await badgePosition();
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
  await removeDm(page, "dm-030");
  await expect(dm).toHaveCount(0);
  await expect(list(page).locator("button[data-channel-id]:focus")).toHaveCount(
    1,
  );
  await page.reload();
  await expect(row(page, "dm-031")).toBeVisible();
  await expect(dm).toHaveCount(0);

  // Cached paint is intentionally earlier than fresh live subscription ownership.
  await expect.poll(() => app.relay.hasRoute("primary", "dm-030")).toBe(true);
  app.append("primary", "dm-030", "A new live DM", true, false);
  await expect(dm).toBeVisible();
  await dm.hover();
  await removeDm(page, "dm-030");
  await expect(dm).toHaveCount(0);
  app.append("primary", "dm-030", "A DM missed while closed", false, false);
  await page.reload();
  await expect(row(page, "dm-031")).toBeVisible();
  await expect(dm).toBeVisible();
});

test("channel establishment preserves an in-flight unread batch and its sidebar badges", async ({
  page,
  app,
}) => {
  await holdReadingFocus(page);
  const alphaHeads = () =>
    app.report.queries.filter(
      ({ community, filter }) =>
        community === "primary" &&
        filter["#h"]?.[0] === "alpha" &&
        filter.top_level === true &&
        filter.until === undefined,
    );
  const evidence = () =>
    app.report.queries.filter(
      ({ community, filter }) =>
        community === "primary" &&
        filter.kinds?.includes(9) &&
        filter["#h"]?.length &&
        filter.since !== undefined &&
        filter["#e"] === undefined &&
        filter.top_level === undefined &&
        filter.depth_limit === undefined &&
        filter.until === undefined,
    );
  app.relay.holdEose("alpha");
  app.relay.holdUnread();
  const opening = open(page, app);
  try {
    // Per-channel windows, several requests in flight, all held. Two requests
    // are in flight at once and either may be recorded first; wait until the
    // one carrying Alpha's window is held before establishing the channel.
    await expect
      .poll(() =>
        evidence().some(({ filter }) => filter["#h"]?.[0] === "alpha"),
      )
      .toBe(true);
    expect(app.report.unreadHolds.length).toBeGreaterThan(0);
    await expect.poll(() => alphaHeads().length).toBe(1);

    // Establish only after unread is in flight; observe the real finite catch-up
    // before releasing evidence. No sleep or scheduler luck creates the overlap.
    app.relay.releaseEose("alpha");
    await expect.poll(() => alphaHeads().length).toBe(2);
    expect(app.report.unreadHolds.length).toBeGreaterThan(0);
    for (const hold of app.report.unreadHolds)
      expect(hold).toEqual({ pending: true, aborted: false });
    await opening;
    await expect(row(page, "dm-090")).toHaveCount(1);
    await expect(row(page, "dm-090").getByRole("img")).toHaveCount(0);
    app.relay.releaseUnread();
    await expect(row(page, "dm-030").getByRole("img")).toHaveCount(1);
    await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
    await expect(cue(page, "below")).toBeVisible();
    await expect(cue(page, "below")).toHaveCSS("border-radius", "34px");
    await expect(cue(page, "below").locator("..")).toHaveCSS(
      "border-radius",
      "34px",
    );
    // One window per channel: 130 IDs, no retries.
    await expect.poll(() => evidence().length).toBe(130);
    expect(new Set(evidence().flatMap(({ filter }) => filter["#h"])).size).toBe(
      130,
    );
    for (const hold of app.report.unreadHolds)
      expect(hold).toEqual({ pending: false, aborted: false });
    expect(app.report.readPublications).toEqual([]);
  } finally {
    app.relay.releaseEose("alpha");
    app.relay.releaseUnread();
    await opening;
  }
});

test("edge controls follow scroll and reveal the nearest unread without selection or reads; focus retains existing preparation", async ({
  page,
  app,
}, info) => {
  // This journey measures sidebar intent, never reading the selected channel.
  await holdReadingFocus(page);
  // Visible rows can precede the post-establishment catch-up. Force that late
  // ordering, then account for its head read before measuring cue-triggered work.
  // Release as soon as the first head is sent: the app's live-setup deadline is
  // real time, and a slow runner can take longer than it to render the page.
  app.relay.holdEose("alpha");
  const alphaHeads = () =>
    heads(app).filter(
      ({ community, filter }) =>
        community === "primary" &&
        filter["#h"][0] === "alpha" &&
        filter.top_level === true &&
        filter.until === undefined,
    );
  const opening = open(page, app);
  try {
    await expect.poll(() => alphaHeads().length).toBe(1);
    app.relay.releaseEose("alpha");
    await expect.poll(() => alphaHeads().length).toBe(2);
  } finally {
    app.relay.releaseEose("alpha");
    await opening;
  }
  const ordinary = row(page, "alpha");
  await expect(ordinary).toHaveAttribute("aria-current", "page");
  const ordinaryState = ordinary.locator("[data-channel-unread]");
  const directed = row(page, "dm-090").locator("[data-channel-priority]");
  await expect(ordinaryState).toHaveAttribute("data-priority", "false");
  await expect(ordinaryState).toHaveAttribute(
    "aria-label",
    /observed unread messages/,
  );
  await expect(ordinary.locator("[data-channel-priority]")).toHaveCount(0);
  const ordinaryLabel = ordinary.getByText("Alpha", { exact: true });
  await expect(ordinaryLabel).toHaveCSS("font-weight", "600");
  // A selected unread row keeps its weight and takes the selection's ink, so
  // the label stays readable on the selection fill, hovered or not.
  const unreadInk = await ordinaryLabel.evaluate((label) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-row-selected)";
    label.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(ordinaryLabel).toHaveCSS("color", unreadInk);
  await ordinary.hover();
  await expect(ordinaryLabel).toHaveCSS("color", unreadInk);
  await expect(directed).toBeVisible();
  await expect(directed).toHaveCSS("width", "6px");
  await expect(
    row(page, "dm-090").locator("[data-channel-unread]"),
  ).toHaveAttribute("data-priority", "true");
  await expect(
    row(page, "dm-090").locator("[data-channel-dm-avatar]"),
  ).toHaveCount(0);
  await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await sidebar(page).screenshot({
    path: info.outputPath("sidebar-unread-hierarchy.png"),
  });
  await expect(cue(page, "below")).toBeVisible();
  await expect(cue(page, "below")).toHaveText(/\d+ unread$/);
  await expect(cue(page, "below").locator("..")).toHaveCSS("bottom", "12px");
  await expect(cue(page, "below")).toHaveAccessibleName(
    /^\d+ unread conversations? below$/,
  );
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  const transitionProperties = await cue(page, "below").evaluate((el) =>
    getComputedStyle(el).transitionProperty.split(", "),
  );
  expect(transitionProperties).toEqual(["background-color", "color"]);
  await expectCueHidden(page, "above");
  await releaseReadingFocus(page);
  // Keep actionable DMs below while moving only ordinary unread above: priority
  // is derived from the destinations on each edge, not from the whole roster.
  await scrollRowAbove(page, "alpha");
  await expect.poll(() => inView(page, "alpha")).toBe(false);
  await expect(cue(page, "above")).toBeVisible();
  await expect(cue(page, "above")).toHaveText(/\d+ unread$/);
  await expect(cue(page, "above").locator("..")).toHaveCSS("top", "12px");
  await expect(cue(page, "above")).toHaveAccessibleName(
    /^\d+ unread conversations? above$/,
  );
  await expect(cue(page, "above")).toHaveAttribute("data-attention", "false");
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  // Only attention earns the strong fill; ordinary unread is the quiet cue.
  await expect(cue(page, "above")).toHaveAttribute("data-variant", "subtle");
  await expect(cue(page, "below")).toHaveAttribute("data-variant", "prominent");
  await scroll(page, 0);
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  await scroll(page, 1800);
  await expect(cue(page, "above")).toBeVisible();
  await expect(cue(page, "below")).toBeVisible();
  const before = heads(app).length;
  const size = await list(page).boundingBox();
  await sidebar(page).screenshot({
    path: info.outputPath("sidebar-unread-both.png"),
  });
  await cue(page, "above").focus();
  await cue(page, "above").press("Enter");
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  await expect(row(page, "dm-030")).toBeFocused();
  await expect(row(page, "dm-030")).not.toHaveAttribute("aria-current");
  // The edge cue reveals and focuses without changing the selected conversation.
  await expect(list(page).locator('[aria-current="page"]')).toHaveAttribute(
    "data-channel-id",
    "alpha",
  );
  // Barrier: focusing the revealed row prepares it and requests its head.
  // The owner allows one speculative read with no backlog, so the next reveal
  // may legitimately skip its own read while this one is in flight.
  await expect
    .poll(() =>
      heads(app)
        .slice(before)
        .map(({ filter }) => filter["#h"][0]),
    )
    .toContain("dm-030");
  await cue(page, "below").focus();
  await cue(page, "below").press("Enter");
  await expect.poll(() => inView(page, "dm-090")).toBe(true);
  await expectCueHidden(page, "below");
  expect(await list(page).boundingBox()).toEqual(size); // Overlay never resizes the list.
  const warmed = heads(app)
    .slice(before)
    .map(({ filter }) => filter["#h"][0]);
  // A revealed channel is read at most once. Scroll and cue interactions never
  // add a repeated read.
  expect(new Set(warmed).size).toBe(warmed.length);
  expect(app.report.readPublications).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open("buzz-read-state-v1", 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("partitions", "readonly");
            const read = tx.objectStore("partitions").getAll();
            read.onsuccess = () => resolve(read.result[0].state.frontiers);
            tx.oncomplete = () => db.close();
          };
        }),
    ),
  ).toEqual({});
  // Use the real wheel, too; programmatic reveal and direct gestures share updates.
  await list(page).hover({ position: { x: 5, y: 5 } });
  await page.mouse.wheel(0, -10000);
  await expectCueHidden(page, "above");
  await expect(cue(page, "below")).toBeVisible();
  await page.getByRole("button", { name: "Search Buzz", exact: true }).focus();
  await page.keyboard.press("Tab"); // Set keyboard modality from visible chrome, not an offscreen row.
  await cue(page, "below").focus();
  await expect(cue(page, "below")).toHaveCSS("outline-width", "2px");
  await cue(page, "below").press("Enter");
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  await expect(row(page, "dm-030")).toBeFocused();
  if (info.project.name === "chromium") {
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: /Actions for / });
    await expect(menu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(row(page, "dm-030")).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(row(page, "dm-030")).toHaveAttribute("aria-current", "page");
});

test("resizing, collapsed groups and new unread evidence update only the displayed roster", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
  await expect(cue(page, "below")).toBeVisible();
  // Messages are hidden behind a visible section summary: not below the scroll fold.
  await list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ })
    .click();
  // Channels are collapsed, but unread DMs remain eligible and keep the cue.
  await expect(cue(page, "below")).toBeVisible();
  await list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ })
    .click();
  await cue(page, "below").click();
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  // Collapse the preceding group without scrolling it into view first.
  await list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ })
    .evaluate((el) => el.click());
  await expect(cue(page, "above")).toBeVisible();
  await cue(page, "above").click();
  await expect.poll(() => inView(page, "Beta")).toBe(true);
  await expect(list(page).locator("details").first()).toHaveAttribute(
    "open",
    "",
  );
  const controlledContent = await list(page)
    .locator("details")
    .first()
    .locator("summary")
    .getAttribute("aria-controls");
  await expect(page.locator(`[id="${controlledContent}"]`)).not.toHaveAttribute(
    "inert",
  );
  await expect(row(page, "Beta")).toBeFocused();
  await expect(row(page, "Beta")).toBeEnabled();
  const channelsSummary = list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ });
  await channelsSummary.focus();
  await page.keyboard.press("Tab");
  await expect(
    list(page).getByRole("button", { name: "More actions for Channels" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  // Disabled header actions are skipped; traversal still reaches rows only
  // after the available header controls.
  await expect(row(page, "Alpha")).toBeFocused();
  // A tall viewport makes every row visible; shrinking restores the bottom cue.
  await scroll(page, 0);
  await page.setViewportSize({ width: 1440, height: 6000 });
  await expectCueHidden(page, "below");
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect(cue(page, "below")).toBeVisible();
  await expect(cue(page, "below").locator("..")).not.toHaveAttribute("inert");
  await expect(cue(page, "below").locator("..")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await expect(
    sidebar(page).getByRole("button").and(cue(page, "below")),
  ).toHaveCount(1);
  await cue(page, "below").click();
  await cue(page, "below").click();
  await expectCueHidden(page, "below");
  app.append("primary", "dm-127", "New offscreen unread", false, false);
  // Non-active channels have no live content route. Discover the new evidence
  // through the existing bounded refresh, not by inventing a subscription.
  await openChannelDetails(page);
  await page.getByText("Diagnostics", { exact: true }).click();
  await page.getByText("Unread status", { exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh unread observations", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect(cue(page, "below")).toBeVisible();
  await cue(page, "below").click();
  await expect.poll(() => inView(page, "dm-127")).toBe(true);
  // Source badges disappear on an explicit read, and the edge cue follows.
  await row(page, "dm-127").click();
  await expect(
    page.getByText("New offscreen unread", { exact: true }),
  ).toBeVisible();
  await openChannelDetails(page);
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect(row(page, "dm-127").getByRole("img")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await scroll(page, 2700);
  await expectCueHidden(page, "below");
});

test("session changes discard the previous sidebar targets and manual unread still participates", async ({
  page,
  app,
}) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const pendingRoutes = [];
  // The held read must outlive the app's 10s preference-read budget on slow
  // runners; the test releases it explicitly, so app timeouts are not under test.
  await page.addInitScript(() => {
    AbortSignal.timeout = () => new AbortController().signal;
  });
  await page.route("**/api/relay/secondary/sidebar-preferences", (route) => {
    const pending = held.then(() => route.continue());
    pendingRoutes.push(pending);
    return pending;
  });
  try {
    await open(page, app);
    await expect(cue(page, "below")).toBeVisible();
    await selectCommunity(page, "Secondary");
    await expect(
      page.getByText(/secondary alpha message/).first(),
    ).toBeVisible();
    await expectCueHidden(page, "below");
    await openChannelDetails(page);
    await page.getByText("Diagnostics", { exact: true }).press("Enter");
    await page
      .getByRole("button", { name: "Mark unread on this device", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Close Channel settings tab", exact: true })
      .click();
    await expect.poll(() => pendingRoutes.length).toBeGreaterThan(0);
    const panel = page.getByRole("complementary", {
      name: "Sidebar",
      exact: true,
    });
    await expect(panel).toHaveAttribute("aria-busy", "true");
    // A new session reveals its roster after the bounded startup wait even if
    // preferences are still blocked. Scrolling the empty loading view is a no-op.
    await expect(row(page, "alpha")).toBeVisible();
    await expect(
      page.getByText("Updating sidebar details…", { exact: true }),
    ).toHaveCount(0);
    await scroll(page, 1800);
    await expect(cue(page, "above")).toBeVisible();
    // Completing delayed preferences must not replace the user's newer viewport.
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/relay/secondary/sidebar-preferences") &&
        response.ok(),
    );
    release();
    await refreshed;
    await expect(panel).not.toHaveAttribute("aria-busy", "true");
    expect(await list(page).evaluate((element) => element.scrollTop)).toBe(
      1800,
    );
    await cue(page, "above").click();
    await expect.poll(() => inView(page, "alpha")).toBe(true);
    await expect(
      row(page, "alpha").locator(
        '[data-channel-unread][data-priority="false"]',
      ),
    ).toBeAttached();
  } finally {
    release();
    await Promise.all(pendingRoutes);
    await page.unroute("**/api/relay/secondary/sidebar-preferences");
  }
});

test("priority dots stay aligned and use the prominent mark color in both modes", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const dot = row(page, "dm-030").locator("[data-channel-priority]");
  await expect(dot).toBeAttached();
  // Browser layout must center the visible dot, reserve label space, and keep
  // it inside the inset row highlight at both supported sidebar widths.
  for (const width of [260, 220]) {
    await sidebar(page).evaluate((element, width) => {
      element.closest(".shell-sidebar").style.width = `${width}px`;
    }, width);
    await expect
      .poll(() =>
        dot.evaluate((element) => {
          const button = element.closest("button[data-channel-id]");
          const row = element.closest("[data-channel-sidebar-row]");
          const marker = element.getBoundingClientRect();
          const bounds = button.getBoundingClientRect();
          const fill = getComputedStyle(row, "::before");
          const label = button
            .querySelector(".navigation-item-label")
            .getBoundingClientRect();
          return {
            centered:
              Math.abs(
                marker.top + marker.height / 2 - bounds.top - bounds.height / 2,
              ) < 0.5,
            inset:
              row.getBoundingClientRect().right -
                Number.parseFloat(fill.right) -
                marker.right ===
              10,
            separated: marker.left - label.right >= 6,
          };
        }),
      )
      .toEqual({ centered: true, inset: true, separated: true });
    await row(page, "dm-030").screenshot({
      path: info.outputPath(`priority-dot-${width}.png`),
    });
  }
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    const primary = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.backgroundColor = root.getPropertyValue(
        "--affordance-prominent-mark",
      );
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    await expect(dot).toHaveCSS("background-color", primary);
  }
});

// One small real-app journey owns preview wiring and CSS geometry. The component
// matrix covers deduplication, truncation, fallback and profile refresh separately.
test.describe("DM preview wiring", () => {
  test.use({
    largeSidebar: false,
    dmLabels: true,
    agentPeers: true,
    channelIds: [
      "alpha",
      "beta",
      ...Array.from({ length: 12 }, (_, i) => `padding-${i}`),
    ],
    historyCounts: { alpha: 1, beta: 1 },
    dmMembers: {
      "dm-a": [0],
      "dm-b": [1],
      "dm-c": [2],
      "dm-d": [0],
      "dm-group": [0, 1],
      "dm-self": [],
    },
  });
  test("production sidebar wires only 1:1 avatars and preserves their shape and overlap", async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 1440, height: 500 });
    await open(page, app);
    for (const id of ["dm-a", "dm-b", "dm-c", "dm-d", "dm-group", "dm-self"])
      await expect(
        row(page, id).locator("[data-channel-unread]"),
      ).toBeAttached();
    const below = cue(page, "below");
    await expect(below.locator("[data-unread-dm]")).toHaveCount(3);
    const eligible = new Set(["dm-a", "dm-b", "dm-c", "dm-d"]);
    for (const edge of ["below", "above"]) {
      if (edge === "above")
        await list(page).evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      const pill = cue(page, edge);
      await expect(pill).toBeVisible();
      await expect(pill).toHaveCSS("height", "24px");
      const expected = await list(page).evaluate((nav, edge) => {
        const viewport = nav.getBoundingClientRect();
        const ids = [...nav.querySelectorAll("button[data-channel-id]")]
          .filter((row) =>
            row.querySelector("[data-channel-unread], [data-channel-activity]"),
          )
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return edge === "above"
              ? rect.bottom <= viewport.top
              : rect.top >= viewport.top + nav.clientHeight;
          })
          .map((row) => row.dataset.channelId);
        return edge === "above" ? ids.reverse() : ids;
      }, edge);
      await expect(pill).toHaveAccessibleName(
        `${expected.length} unread conversation${expected.length === 1 ? "" : "s"} ${edge}`,
      );
      const previews = pill.locator("[data-unread-dm]");
      await expect
        .poll(() =>
          previews.evaluateAll((els) => els.map((el) => el.dataset.unreadDm)),
        )
        .toEqual(expected.filter((id) => eligible.has(id)).slice(0, 3));
      await expect(pill.getByRole("img")).toHaveCount(0);
      for (const preview of await previews.all()) {
        const avatar = preview.locator("[data-avatar-shape]");
        await expect(avatar).toHaveCSS("padding", "0px");
        await expect(avatar).toHaveCSS("width", "16px");
        await expect(avatar).toHaveCSS("height", "16px");
      }
    }
    await scroll(page, 0);
    const human = below.locator('[data-unread-dm="dm-a"] [data-avatar-shape]');
    const agent = below.locator('[data-unread-dm="dm-b"] [data-avatar-shape]');
    await expect(human).toHaveAttribute("data-avatar-shape", "circle");
    await expect(human).toHaveCSS("border-radius", "50%");
    await expect(agent).toHaveAttribute("data-avatar-shape", "squircle");
    await expect(agent).toHaveCSS("border-radius", "0px");
    const boxes = await below.locator("[data-unread-dm]").evaluateAll((els) =>
      els.map((el) => {
        const { left, right } = el.getBoundingClientRect();
        return { left, right };
      }),
    );
    expect(boxes[1].left).toBeLessThan(boxes[0].right);
    expect(boxes[2].left).toBeLessThan(boxes[1].right);
  });
});

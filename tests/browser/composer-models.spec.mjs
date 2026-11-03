import { test, expect } from "./source-fixture.mjs";

// Capture transitions at the DOM-change boundary. transitionrun is queued and
// can arrive after a busy renderer has already finished the entrance.
async function holdPickerMotion(page) {
  await page.evaluate(() => {
    new MutationObserver(() => {
      for (const root of document.querySelectorAll(
        '[role="dialog"] [role="group"]',
      )) {
        for (const animation of root.getAnimations({ subtree: true })) {
          animation.pause();
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-starting-style"],
    });
  });
}

// Browser-only: the real portal, Base UI focus handling and CSS Modules.
// The composer unit tests own model discovery and sending the chosen effort.
test("effort picker opens, follows the keyboard and returns focus", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/composer-models.html");
  const trigger = page.getByRole("button", {
    name: "Model and effort for the next run",
  });
  await trigger.click();
  const slider = page.getByRole("slider", {
    name: "Effort for Honey's next run",
  });
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await page.getByRole("dialog").screenshot({
    path: testInfo.outputPath("effort.png"),
  });
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("Solo first-send choices stay selected until explicit reset", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/composer-models.html");
  const trigger = page.getByRole("button", {
    name: "Model and effort for the next run",
  });
  await expect(trigger).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("solo-model-picker-before-selection.png"),
  });
  await trigger.click();
  await page
    .getByRole("button", { name: "Model for Honey's next run" })
    .click();
  await page.getByRole("menuitemradio", { name: "Alternate model" }).click();
  const effort = page.getByRole("slider", {
    name: "Effort for Honey's next run",
  });
  await expect(effort).toHaveAttribute("aria-valuetext", "Medium");
  await effort.focus();
  await page.keyboard.press("ArrowRight");
  await expect(effort).toHaveAttribute("aria-valuetext", "High");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("data-selected", "");

  await trigger.click();
  const popup = page.getByRole("dialog");
  await expect(
    popup.getByRole("button", { name: "Model for Honey's next run" }),
  ).toContainText("Alternate model");
  await expect(effort).toHaveAttribute("aria-valuetext", "High");
  await expect(
    popup.getByRole("button", { name: "Reset model and effort" }),
  ).toBeVisible();
  await popup.screenshot({ path: testInfo.outputPath("solo-first-send.png") });

  await popup.getByRole("button", { name: "Reset model and effort" }).click();
  await expect(trigger).not.toHaveAttribute("data-selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// Browser-only: inherited animated progress, real track geometry and label clamping.
// A DOM emulator cannot catch the fill jumping ahead or the label moving backwards.
test("entrance keeps the fill and delayed model button attached to the handle", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/composer-models.html");
  await holdPickerMotion(page);
  await page
    .getByRole("button", { name: "Model and effort for the next run" })
    .click();
  const slider = page.getByRole("dialog").getByRole("group");
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "Medium",
  );
  const { duration, revealDelay } = await slider.evaluate((root) => {
    const animation = root.getAnimations()[0];
    const reveal = root
      .getAnimations({ subtree: true })
      .find((item) => item.effect.getTiming().delay > 0);
    return {
      duration: animation ? Number(animation.effect.getTiming().duration) : 0,
      revealDelay: reveal?.effect.getTiming().delay ?? 0,
    };
  });
  expect(
    duration,
    "the handle should have an entrance to sample",
  ).toBeGreaterThan(0);
  expect(duration, "the picker should settle promptly").toBeLessThan(300);
  expect(revealDelay).toBeGreaterThan(0);
  expect(revealDelay).toBeLessThan(duration);
  const sample = async (elapsed) =>
    slider.evaluate((root, time) => {
      for (const animation of root.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = time;
      }
      const thumb = root
        .querySelector("[data-rubber-thumb]")
        .getBoundingClientRect();
      const fill = root
        .querySelector("[data-base-ui-slider-indicator]")
        .getBoundingClientRect();
      const track = root
        .querySelector("[data-base-ui-slider-control]")
        .getBoundingClientRect();
      const button = root.querySelector("button");
      const anchor = button.closest('[class*="tetherAnchor"]');
      const label = anchor.getBoundingClientRect();
      return {
        handle: thumb.x + thumb.width / 2,
        handleRight: thumb.right,
        fillRight: fill.right,
        trackLeft: track.left,
        trackRight: track.right,
        thumbWidth: thumb.width,
        labelCenter: label.x + label.width / 2,
        labelWidth: label.width,
        opacity: Number(getComputedStyle(anchor.firstElementChild).opacity),
      };
    }, elapsed);
  const start = await sample(0);
  expect(start.handle - start.trackLeft).toBeCloseTo(start.thumbWidth / 2, 0);
  const beforeReveal = await sample(revealDelay - 1);
  expect(beforeReveal.opacity).toBe(0);
  const moving = await sample((revealDelay + duration) / 2);
  expect(moving.opacity).toBeGreaterThan(0);
  expect(moving.handle).toBeGreaterThan(start.handle);
  for (const frame of [start, beforeReveal, moving]) {
    expect(Math.abs(frame.fillRight - frame.handleRight)).toBeLessThan(1);
    const attached = Math.min(
      frame.trackRight - frame.labelWidth / 2,
      Math.max(frame.trackLeft + frame.labelWidth / 2, frame.handle),
    );
    expect(Math.abs(frame.labelCenter - attached)).toBeLessThan(1);
  }
  await page
    .getByRole("dialog")
    .screenshot({ path: testInfo.outputPath("entrance.png") });
  // Keyboard input interrupts the entrance and immediately shows the selected value.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  await expect
    .poll(async () =>
      slider.evaluate((root) => {
        const thumb = root
          .querySelector("[data-rubber-thumb]")
          .getBoundingClientRect();
        const track = root
          .querySelector("[data-base-ui-slider-control]")
          .getBoundingClientRect();
        return Math.abs(thumb.right - track.right);
      }),
    )
    .toBeLessThan(1);
  await expect(
    page.getByRole("button", { name: "Model for Honey's next run" }),
  ).toBeVisible();
  // Reduced motion has the complete control immediately, even at narrow widths
  // and enlarged interface text; no delayed button or offscreen label.
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 700 });
  await page.addStyleTag({ content: ":root { font-size: 20px; }" });
  await expect(page.locator("html")).toHaveCSS("font-size", "20px");
  await page
    .getByRole("button", { name: "Model and effort for the next run" })
    .click();
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  const reduced = await sample(0);
  expect(reduced.opacity).toBe(1);
  expect(Math.abs(reduced.fillRight - reduced.handleRight)).toBeLessThan(1);
  expect(reduced.labelCenter - reduced.labelWidth / 2).toBeGreaterThanOrEqual(
    reduced.trackLeft - 1,
  );
  expect(reduced.labelCenter + reduced.labelWidth / 2).toBeLessThanOrEqual(
    reduced.trackRight + 1,
  );
  await page.getByRole("dialog").screenshot({
    path: testInfo.outputPath("reduced-motion-narrow.png"),
  });
});

// Switching input modality inside an open popup must not restart its entrance.
test("keyboard-opened picker stays settled when switching to the pointer", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/composer-models.html");
  await holdPickerMotion(page);
  const trigger = page.getByRole("button", {
    name: "Model and effort for the next run",
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const slider = page.getByRole("dialog").getByRole("group");
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "Medium",
  );
  const before = await page.getByRole("slider").locator("..").boundingBox();
  await page.getByRole("heading", { name: "Honey", exact: true }).click();
  // Two frames establish that the modality change has been styled and painted.
  const after = await slider.evaluate(
    (root) =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const thumb = root
              .querySelector("[data-rubber-thumb]")
              .getBoundingClientRect();
            const label = root
              .querySelector("button")
              .closest('[class*="tetherSway"]');
            resolve({
              x: thumb.x,
              opacity: Number(getComputedStyle(label).opacity),
            });
          }),
        );
      }),
  );
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.opacity).toBe(1);
});

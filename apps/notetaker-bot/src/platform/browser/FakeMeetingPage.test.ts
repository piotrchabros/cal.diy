import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeMeetingPage } from "./FakeMeetingPage";

const SELECTOR = "div.composer";

describe("FakeMeetingPage any-frame methods", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps child-frame visibility away from the main-frame methods", async () => {
    const page = new FakeMeetingPage();
    page.setVisibleInChildFrame(SELECTOR);

    expect(await page.isVisible(SELECTOR)).toBe(false);
    expect(await page.waitForVisible(SELECTOR, 0)).toBe(false);
    expect(await page.waitForVisibleInAnyFrame(SELECTOR, 0)).toBe(true);
  });

  it("shows main-frame visibility to both method families", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(SELECTOR);

    expect(await page.isVisible(SELECTOR)).toBe(true);
    expect(await page.waitForVisible(SELECTOR, 0)).toBe(true);
    expect(await page.waitForVisibleInAnyFrame(SELECTOR, 0)).toBe(true);
  });

  it("answers at once with timeoutMs <= 0 when nothing is visible", async () => {
    const page = new FakeMeetingPage();

    expect(await page.waitForVisibleInAnyFrame(SELECTOR, 0)).toBe(false);
  });

  it("releases a pending any-frame waiter when the selector shows in a child frame", async () => {
    const page = new FakeMeetingPage();
    const pending = page.waitForVisibleInAnyFrame(SELECTOR, 10_000);

    page.setVisibleInChildFrame(SELECTOR);

    expect(await pending).toBe(true);
  });

  it("releases pending waiters of both kinds when the selector shows in the main frame", async () => {
    const page = new FakeMeetingPage();
    const mainWaiter = page.waitForVisible(SELECTOR, 10_000);
    const anyWaiter = page.waitForVisibleInAnyFrame(SELECTOR, 10_000);

    page.setVisible(SELECTOR);

    expect(await mainWaiter).toBe(true);
    expect(await anyWaiter).toBe(true);
  });

  it("does not release a main-frame waiter for a child-frame match", async () => {
    vi.useFakeTimers();
    const page = new FakeMeetingPage();
    const mainWaiter = page.waitForVisible(SELECTOR, 1000);

    page.setVisibleInChildFrame(SELECTOR);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await mainWaiter).toBe(false);
  });

  it("resolves a pending any-frame waiter false on timeout", async () => {
    vi.useFakeTimers();
    const page = new FakeMeetingPage();
    const pending = page.waitForVisibleInAnyFrame(SELECTOR, 1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toBe(false);
  });

  it("rejects a pending any-frame waiter when the page closes", async () => {
    const page = new FakeMeetingPage();
    const pending = page.waitForVisibleInAnyFrame(SELECTOR, 10_000);

    page.triggerClosed();

    await expect(pending).rejects.toThrow("page is closed");
  });

  it("records click and fill actions when a frame shows the selector", async () => {
    const page = new FakeMeetingPage();
    page.setVisibleInChildFrame(SELECTOR);

    await page.clickInAnyFrame(SELECTOR);
    await page.fillInAnyFrame(SELECTOR, "hello");

    expect(page.actions).toEqual([
      { type: "clickInAnyFrame", selector: SELECTOR },
      { type: "fillInAnyFrame", selector: SELECTOR, value: "hello" },
    ]);
  });

  it("rejects click and fill when no frame shows the selector", async () => {
    const page = new FakeMeetingPage();

    await expect(page.clickInAnyFrame(SELECTOR)).rejects.toThrow(`no frame shows ${SELECTOR}`);
    await expect(page.fillInAnyFrame(SELECTOR, "hello")).rejects.toThrow(`no frame shows ${SELECTOR}`);
    expect(page.actions).toEqual([]);
  });

  it("reads null, then an empty value, then the filled value", async () => {
    const page = new FakeMeetingPage();
    expect(await page.readValueInAnyFrame(SELECTOR)).toBeNull();

    page.setVisibleInChildFrame(SELECTOR);
    expect(await page.readValueInAnyFrame(SELECTOR)).toBe("");

    await page.fillInAnyFrame(SELECTOR, "hello");
    expect(await page.readValueInAnyFrame(SELECTOR)).toBe("hello");
  });

  it("lets setValue seed the value", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(SELECTOR);
    page.setValue(SELECTOR, "seeded");

    expect(await page.readValueInAnyFrame(SELECTOR)).toBe("seeded");
  });

  it("stores the fill before notifying listeners so a listener can overwrite it", async () => {
    const page = new FakeMeetingPage();
    page.setVisibleInChildFrame(SELECTOR);
    page.onAction((action) => {
      if (action.type === "fillInAnyFrame") page.setValue(action.selector, "overwritten");
    });

    await page.fillInAnyFrame(SELECTOR, "hello");

    expect(await page.readValueInAnyFrame(SELECTOR)).toBe("overwritten");
  });

  it("stores nothing when a fill throws a scripted error", async () => {
    const page = new FakeMeetingPage();
    page.setVisibleInChildFrame(SELECTOR);
    page.setError("fillInAnyFrame", new Error("boom"));

    await expect(page.fillInAnyFrame(SELECTOR, "hello")).rejects.toThrow("boom");

    expect(await page.readValueInAnyFrame(SELECTOR)).toBe("");
  });

  it("rejects all four methods after close", async () => {
    const page = new FakeMeetingPage();
    page.setVisibleInChildFrame(SELECTOR);
    page.triggerClosed();

    await expect(page.waitForVisibleInAnyFrame(SELECTOR, 0)).rejects.toThrow("page is closed");
    await expect(page.clickInAnyFrame(SELECTOR)).rejects.toThrow("page is closed");
    await expect(page.fillInAnyFrame(SELECTOR, "x")).rejects.toThrow("page is closed");
    await expect(page.readValueInAnyFrame(SELECTOR)).rejects.toThrow("page is closed");
  });
});

describe("FakeMeetingPage readElements", () => {
  const TILES = "div.tile";
  const ATTRIBUTES = ["data-id", "class"] as const;

  it("returns only the requested attributes, null for a missing one", async () => {
    const page = new FakeMeetingPage();
    page.setElements(TILES, [{ attributes: { "data-id": "a", extra: "hidden" }, text: "Ada" }]);

    expect(await page.readElements(TILES, ATTRIBUTES, "span")).toEqual([
      { attributes: { "data-id": "a", class: null }, text: "Ada" },
    ]);
  });

  it("returns a null text without an inner selector and for a row without text", async () => {
    const page = new FakeMeetingPage();
    page.setElements(TILES, [{ attributes: { "data-id": "a" }, text: "Ada" }, { attributes: {} }]);

    const withoutInner = await page.readElements(TILES, ATTRIBUTES, null);
    expect(withoutInner.map((row) => row.text)).toEqual([null, null]);
    const withInner = await page.readElements(TILES, ATTRIBUTES, "span");
    expect(withInner.map((row) => row.text)).toEqual(["Ada", null]);
  });

  it("returns an empty list for an unknown selector", async () => {
    const page = new FakeMeetingPage();

    expect(await page.readElements("div.unknown", ATTRIBUTES, null)).toEqual([]);
  });

  it("is not changed by mutating a returned row or the rows given to setElements", async () => {
    const page = new FakeMeetingPage();
    const rows = [{ attributes: { "data-id": "a" as string | null }, text: "Ada" }];
    page.setElements(TILES, rows);

    const first = await page.readElements(TILES, ATTRIBUTES, "span");
    if (first[0]) first[0].attributes["data-id"] = "changed";
    first.pop();
    if (rows[0]) rows[0].attributes["data-id"] = "also changed";
    rows.pop();

    expect(await page.readElements(TILES, ATTRIBUTES, "span")).toEqual([
      { attributes: { "data-id": "a", class: null }, text: "Ada" },
    ]);
  });

  it("rejects after close and when an error is scripted", async () => {
    const page = new FakeMeetingPage();
    page.setElements(TILES, [{}]);
    page.setError("readElements", new Error("method failure"));
    await expect(page.readElements(TILES, ATTRIBUTES, null)).rejects.toThrow("method failure");

    page.setError("readElements", null);
    page.setSelectorError(TILES, new Error("selector failure"));
    await expect(page.readElements(TILES, ATTRIBUTES, null)).rejects.toThrow("selector failure");

    page.setSelectorError(TILES, null);
    await page.close();
    await expect(page.readElements(TILES, ATTRIBUTES, null)).rejects.toThrow("closed");
  });

  it("adds no action", async () => {
    const page = new FakeMeetingPage();
    page.setElements(TILES, [{}]);
    await page.readElements(TILES, ATTRIBUTES, null);

    expect(page.actions).toEqual([]);
  });
});

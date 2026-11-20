// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPageSnapshot, type RawPageSnapshot } from "./pageSnapshot";

type Box = { top: number; left: number; width: number; height: number };

// jsdom does no layout, so each element's box comes from a `data-box="top,left,width,height"` attribute.
function boxOf(element: Element): Box {
  const [top = 0, left = 0, width = 100, height = 20] = (element.getAttribute("data-box") ?? "0,0,100,20")
    .split(",")
    .map(Number);
  return { top, left, width, height };
}

// page.evaluate ships only the function source, so evaluating it detached from this module proves it needs nothing else.
function collectDetached(maxElements = 120, maxTextChars = 6000): RawPageSnapshot {
  const detached = new Function(
    `return (${collectPageSnapshot.toString()});`
  )() as typeof collectPageSnapshot;
  return detached({ maxElements, maxTextChars });
}

describe("collectPageSnapshot", () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const { top, left, width, height } = boxOf(this);
      // jsdom 22 has no DOMRect constructor.
      const rect = { x: left, y: top, top, left, width, height, right: left + width, bottom: top + height };
      return { ...rect, toJSON: () => rect };
    });
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 680, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("is self-contained", () => {
    expect(collectPageSnapshot.toString()).not.toContain("__name");
    expect(() => collectDetached()).not.toThrow();
  });

  it("collects visible interactive elements with roles, names and values", () => {
    document.body.innerHTML = `
      <h1>Plans</h1>
      <a href="/pricing">Pricing</a>
      <button aria-label="Open menu">≡</button>
      <label for="email">Email</label><input id="email" type="email" value="a@b.c">
      <input type="password" placeholder="Password" value="hunter2">
      <input type="checkbox" checked aria-labelledby="remember"><span id="remember">Remember me</span>
      <input type="submit" value="Sign in">
      <select><option>Monthly</option><option selected>Yearly</option></select>
      <div role="tab" aria-selected="true">Overview</div>
      <a href="/img"><img alt="Logo"></a>
      <button disabled title="Save changes"></button>
      <input type="hidden" value="secret-token">
      <button style="display:none">Hidden</button>
      <button data-box="0,0,0,0">Collapsed</button>
    `;

    const result = collectDetached();
    const lines = result.elements.map((entry) => [
      entry.ref,
      entry.role,
      entry.name,
      entry.value,
      entry.checked,
    ]);

    expect(lines).toEqual([
      ["e1", "link", "Pricing", null, null],
      ["e2", "button", "Open menu", null, null],
      ["e3", "textbox", "Email", "a@b.c", null],
      ["e4", "textbox", "Password", null, null],
      ["e5", "checkbox", "Remember me", null, true],
      ["e6", "button", "Sign in", null, null],
      ["e7", "combobox", "", "Yearly", null],
      ["e8", "tab", "Overview", null, true],
      ["e9", "link", "Logo", null, null],
      ["e10", "button", "Save changes", null, null],
    ]);
    expect(result.elements[3]?.inputType).toBe("password");
    expect(result.elements[9]?.disabled).toBe(true);
    expect(result.elements[0]?.href).toBe("http://localhost:3000/pricing");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result.elements)).not.toContain("secret-token");
    expect(result.headings).toEqual([{ level: 1, text: "Plans" }]);
    expect(document.querySelector('[data-ab-ref="e1"]')?.textContent).toBe("Pricing");
  });

  it("lists viewport elements first and caps the element count", () => {
    document.body.innerHTML = `
      <a href="/below" data-box="900,0,100,20">Below</a>
      <a href="/top" data-box="10,0,100,20">Top</a>
      <a href="/above" data-box="-200,0,100,20">Above</a>
      <a href="/middle" data-box="300,0,100,20">Middle</a>
    `;

    const result = collectDetached(3);

    expect(result.elements.map((entry) => [entry.name, entry.inViewport])).toEqual([
      ["Top", true],
      ["Middle", true],
      ["Below", false],
    ]);
    expect(document.querySelectorAll("[data-ab-ref]")).toHaveLength(3);
    expect(document.querySelector('a[href="/above"]')?.hasAttribute("data-ab-ref")).toBe(false);
  });

  it("renumbers refs on every snapshot and clears refs that are no longer assigned", () => {
    document.body.innerHTML = `<a href="/one">One</a><a href="/two">Two</a>`;
    collectDetached();
    document.querySelector('a[href="/one"]')?.remove();

    collectDetached();

    expect(document.querySelector('[data-ab-ref="e1"]')?.textContent).toBe("Two");
    expect(document.querySelector('[data-ab-ref="e2"]')).toBeNull();
  });

  it("returns normalized, capped body text and the scroll position", () => {
    document.body.innerHTML = `<p>  Hello   there  </p>\n\n\n<p>Second line</p>`;
    Object.defineProperty(window, "scrollY", { value: 340, configurable: true });

    const result = collectDetached(120, 15);

    expect(result.text).toBe("Hello there\nSec");
    expect(result.scroll).toEqual({
      y: 340,
      height: document.documentElement.scrollHeight,
      viewportHeight: 680,
    });
  });
});

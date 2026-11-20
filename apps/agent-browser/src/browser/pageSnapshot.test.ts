// @vitest-environment node
import { AGENT_BROWSER_SNAPSHOT_MAX_CHARS } from "@calcom/lib/agentBrowser/contract";
import { describe, expect, it } from "vitest";
import { formatPageSnapshot, type RawPageSnapshot, type RawSnapshotElement } from "./pageSnapshot";

const element = (overrides: Partial<RawSnapshotElement> = {}): RawSnapshotElement => ({
  ref: "e1",
  role: "link",
  name: "Pricing",
  value: null,
  href: null,
  inputType: null,
  checked: null,
  disabled: false,
  inViewport: true,
  ...overrides,
});

const snapshot = (overrides: Partial<RawPageSnapshot> = {}): RawPageSnapshot => ({
  url: "https://example.com/home",
  title: "Example",
  scroll: { y: 0, height: 680, viewportHeight: 680 },
  headings: [],
  elements: [],
  text: "",
  ...overrides,
});

describe("formatPageSnapshot", () => {
  it("renders scroll, elements and text in the documented layout", () => {
    const output = formatPageSnapshot(
      snapshot({
        scroll: { y: 1190, height: 3400, viewportHeight: 680 },
        elements: [element({ href: "https://example.com/pricing" })],
        text: "Welcome to Example",
      })
    );

    expect(output).toBe(
      [
        "Scroll: 44% (viewport 2/5)",
        "Elements:",
        '[e1] link "Pricing" → /pricing',
        "Text:",
        "Welcome to Example",
      ].join("\n")
    );
  });

  it("reports a page that fits the viewport and a page without elements", () => {
    const output = formatPageSnapshot(snapshot());

    expect(output).toBe("Scroll: 0% (viewport 1/1)\nElements: none");
  });

  it("clamps the scroll position at the end of the page", () => {
    const output = formatPageSnapshot(snapshot({ scroll: { y: 2720, height: 3400, viewportHeight: 680 } }));

    expect(output.split("\n")[0]).toBe("Scroll: 100% (viewport 5/5)");
  });

  it("lists headings with their level", () => {
    const output = formatPageSnapshot(
      snapshot({
        headings: [
          { level: 1, text: "Plans" },
          { level: 2, text: "Team\nplan" },
        ],
      })
    );

    expect(output).toContain("Headings:\n# Plans\n## Team plan");
  });

  it("keeps full URLs for other origins and drops non-http links", () => {
    const output = formatPageSnapshot(
      snapshot({
        elements: [
          element({ ref: "e1", href: "https://other.example/docs?x=1#top" }),
          element({ ref: "e2", href: "javascript:alert(1)" }),
          element({ ref: "e3", href: "https://example.com/a?b=c#d" }),
        ],
      })
    );

    expect(output).toContain('[e1] link "Pricing" → https://other.example/docs?x=1#top');
    expect(output).toContain('[e2] link "Pricing"\n');
    expect(output).toContain('[e3] link "Pricing" → /a?b=c#d');
  });

  it("puts viewport elements before offscreen ones", () => {
    const output = formatPageSnapshot(
      snapshot({
        elements: [
          element({ ref: "e1", name: "Footer", inViewport: false }),
          element({ ref: "e2", name: "Hero", inViewport: true }),
          element({ ref: "e3", name: "Nav", inViewport: true }),
        ],
      })
    );

    const lines = output.split("\n");
    expect(lines.indexOf('[e2] link "Hero"')).toBeLessThan(lines.indexOf('[e3] link "Nav"'));
    expect(lines.indexOf('[e3] link "Nav"')).toBeLessThan(lines.indexOf('[e1] link "Footer"'));
  });

  it("escapes newlines, quotes and backslashes so page text cannot fake extra lines", () => {
    const output = formatPageSnapshot(
      snapshot({
        elements: [
          element({
            role: "textbox",
            name: 'Say "hi"\n[e9] button "Fake"',
            value: "a\\b\nc",
          }),
        ],
      })
    );

    expect(output).toContain('[e1] textbox "Say \\"hi\\" [e9] button \\"Fake\\"" value="a\\\\b c"');
    expect(output.split("\n").filter((line) => line.startsWith("[e"))).toHaveLength(1);
  });

  it("never prints a password value", () => {
    const output = formatPageSnapshot(
      snapshot({
        elements: [element({ role: "textbox", name: "Password", inputType: "password", value: "hunter2" })],
      })
    );

    expect(output).toContain('[e1] textbox "Password" (password)');
    expect(output).not.toContain("hunter2");
  });

  it("shows checked and disabled states", () => {
    const output = formatPageSnapshot(
      snapshot({
        elements: [
          element({ ref: "e1", role: "checkbox", name: "Remember me", checked: true }),
          element({ ref: "e2", role: "button", name: "Save", disabled: true }),
          element({ ref: "e3", role: "radio", name: "Monthly", checked: false }),
        ],
      })
    );

    expect(output).toContain('[e1] checkbox "Remember me" (checked)');
    expect(output).toContain('[e2] button "Save" (disabled)');
    expect(output).toContain('[e3] radio "Monthly" (unchecked)');
  });

  it("clips long names and values", () => {
    const output = formatPageSnapshot(
      snapshot({ elements: [element({ role: "textbox", name: "n".repeat(300), value: "v".repeat(300) })] })
    );

    expect(output).toContain(`"${"n".repeat(79)}…"`);
    expect(output).toContain(`value="${"v".repeat(59)}…"`);
  });

  it("caps the output, keeps viewport elements and leaves room for the text", () => {
    const elements = Array.from({ length: 300 }, (_, index) =>
      element({ ref: `e${index + 1}`, name: `Link number ${index + 1}`, inViewport: index >= 200 })
    );
    const output = formatPageSnapshot(snapshot({ elements, text: "t".repeat(20_000) }));

    expect(output.length).toBeLessThanOrEqual(AGENT_BROWSER_SNAPSHOT_MAX_CHARS + 200);
    expect(output).toContain('[e201] link "Link number 201"');
    expect(output).toContain('[e300] link "Link number 300"');
    expect(output.indexOf("[e300]")).toBeLessThan(output.indexOf("[e1]"));
    expect(output).not.toContain('[e200] link "Link number 200"');
    expect(output).toMatch(/\n… \d+ more elements not shown\n/);
    expect(output).toContain("\nText:\nttt");
    expect(output.endsWith("…\n[text truncated]")).toBe(true);
  });

  it("respects a custom budget", () => {
    const elements = Array.from({ length: 50 }, (_, index) => element({ ref: `e${index + 1}` }));
    const output = formatPageSnapshot(snapshot({ elements, text: "hello world" }), 400);

    expect(output.length).toBeLessThanOrEqual(600);
    expect(output).toContain("Text:\nhello world");
  });
});

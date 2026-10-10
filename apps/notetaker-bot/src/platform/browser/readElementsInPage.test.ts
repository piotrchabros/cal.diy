// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readElementsInPage } from "./readElementsInPage";

type InnerStub = { textContent: string | null; rendered: boolean };

interface ElementStub {
  attributes: Record<string, string>;
  inner: InnerStub[];
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): { textContent: string | null; getClientRects(): { length: number } }[];
}

function stubElement(attributes: Record<string, string>, inner: InnerStub[] = []): ElementStub {
  return {
    attributes,
    inner,
    getAttribute: (name) => attributes[name] ?? null,
    querySelectorAll: () =>
      inner.map((entry) => ({
        textContent: entry.textContent,
        getClientRects: () => ({ length: entry.rendered ? 1 : 0 }),
      })),
  };
}

function asElements(stubs: ElementStub[]): Element[] {
  return stubs as unknown as Element[];
}

describe("readElementsInPage", () => {
  it("returns the requested attributes, null for a missing one and nothing else", () => {
    const element = stubElement({ "data-participant-id": "p1", class: "a b", "data-other": "secret" });

    const readings = readElementsInPage(asElements([element]), {
      attributeNames: ["data-participant-id", "class", "data-missing"],
      innerTextSelector: null,
    });

    expect(readings).toEqual([
      { attributes: { "data-participant-id": "p1", class: "a b", "data-missing": null }, text: null },
    ]);
  });

  it("returns the text of the first rendered inner match and skips an earlier one without a layout box", () => {
    const element = stubElement({}, [
      { textContent: "hidden", rendered: false },
      { textContent: "Ada", rendered: true },
      { textContent: "later", rendered: true },
    ]);

    const readings = readElementsInPage(asElements([element]), {
      attributeNames: [],
      innerTextSelector: "span",
    });

    expect(readings).toEqual([{ attributes: {}, text: "Ada" }]);
  });

  it("gives null text when no inner match is rendered", () => {
    const element = stubElement({}, [{ textContent: "hidden", rendered: false }]);

    const readings = readElementsInPage(asElements([element]), {
      attributeNames: [],
      innerTextSelector: "span",
    });

    expect(readings).toEqual([{ attributes: {}, text: null }]);
  });

  it("gives null text and does not query inside the element when the inner selector is null", () => {
    const element = stubElement({}, [{ textContent: "Ada", rendered: true }]);
    const querySelectorAll = vi.spyOn(element, "querySelectorAll");

    const readings = readElementsInPage(asElements([element]), {
      attributeNames: [],
      innerTextSelector: null,
    });

    expect(readings).toEqual([{ attributes: {}, text: null }]);
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it("gives an empty text for a rendered match without text content", () => {
    const element = stubElement({}, [{ textContent: null, rendered: true }]);

    const readings = readElementsInPage(asElements([element]), {
      attributeNames: [],
      innerTextSelector: "span",
    });

    expect(readings).toEqual([{ attributes: {}, text: "" }]);
  });

  it("keeps document order and returns an empty list for no elements", () => {
    const first = stubElement({ id: "1" });
    const second = stubElement({ id: "2" });

    const readings = readElementsInPage(asElements([first, second]), {
      attributeNames: ["id"],
      innerTextSelector: null,
    });

    expect(readings.map((reading) => reading.attributes.id)).toEqual(["1", "2"]);
    expect(readElementsInPage([], { attributeNames: ["id"], innerTextSelector: null })).toEqual([]);
  });

  it("does not trim the text", () => {
    const element = stubElement({}, [{ textContent: "  Ada \n", rendered: true }]);

    const readings = readElementsInPage(asElements([element]), {
      attributeNames: [],
      innerTextSelector: "span",
    });

    expect(readings[0]?.text).toBe("  Ada \n");
  });

  it("never reads markup", () => {
    const source = readElementsInPage.toString();

    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("outerHTML");
  });

  it("contains no nested function, because the page has no keep-names helper", () => {
    const source = readElementsInPage.toString();

    expect(source).not.toContain("__name");
    expect(source).not.toContain("=>");
  });
});

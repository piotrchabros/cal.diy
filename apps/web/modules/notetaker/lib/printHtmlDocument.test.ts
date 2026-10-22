import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printHtmlDocument } from "./printHtmlDocument";

function getIframe(): HTMLIFrameElement {
  const iframe = document.querySelector("iframe");
  if (!iframe) throw new Error("iframe was not appended");
  return iframe;
}

describe("printHtmlDocument", () => {
  let print: ReturnType<typeof vi.fn<() => void>>;
  let fakeWindow: EventTarget & { print: () => void };

  // jsdom loads srcdoc on its own and its window.print is unimplemented, so the iframe gets a fake window and load is dispatched manually.
  beforeEach(() => {
    vi.useFakeTimers();
    print = vi.fn<() => void>();
    fakeWindow = Object.assign(new EventTarget(), { print });
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(
      fakeWindow as unknown as Window
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll("iframe").forEach((iframe) => iframe.remove());
    vi.useRealTimers();
  });

  function loadIframe(iframe: HTMLIFrameElement) {
    iframe.dispatchEvent(new Event("load"));
    return fakeWindow;
  }

  it("appends a hidden sandboxed iframe with the html as srcdoc", () => {
    printHtmlDocument("<p>Hi</p>");

    const iframe = getIframe();
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin allow-modals");
    expect(iframe.srcdoc).toBe("<p>Hi</p>");
    expect(iframe.style.position).toBe("fixed");
    expect(iframe.style.width).toBe("0px");
    expect(iframe.style.height).toBe("0px");
    expect(iframe.style.border).toMatch(/^0/);
  });

  it("prints once the iframe has loaded", () => {
    printHtmlDocument("<p>Hi</p>");
    expect(print).not.toHaveBeenCalled();

    loadIframe(getIframe());

    expect(print).toHaveBeenCalledTimes(1);
  });

  it("removes the iframe after afterprint and ignores the later timeout", () => {
    printHtmlDocument("<p>Hi</p>");
    const iframe = getIframe();
    const contentWindow = loadIframe(iframe);

    contentWindow.dispatchEvent(new Event("afterprint"));
    expect(document.querySelector("iframe")).toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("removes the iframe after the 60 second fallback", () => {
    printHtmlDocument("<p>Hi</p>");

    vi.advanceTimersByTime(59_999);
    expect(document.querySelector("iframe")).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(document.querySelector("iframe")).toBeNull();
  });
});

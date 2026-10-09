import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadTextFile, sanitizeDownloadFilename } from "./downloadTextFile";

describe("sanitizeDownloadFilename", () => {
  it("leaves a plain name unchanged", () => {
    expect(sanitizeDownloadFilename("transcript-2026-01-01.md")).toBe("transcript-2026-01-01.md");
  });

  it.each(["/", "\\", ":", "*", "?", '"', "<", ">", "|"])("replaces %s with a dash", (char) => {
    expect(sanitizeDownloadFilename(`a${char}b.md`)).toBe("a-b.md");
  });

  it("neutralises path traversal attempts", () => {
    expect(sanitizeDownloadFilename("..\\evil.md")).toBe("-evil.md");
    expect(sanitizeDownloadFilename("../../etc/passwd")).toBe("-..-etc-passwd");
  });

  it.each([
    ["NUL", "\u0000"],
    ["newline", "\n"],
    ["tab", "\t"],
    ["DEL", "\u007f"],
  ])("replaces the %s control character with a dash", (_label, char) => {
    expect(sanitizeDownloadFilename(`a${char}b.md`)).toBe("a-b.md");
  });

  it("strips leading dots", () => {
    expect(sanitizeDownloadFilename("...hidden.md")).toBe("hidden.md");
  });

  it("falls back to transcript.md for an empty or dots-only name", () => {
    expect(sanitizeDownloadFilename("")).toBe("transcript.md");
    expect(sanitizeDownloadFilename("...")).toBe("transcript.md");
  });

  it("preserves a non-ASCII name", () => {
    expect(sanitizeDownloadFilename("spotkanie-zażółć.md")).toBe("spotkanie-zażółć.md");
  });
});

// jsdom's Blob has no text()
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("downloadTextFile", () => {
  const stubUrl = "blob:http://localhost/stub";
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");
  let clicked: { href: string; download: string }[] = [];

  beforeEach(() => {
    clicked = [];
    vi.clearAllMocks();
    createObjectURL.mockReturnValue(stubUrl);
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("creates a utf-8 Blob with the content", async () => {
    downloadTextFile({ filename: "a.md", mimeType: "text/markdown", content: "# Hello" });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    expect(await readBlobText(blob)).toBe("# Hello");
  });

  it("clicks a detached anchor with the sanitized name and the object URL", () => {
    const appendChild = vi.spyOn(document.body, "appendChild");

    downloadTextFile({ filename: "a/b.md", mimeType: "text/markdown", content: "x" });

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([{ href: stubUrl, download: "a-b.md" }]);
    expect(appendChild).not.toHaveBeenCalled();
    appendChild.mockRestore();
  });

  it("revokes the same object URL after the click", () => {
    downloadTextFile({ filename: "a.md", mimeType: "text/markdown", content: "x" });

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(stubUrl);
    expect(clickSpy.mock.invocationCallOrder[0]).toBeLessThan(revokeObjectURL.mock.invocationCallOrder[0]);
  });
});

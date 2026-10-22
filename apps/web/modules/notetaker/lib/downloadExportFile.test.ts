import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadExportFile } from "./downloadExportFile";

// jsdom's Blob has no arrayBuffer()
function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(new Uint8Array(reader.result instanceof ArrayBuffer ? reader.result : new ArrayBuffer(0)));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe("downloadExportFile", () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");
  let downloads: string[] = [];

  beforeEach(() => {
    downloads = [];
    vi.clearAllMocks();
    createObjectURL.mockReturnValue("blob:http://localhost/stub");
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
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

  it("downloads utf8 content as a utf-8 text blob", async () => {
    downloadExportFile({
      filename: "a.html",
      mimeType: "text/html",
      encoding: "utf8",
      content: "<p>zażółć</p>",
    });

    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("text/html;charset=utf-8");
    const bytes = await readBlobBytes(blob);
    expect(new TextDecoder().decode(bytes)).toBe("<p>zażółć</p>");
    expect(downloads).toEqual(["a.html"]);
  });

  it("decodes base64 content into the original bytes", async () => {
    const original = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const content = btoa(String.fromCharCode.apply(null, Array.from(original)));

    downloadExportFile({ filename: "a.pdf", mimeType: "application/pdf", encoding: "base64", content });

    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/pdf");
    expect(Array.from(await readBlobBytes(blob))).toEqual(Array.from(original));
    expect(downloads).toEqual(["a.pdf"]);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("sanitises the filename for both encodings", () => {
    downloadExportFile({ filename: "a/b.md", mimeType: "text/markdown", encoding: "utf8", content: "x" });
    downloadExportFile({
      filename: "../c.pdf",
      mimeType: "application/pdf",
      encoding: "base64",
      content: "eA==",
    });

    expect(downloads).toEqual(["a-b.md", "-c.pdf"]);
  });
});

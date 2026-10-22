import type { INotetakerPdfRenderer } from "../lib/export/INotetakerPdfRenderer";
import type { NotetakerExportDocument } from "../lib/exportDocument";

export const FAKE_PDF_CONTENT = "%PDF-1.4 test";

export class FakeNotetakerPdfRenderer implements INotetakerPdfRenderer {
  documents: NotetakerExportDocument[] = [];
  bytes: Uint8Array = new TextEncoder().encode(FAKE_PDF_CONTENT);
  failure: Error | null = null;

  async render(document: NotetakerExportDocument): Promise<Uint8Array> {
    this.documents.push(document);
    if (this.failure) throw this.failure;
    return this.bytes;
  }
}

import type { NotetakerExportDocument } from "../exportDocument";

export interface INotetakerPdfRenderer {
  render(document: NotetakerExportDocument): Promise<Uint8Array>;
}

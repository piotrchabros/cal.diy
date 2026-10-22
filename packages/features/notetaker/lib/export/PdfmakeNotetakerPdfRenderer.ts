import type PdfPrinter from "pdfmake";
import type { TDocumentDefinitions, TFontDictionary } from "pdfmake/interfaces";
import type { NotetakerExportDocument } from "../exportDocument";
import { buildNotetakerPdfDefinition } from "./exportPdfDefinition";
import type { INotetakerPdfRenderer } from "./INotetakerPdfRenderer";

export class PdfmakeNotetakerPdfRenderer implements INotetakerPdfRenderer {
  private printer: Promise<PdfPrinter> | null = null;

  async render(document: NotetakerExportDocument): Promise<Uint8Array> {
    const printer = await this.getPrinter();
    const definition: TDocumentDefinitions = {
      ...buildNotetakerPdfDefinition(document),
      footer: (currentPage, pageCount) => ({
        text: `${currentPage} / ${pageCount}`,
        alignment: "center",
        fontSize: 8,
        color: "#6b7280",
        margin: [0, 12, 0, 0],
      }),
    };
    const pdf = printer.createPdfKitDocument(definition);

    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = [];
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
      pdf.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      pdf.on("error", reject);
      pdf.end();
    });
  }

  private getPrinter(): Promise<PdfPrinter> {
    // Loaded on first use so pdfmake and its embedded fonts stay out of every other code path. The promise
    // is cached so concurrent first renders decode the fonts once, and dropped on failure so a later call retries.
    this.printer ??= loadPrinter().catch((error: unknown) => {
      this.printer = null;
      throw error;
    });
    return this.printer;
  }
}

async function loadPrinter(): Promise<PdfPrinter> {
  const [{ default: Printer }, { default: vfs }] = await Promise.all([
    import("pdfmake"),
    import("pdfmake/build/vfs_fonts"),
  ]);
  const font = (file: string): Buffer => {
    const data = vfs[file];
    if (data === undefined) throw new Error(`Notetaker PDF font ${file} is missing from the pdfmake vfs`);
    return Buffer.from(data, "base64");
  };
  const fonts: TFontDictionary = {
    Roboto: {
      normal: font("Roboto-Regular.ttf"),
      bold: font("Roboto-Medium.ttf"),
      italics: font("Roboto-Italic.ttf"),
      bolditalics: font("Roboto-MediumItalic.ttf"),
    },
  };
  return new Printer(fonts);
}

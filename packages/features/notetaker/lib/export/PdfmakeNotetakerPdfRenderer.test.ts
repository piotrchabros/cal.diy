import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import vfs from "pdfmake/build/vfs_fonts";
import { describe, expect, it } from "vitest";
import type { NotetakerExportDocument, NotetakerExportTopic } from "../exportDocument";
import { PdfmakeNotetakerPdfRenderer } from "./PdfmakeNotetakerPdfRenderer";

const POLISH = "Zażółć gęślą jaźń. Łódź, Świętokrzyskie, Ćma, Ńa";
const POLISH_LETTERS = "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ";
const SAMPLE_PATH =
  "/tmp/claude-0/-root-cal-diy/b9f22750-aa6b-4262-a6b9-4b66e538126d/scratchpad/notetaker-sample.pdf";

type FontkitFont = { hasGlyphForCodePoint(codePoint: number): boolean };

// fontkit ships no types and is not a direct dependency; it is the font engine pdfkit embeds the vfs fonts with.
const fontkit: { create(buffer: Buffer): FontkitFont } = createRequire(import.meta.url)(
  "@foliojs-fork/fontkit"
);

const pdfHeader = (pdf: Uint8Array): string => Buffer.from(pdf.subarray(0, 5)).toString("latin1");

const buildDoc = (overrides: Partial<NotetakerExportDocument> = {}): NotetakerExportDocument => ({
  title: "Planning call",
  startLine: "Monday, October 12, 2026 at 10:00 AM",
  lang: "en",
  notes: [],
  summaryHeading: "Summary",
  summary: [{ kind: "paragraph", heading: "Overview", text: "We planned the launch." }],
  noSummary: "No summary is available for this meeting.",
  transcriptHeading: "Transcript",
  transcript: [{ timestamp: "00:00:01", speaker: "Alex", text: "Hello everyone" }],
  ...overrides,
});

const SPEAKERS = ["Łukasz Żółkiewski", "Agnieszka Ślęzak", "Bartosz Ćwik"];

const passages = (count: number): NotetakerExportDocument["transcript"] =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: `${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`,
    speaker: SPEAKERS[index % SPEAKERS.length],
    text: `${POLISH} Omawiamy punkt ${index + 1}: harmonogram wdrożenia, budżet i ryzyka związane z dostawcą.`,
  }));

const sampleTopics: NotetakerExportTopic[] = [
  {
    title: "Opóźnienie dostawy serwerów",
    category: "PROBLEM",
    categoryLabel: "Problem",
    details: ["Dostawca przesunął termin o trzy tygodnie", "Ryzyko dla migracji w Łodzi"],
  },
  {
    title: "Błędy w module płatności",
    category: "PROBLEM",
    categoryLabel: "Problem",
    details: ["Zgłoszenia od klientów ze Śląska", "Podejrzenie problemu z kodowaniem znaków ąę"],
  },
  {
    title: "Postęp prac nad aplikacją mobilną",
    category: "UPDATE",
    categoryLabel: "Aktualizacja",
    details: ["Wersja beta gotowa w 80%", "Testy na urządzeniach z Androidem trwają"],
  },
  {
    title: "Rekrutacja do zespołu",
    category: "UPDATE",
    categoryLabel: "Aktualizacja",
    details: ["Dwie osoby zaczynają w przyszłym miesiącu"],
  },
  {
    title: "Wybór dostawcy chmury",
    category: "DECISION",
    categoryLabel: "Decyzja",
    details: ["Zostajemy przy obecnym dostawcy do końca roku", "Ponowna ocena w styczniu"],
  },
  {
    title: "Budżet marketingowy",
    category: "DECISION",
    categoryLabel: "Decyzja",
    details: ["Zwiększenie o 15% na kampanię jesienną"],
  },
  {
    title: "Szkolenia wewnętrzne",
    category: null,
    categoryLabel: null,
    details: ["Propozycja cyklu warsztatów z bezpieczeństwa"],
  },
  {
    title: "Spotkanie świąteczne",
    category: "UPDATE",
    categoryLabel: "Aktualizacja",
    details: ["Rezerwacja sali w Świętokrzyskiem potwierdzona", "Zbieramy pomysły na atrakcje"],
  },
];

const sampleDoc = (): NotetakerExportDocument =>
  buildDoc({
    title: "Cotygodniowe spotkanie zespołu — Łódź",
    startLine: "środa, 21 października 2026 o 10:00",
    lang: "pl",
    notes: ["Nazwy mówców nie były dostępne dla części nagrania."],
    summaryHeading: "Podsumowanie",
    summary: [
      {
        kind: "paragraph",
        heading: "Przegląd",
        text: "Zespół omówił opóźnienia dostaw, postęp prac nad aplikacją i decyzje budżetowe.",
      },
      {
        kind: "list",
        heading: "Kluczowe ustalenia",
        items: ["Migracja przesunięta o trzy tygodnie", "Beta aplikacji mobilnej w listopadzie"],
      },
      {
        kind: "groups",
        heading: "Kolejne kroki",
        groups: [
          {
            heading: "Łukasz Żółkiewski",
            items: ["Skontaktować się z dostawcą", "Przygotować plan awaryjny"],
          },
          { heading: "Nieprzypisane", items: ["Zarezerwować salę na warsztaty"] },
        ],
      },
      { kind: "topics", heading: "Kluczowe tematy", topics: sampleTopics },
    ],
    transcriptHeading: "Transkrypcja",
    transcript: passages(50),
  });

describe("PdfmakeNotetakerPdfRenderer", () => {
  it("renders a PDF document", async () => {
    const pdf = await new PdfmakeNotetakerPdfRenderer().render(buildDoc());
    expect(pdfHeader(pdf)).toBe("%PDF-");
  });

  it("embeds Roboto variants with glyphs for every Polish letter", () => {
    const files = ["Roboto-Regular.ttf", "Roboto-Medium.ttf", "Roboto-Italic.ttf", "Roboto-MediumItalic.ttf"];
    for (const file of files) {
      const font = fontkit.create(Buffer.from(vfs[file], "base64"));
      const missing = Array.from(POLISH_LETTERS).filter(
        (letter) => !font.hasGlyphForCodePoint(letter.codePointAt(0) ?? 0)
      );
      expect({ file, missing }).toEqual({ file, missing: [] });
    }
  });

  it("renders Polish text and a summary with every topic category", async () => {
    const renderer = new PdfmakeNotetakerPdfRenderer();
    const pdf = await renderer.render(sampleDoc());
    expect(pdfHeader(pdf)).toBe("%PDF-");
    expect(pdfHeader(await renderer.render(buildDoc({ title: POLISH })))).toBe("%PDF-");

    if (process.env.NOTETAKER_PDF_SAMPLE === "1") writeFileSync(SAMPLE_PATH, pdf);
  });

  it("renders 5,000 transcript passages within time and size limits", { timeout: 30_000 }, async () => {
    const startedAt = performance.now();
    const pdf = await new PdfmakeNotetakerPdfRenderer().render(buildDoc({ transcript: passages(5000) }));
    const elapsedMs = performance.now() - startedAt;

    expect(pdfHeader(pdf)).toBe("%PDF-");
    expect(elapsedMs).toBeLessThan(15_000);
    expect(pdf.byteLength).toBeLessThan(10 * 1024 * 1024);
  });
});

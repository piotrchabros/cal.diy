import type { ElementReading } from "./MeetingPage";

export type ReadElementsArgs = { attributeNames: string[]; innerTextSelector: string | null };

// Runs inside the page: Playwright serialises it with toString(), so it must not reference anything outside itself.
// tsx wraps nested named functions in a `__name` helper that the page lacks, hence plain loops and no inner functions.
export function readElementsInPage(elements: Element[], args: ReadElementsArgs): ElementReading[] {
  const readings: ElementReading[] = [];
  for (const element of elements) {
    const attributes: Record<string, string | null> = {};
    for (const name of args.attributeNames) {
      attributes[name] = element.getAttribute(name);
    }
    let text: string | null = null;
    if (args.innerTextSelector !== null) {
      const candidates = element.querySelectorAll(args.innerTextSelector);
      for (const candidate of candidates) {
        if (candidate.getClientRects().length > 0) {
          text = candidate.textContent ?? "";
          break;
        }
      }
    }
    readings.push({ attributes, text });
  }
  return readings;
}

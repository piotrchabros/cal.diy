import type { NotetakerSummaryTopicCategoryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerExportDocument, NotetakerExportSection, NotetakerExportTopic } from "./exportDocument";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const BADGE_CLASS: Record<NotetakerSummaryTopicCategoryDto, string> = {
  PROBLEM: "badge badge-problem",
  UPDATE: "badge badge-update",
  DECISION: "badge badge-decision",
};

const STYLES = `
:root { color-scheme: light; }
body { margin: 0; background: #ffffff; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 16px; line-height: 1.6; }
main { max-width: 800px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 28px; line-height: 1.25; margin: 0 0 4px; }
h2 { font-size: 22px; margin: 32px 0 12px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }
h3 { font-size: 18px; margin: 24px 0 8px; }
h4 { font-size: 16px; margin: 16px 0 4px; }
p { margin: 0 0 12px; }
ul { margin: 0 0 12px; padding-left: 24px; }
.meta { color: #4b5563; }
.note { padding: 8px 12px; border-left: 4px solid #d1d5db; background: #f9fafb; color: #374151; }
.topic { margin: 0 0 16px; }
.topic h4 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 9999px; color: #ffffff; font-size: 12px; font-weight: 600; line-height: 1.6; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.badge-problem { background: #dc2626; }
.badge-update { background: #2563eb; }
.badge-decision { background: #16a34a; }
.transcript { list-style: none; margin: 0; padding: 0; }
.transcript li { margin: 0 0 12px; }
.timestamp { color: #6b7280; font-variant-numeric: tabular-nums; margin-right: 6px; }
@page { margin: 18mm 16mm; }
@media print {
  body { font-size: 12pt; }
  main { max-width: none; padding: 0; }
  .topic, .transcript li { break-inside: avoid; }
  h2, h3, h4 { break-after: avoid; }
}
`;

// Every string in the document can come from meeting participants or the model, so each text node and
// attribute is escaped; the CSP meta is a second line of defence for viewers that open the file directly.
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

const renderList = (items: string[]): string =>
  `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;

function renderTopic(topic: NotetakerExportTopic): string {
  const badge =
    topic.category === null || topic.categoryLabel === null
      ? ""
      : ` <span class="${BADGE_CLASS[topic.category]}">${escapeHtml(topic.categoryLabel)}</span>`;
  const details = topic.details.length > 0 ? renderList(topic.details) : "";
  return `<section class="topic"><h4>${escapeHtml(topic.title)}${badge}</h4>${details}</section>`;
}

function renderSection(section: NotetakerExportSection): string {
  const heading = `<h3>${escapeHtml(section.heading)}</h3>`;
  switch (section.kind) {
    case "paragraph":
      return `${heading}<p>${escapeHtml(section.text)}</p>`;
    case "list":
      return `${heading}${renderList(section.items)}`;
    case "groups":
      return `${heading}${section.groups
        .map((group) => `<h4>${escapeHtml(group.heading)}</h4>${renderList(group.items)}`)
        .join("")}`;
    case "topics":
      return `${heading}${section.topics.map(renderTopic).join("")}`;
  }
}

export function renderNotetakerHtml(doc: NotetakerExportDocument): string {
  const notes = doc.notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join("");
  const summary =
    doc.summary === null ? `<p>${escapeHtml(doc.noSummary)}</p>` : doc.summary.map(renderSection).join("");
  const passages = doc.transcript
    .map(
      (passage) =>
        `<li><span class="timestamp">[${escapeHtml(passage.timestamp)}]</span> <strong>${escapeHtml(
          passage.speaker
        )}:</strong> ${escapeHtml(passage.text)}</li>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="${escapeHtml(doc.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(doc.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<header>
<h1>${escapeHtml(doc.title)}</h1>
<p class="meta">${escapeHtml(doc.startLine)}</p>
${notes}
</header>
<section>
<h2>${escapeHtml(doc.summaryHeading)}</h2>
${summary}
</section>
<section>
<h2>${escapeHtml(doc.transcriptHeading)}</h2>
<ol class="transcript">
${passages}
</ol>
</section>
</main>
</body>
</html>
`;
}

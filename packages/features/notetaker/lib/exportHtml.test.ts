import { describe, expect, it } from "vitest";
import type { NotetakerExportDocument, NotetakerExportTopic } from "./exportDocument";
import { renderNotetakerHtml } from "./exportHtml";

const XSS = `<script>alert("x")</script><img src=x onerror='alert(1)'>&`;
const XSS_ESCAPED =
  "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;";

const topics: NotetakerExportTopic[] = [
  {
    title: "Pricing",
    category: "PROBLEM",
    categoryLabel: "Problem",
    details: ["Too expensive", "Competitors are cheaper"],
  },
  { title: "Roadmap", category: "UPDATE", categoryLabel: "Update", details: ["Beta in June"] },
  { title: "Vendor", category: "DECISION", categoryLabel: "Decision", details: ["Go with Acme"] },
  { title: "Misc", category: null, categoryLabel: null, details: ["Lunch"] },
];

const buildDoc = (overrides: Partial<NotetakerExportDocument> = {}): NotetakerExportDocument => ({
  title: "Planning call",
  startLine: "Monday, October 12, 2026 at 10:00 AM",
  lang: "en",
  notes: [],
  summaryHeading: "Summary",
  summary: [
    { kind: "paragraph", heading: "Overview", text: "We planned the launch." },
    { kind: "list", heading: "Key findings and agreements", items: ["Launch in May"] },
    {
      kind: "groups",
      heading: "Next steps",
      groups: [
        { heading: "Alex", items: ["Send the notes"] },
        { heading: "Unassigned", items: ["Book a room"] },
      ],
    },
    { kind: "topics", heading: "Key topics", topics },
  ],
  noSummary: "No summary is available for this meeting.",
  transcriptHeading: "Transcript",
  transcript: [{ timestamp: "00:00:01", speaker: "Alex", text: "Hello everyone" }],
  ...overrides,
});

describe("renderNotetakerHtml", () => {
  it("renders a standalone document with a restrictive CSP and no scripts", () => {
    const html = renderNotetakerHtml(buildDoc());
    expect(html.startsWith("<!doctype html>\n")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    );
    expect(html).toContain("<title>Planning call</title>");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toContain("<details");
  });

  it("sets the lang attribute from the document", () => {
    expect(renderNotetakerHtml(buildDoc({ lang: "pl" }))).toContain('<html lang="pl">');
    expect(renderNotetakerHtml(buildDoc({ lang: `en" onload="x` }))).toContain(
      '<html lang="en&quot; onload=&quot;x">'
    );
  });

  it("includes print rules", () => {
    const html = renderNotetakerHtml(buildDoc());
    expect(html).toContain("@page");
    expect(html).toContain("@media print");
    expect(html).toContain("break-inside: avoid");
    expect(html).toContain("print-color-adjust: exact");
    expect(html).toContain("-webkit-print-color-adjust: exact");
  });

  it("renders sections in order with every topic label and detail", () => {
    const html = renderNotetakerHtml(buildDoc());
    const order = ["Overview", "Key findings and agreements", "Next steps", "Key topics", "Transcript"].map(
      (heading) => html.indexOf(heading)
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(html).toContain('<span class="badge badge-problem">Problem</span>');
    expect(html).toContain('<span class="badge badge-update">Update</span>');
    expect(html).toContain('<span class="badge badge-decision">Decision</span>');
    expect(html).toContain("<h4>Misc</h4>");
    for (const topic of topics) {
      for (const detail of topic.details) expect(html).toContain(`<li>${detail}</li>`);
    }
    expect(html).toContain("#dc2626");
    expect(html).toContain("#2563eb");
    expect(html).toContain("#16a34a");
  });

  it("renders owner groups and transcript passages", () => {
    const html = renderNotetakerHtml(buildDoc());
    expect(html).toContain("<h4>Alex</h4><ul><li>Send the notes</li></ul><h4>Unassigned</h4>");
    expect(html).toContain(
      '<li><span class="timestamp">[00:00:01]</span> <strong>Alex:</strong> Hello everyone</li>'
    );
  });

  it("renders notes and the no-summary line", () => {
    const html = renderNotetakerHtml(buildDoc({ notes: ["Cut off."], summary: null }));
    expect(html).toContain('<p class="note">Cut off.</p>');
    expect(html).toContain("<p>No summary is available for this meeting.</p>");
    expect(html).not.toContain("<h3>");
  });

  it("renders a version 1 summary", () => {
    const html = renderNotetakerHtml(
      buildDoc({
        summary: [
          { kind: "list", heading: "Key points", items: ["Launch in May"] },
          { kind: "list", heading: "Decisions", items: ["Ship v2"] },
          { kind: "groups", heading: "Action items", groups: [{ heading: "Alex", items: ["Send"] }] },
        ],
      })
    );
    expect(html).toContain("<h3>Decisions</h3><ul><li>Ship v2</li></ul>");
    expect(html).toContain("<h3>Action items</h3><h4>Alex</h4><ul><li>Send</li></ul>");
    expect(html).not.toContain('badge-problem">');
  });

  it("escapes every dynamic string", () => {
    const sites: Partial<NotetakerExportDocument>[] = [
      { title: XSS },
      { startLine: XSS },
      { notes: [XSS] },
      { transcript: [{ timestamp: "00:00:00", speaker: XSS, text: "hi" }] },
      { transcript: [{ timestamp: "00:00:00", speaker: "Alex", text: XSS }] },
      { summary: [{ kind: "paragraph", heading: "Overview", text: XSS }] },
      { summary: [{ kind: "list", heading: "Key points", items: [XSS] }] },
      { summary: [{ kind: "groups", heading: "Next steps", groups: [{ heading: XSS, items: [XSS] }] }] },
      {
        summary: [
          {
            kind: "topics",
            heading: "Key topics",
            topics: [{ title: XSS, category: "PROBLEM", categoryLabel: XSS, details: [XSS] }],
          },
        ],
      },
    ];
    for (const overrides of sites) {
      const html = renderNotetakerHtml(buildDoc(overrides));
      expect(html).toContain(XSS_ESCAPED);
      expect(html).not.toContain(XSS);
      expect(html.toLowerCase()).not.toContain("<script");
      expect(html).not.toContain("<img");
    }
  });
});

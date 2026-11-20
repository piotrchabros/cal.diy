import { AGENT_BROWSER_SNAPSHOT_MAX_CHARS } from "@calcom/lib/agentBrowser/contract";

const AGENT_BROWSER_SNAPSHOT_MAX_ELEMENTS = 120;
// collectPageSnapshot repeats this literal because it cannot read module scope inside the page.
const SNAPSHOT_REF_ATTRIBUTE = "data-ab-ref";

const MAX_NAME_CHARS = 80;
const MAX_VALUE_CHARS = 60;
const MAX_HREF_CHARS = 100;
const MAX_HEADING_CHARS = 120;
const MAX_HEADINGS = 10;
// Elements are listed before the text, so without a reserve a link-heavy page would leave no room for the text.
const TEXT_SHARE_OF_BUDGET = 0.25;

type CollectPageSnapshotOptions = { maxElements: number; maxTextChars: number };

type RawSnapshotElement = {
  ref: string;
  role: string;
  name: string;
  value: string | null;
  href: string | null;
  inputType: string | null;
  checked: boolean | null;
  disabled: boolean;
  inViewport: boolean;
};

type RawPageSnapshot = {
  url: string;
  title: string;
  scroll: { y: number; height: number; viewportHeight: number };
  headings: Array<{ level: number; text: string }>;
  elements: RawSnapshotElement[];
  text: string;
};

const DEFAULT_COLLECT_OPTIONS: CollectPageSnapshotOptions = {
  maxElements: AGENT_BROWSER_SNAPSHOT_MAX_ELEMENTS,
  maxTextChars: AGENT_BROWSER_SNAPSHOT_MAX_CHARS,
};

// Runs inside the page via `page.evaluate(collectPageSnapshot, options)`, which serializes only this function's
// source. It must not reference anything from module scope, and it declares no named inner functions or arrow
// constants: tsx compiles with keepNames, which would wrap those in an `__name` helper the page does not have.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: runs in the page as one serialized function, so it cannot be split into helpers
function collectPageSnapshot(options: CollectPageSnapshotOptions): RawPageSnapshot {
  const refAttribute = "data-ab-ref";
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[contenteditable]:not([contenteditable="false"])',
  ].join(",");
  const maxNameChars = 200;

  // Refs are renumbered on every snapshot; dropping the old ones makes a ref from an earlier snapshot fail as stale
  // instead of silently hitting whichever element now carries that number.
  for (const stale of Array.from(document.querySelectorAll(`[${refAttribute}]`))) {
    stale.removeAttribute(refAttribute);
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const inViewportCandidates: HTMLElement[] = [];
  const offscreenCandidates: HTMLElement[] = [];

  for (const node of Array.from(document.querySelectorAll(interactiveSelector))) {
    if (!(node instanceof HTMLElement)) continue;
    if (node instanceof HTMLInputElement && node.type === "hidden") continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

    const inViewport =
      rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
    (inViewport ? inViewportCandidates : offscreenCandidates).push(node);
  }

  const selected = inViewportCandidates.concat(offscreenCandidates).slice(0, options.maxElements);
  const elements: RawSnapshotElement[] = [];

  for (const [index, element] of selected.entries()) {
    const ref = `e${index + 1}`;
    element.setAttribute(refAttribute, ref);

    const tag = element.tagName.toLowerCase();
    const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : null;
    const buttonLikeInput = inputType === "submit" || inputType === "button" || inputType === "reset";
    const toggleInput = inputType === "checkbox" || inputType === "radio";

    let role = element.getAttribute("role") ?? "";
    if (!role) {
      if (tag === "a") role = "link";
      else if (tag === "button" || tag === "summary" || buttonLikeInput || inputType === "image")
        role = "button";
      else if (toggleInput && inputType) role = inputType;
      else if (tag === "select") role = "combobox";
      else role = "textbox";
    }

    let name = element.getAttribute("aria-label") ?? "";
    const labelledBy = element.getAttribute("aria-labelledby");
    if (!name.trim() && labelledBy) {
      name = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    }
    if (
      !name.trim() &&
      (element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement) &&
      element.labels
    ) {
      name = Array.from(element.labels)
        .map((label) => label.innerText ?? label.textContent ?? "")
        .join(" ");
    }
    if (!name.trim() && element instanceof HTMLInputElement && buttonLikeInput) name = element.value;
    if (!name.trim() && tag !== "select" && tag !== "textarea" && tag !== "input") {
      // jsdom has no innerText; textContent keeps the extractor testable there.
      name = element.innerText ?? element.textContent ?? "";
    }
    if (!name.trim()) name = element.getAttribute("placeholder") ?? "";
    if (!name.trim()) {
      name = element.getAttribute("alt") ?? element.querySelector("img[alt]")?.getAttribute("alt") ?? "";
    }
    if (!name.trim()) name = element.getAttribute("title") ?? "";
    name = name.replace(/\s+/g, " ").trim().slice(0, maxNameChars);

    let value: string | null = null;
    if (element instanceof HTMLInputElement && !toggleInput && !buttonLikeInput && inputType !== "password") {
      value = element.value;
    } else if (element instanceof HTMLTextAreaElement) {
      value = element.value;
    } else if (element instanceof HTMLSelectElement) {
      value = element.selectedOptions[0]?.textContent ?? "";
    }
    if (value !== null) value = value.slice(0, maxNameChars);

    let checked: boolean | null = null;
    if (element instanceof HTMLInputElement && toggleInput) checked = element.checked;
    else if (role === "checkbox" || role === "tab") {
      const state = element.getAttribute(role === "tab" ? "aria-selected" : "aria-checked");
      if (state !== null) checked = state === "true";
    }

    const href = element instanceof HTMLAnchorElement && element.href ? element.href : null;
    const disabled = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

    elements.push({
      ref,
      role,
      name,
      value,
      href,
      inputType,
      checked,
      disabled,
      inViewport: index < inViewportCandidates.length,
    });
  }

  const headings: Array<{ level: number; text: string }> = [];
  for (const heading of Array.from(document.querySelectorAll("h1, h2, h3"))) {
    if (!(heading instanceof HTMLElement)) continue;
    const rect = heading.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const text = (heading.innerText ?? heading.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) headings.push({ level: Number(heading.tagName.slice(1)), text: text.slice(0, maxNameChars) });
    if (headings.length >= 30) break;
  }

  const body = document.body;
  const bodyText = body ? (body.innerText ?? body.textContent ?? "") : "";
  const text = bodyText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, options.maxTextChars);

  return {
    url: window.location.href,
    title: document.title,
    scroll: {
      y: window.scrollY,
      height: document.documentElement.scrollHeight,
      viewportHeight,
    },
    headings,
    elements,
    text,
  };
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

// Names and values come from the page, so a newline or quote inside one must not be able to fake an extra line.
function quote(value: string, maxChars: number): string {
  const singleLine = clip(value.replace(/\s+/g, " ").trim(), maxChars);
  return `"${singleLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatHref(href: string, pageUrl: string): string | null {
  if (!URL.canParse(href)) return null;
  const target = new URL(href);
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  const sameOrigin = URL.canParse(pageUrl) && new URL(pageUrl).origin === target.origin;
  const shown = sameOrigin ? `${target.pathname}${target.search}${target.hash}` : target.href;
  return clip(shown.replace(/\s+/g, ""), MAX_HREF_CHARS);
}

function formatScroll(scroll: RawPageSnapshot["scroll"]): string {
  const viewportHeight = Math.max(1, scroll.viewportHeight);
  const scrollable = scroll.height - viewportHeight;
  if (scrollable <= 0) return "Scroll: 0% (viewport 1/1)";

  const percent = Math.round((Math.min(Math.max(scroll.y, 0), scrollable) / scrollable) * 100);
  const total = Math.ceil(scroll.height / viewportHeight);
  const current = Math.min(total, Math.floor(Math.max(scroll.y, 0) / viewportHeight) + 1);
  return `Scroll: ${percent}% (viewport ${current}/${total})`;
}

function formatElement(element: RawSnapshotElement, pageUrl: string): string {
  const parts = [`[${element.ref}]`, element.role, quote(element.name, MAX_NAME_CHARS)];

  // Password values must never reach the model, even if the collector were ever to send one.
  if (element.inputType === "password") parts.push("(password)");
  else if (element.value !== null && element.value !== "")
    parts.push(`value=${quote(element.value, MAX_VALUE_CHARS)}`);

  if (element.checked !== null) parts.push(element.checked ? "(checked)" : "(unchecked)");
  if (element.disabled) parts.push("(disabled)");

  const href = element.href === null ? null : formatHref(element.href, pageUrl);
  if (href) parts.push(`→ ${href}`);

  return parts.join(" ");
}

function formatPageSnapshot(
  raw: RawPageSnapshot,
  maxChars: number = AGENT_BROWSER_SNAPSHOT_MAX_CHARS
): string {
  let output = formatScroll(raw.scroll);

  const headings = raw.headings.slice(0, MAX_HEADINGS);
  if (headings.length > 0) {
    output += "\nHeadings:";
    for (const heading of headings) {
      output += `\n${"#".repeat(heading.level)} ${clip(heading.text.replace(/\s+/g, " ").trim(), MAX_HEADING_CHARS)}`;
    }
  }

  const text = raw.text.trim();
  const textReserve = Math.min(text.length + "\nText:\n".length, Math.floor(maxChars * TEXT_SHARE_OF_BUDGET));
  const elementBudget = maxChars - textReserve;
  const ordered = raw.elements
    .filter((element) => element.inViewport)
    .concat(raw.elements.filter((element) => !element.inViewport));

  output += ordered.length > 0 ? "\nElements:" : "\nElements: none";
  let shownElements = 0;
  for (const element of ordered) {
    const line = formatElement(element, raw.url);
    if (output.length + 1 + line.length > elementBudget) break;
    output += `\n${line}`;
    shownElements++;
  }
  // The markers sit outside the budget (the contract allows room for them) so they never eat the text reserve.
  const budgetedLength = output.length;
  const omittedElements = ordered.length - shownElements;
  if (omittedElements > 0) output += `\n… ${omittedElements} more elements not shown`;

  if (text) {
    const textRoom = maxChars - budgetedLength - "\nText:\n".length;
    if (textRoom > 0) {
      output += `\nText:\n${text.slice(0, textRoom)}`;
      if (text.length > textRoom) output += "…\n[text truncated]";
    } else {
      output += "\n[text truncated]";
    }
  }

  return output;
}

export type { CollectPageSnapshotOptions, RawPageSnapshot, RawSnapshotElement };
export {
  AGENT_BROWSER_SNAPSHOT_MAX_ELEMENTS,
  collectPageSnapshot,
  DEFAULT_COLLECT_OPTIONS,
  formatPageSnapshot,
  SNAPSHOT_REF_ATTRIBUTE,
};

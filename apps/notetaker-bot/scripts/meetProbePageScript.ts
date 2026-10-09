// UNVERIFIED AGAINST THE REAL SERVICE (Google Meet in Chrome): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/smoke-test-google-meet.md section 12 and record the
// result in docs/verification-status.md before relying on it, then remove this notice.
import type {
  MeetProbePageOptions,
  RawAttributeMutation,
  RawBox,
  RawDialogFacts,
  RawElementFacts,
  RawHitTest,
  RawLocatedString,
  RawPageSample,
  RawRtcFacts,
  RawRtcReceiverFacts,
  RawRtcSourceEntry,
  RawSelectorCheck,
  RawStyleFacts,
  RawTileFacts,
  StringLocation,
} from "./meetProbeTypes";

// The page is untrusted, so a sample is bounded before it is decoded. installMeetProbe repeats these numbers as
// literals because it is serialised on its own; the tests decode what the collector posts to keep the two in step.
const MAX_LEAVE_CONTROLS = 32;
const MAX_TILES = 64;
const MAX_STRINGS_PER_TILE = 64;
const MAX_STRING_LENGTH = 512;
const MAX_NAME_LENGTH = 64;
const MAX_NAMES = 64;
const MAX_CLASS_TOKENS = 256;
const MAX_ARIA_STATES = 16;
const MAX_STATE_LENGTH = 64;
const MAX_MUTATED_ATTRIBUTES = 32;
const MAX_TOGGLED_TOKENS = 64;
const MAX_MATCHED_BY = 16;
const MAX_CONNECTIONS = 16;
const MAX_RECEIVERS = 64;
const MAX_SOURCE_ENTRIES = 32;
const MAX_DIALOGS = 16;
const MAX_BOX_SIDE = 1_000_000;
const MAX_SOURCE_ID = 0xffffffff;

const DECOMPOSED_SELECTORS = [
  "[data-participant-id]",
  '[data-participant-id]:has([aria-label*="speaking" i])',
  '[aria-label*="speaking" i]',
  "[data-participant-id] span.notranslate",
  "span.notranslate",
];
const MATCHED_BY_PATTERN = /^(?:(?:aria-label|title|data-tooltip)\*=(?:leave|hang|end call)|text:leave)$/;
const TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const DATA_NAME_PATTERN = /^data-[a-z0-9_.:-]+$/;
const ARIA_NAME_PATTERN = /^aria-[a-z]{1,24}$/;
const ATTRIBUTE_NAME_PATTERN = /^[a-z_:][a-z0-9_.:-]*$/;
const CLASS_TOKEN_PATTERN = /^\S+$/;
const HIT_TESTS: readonly RawHitTest[] = ["self", "descendant", "other", "none"];
const STRING_LOCATIONS: readonly StringLocation[] = ["text", "aria-label", "title", "tooltip"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// In the helpers below undefined means "malformed"; null is a valid decoded value.
function decodeText(value: unknown, max: number, pattern?: RegExp): string | undefined {
  if (typeof value !== "string" || value.length > max) return undefined;
  if (pattern && !pattern.test(value)) return undefined;
  return value;
}

function decodeNullableText(value: unknown, max: number): string | null | undefined {
  return value === null ? null : decodeText(value, max);
}

function decodeCount(value: unknown, max: number = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) return undefined;
  return value;
}

function decodeNullableFinite(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeList<T>(
  value: unknown,
  max: number,
  decode: (item: unknown) => T | undefined
): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const result: T[] = [];
  for (const item of value as unknown[]) {
    const decoded = decode(item);
    if (decoded === undefined) return undefined;
    result.push(decoded);
  }
  return result;
}

function decodeNames(value: unknown, max: number, pattern: RegExp): string[] | undefined {
  return decodeList(value, max, (item) => {
    const name = decodeText(item, MAX_NAME_LENGTH, pattern);
    return name === undefined || name.length === 0 ? undefined : name;
  });
}

function decodeAriaStates(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > MAX_ARIA_STATES) return undefined;
  const states: Record<string, string> = {};
  for (const key of keys) {
    if (!ARIA_NAME_PATTERN.test(key)) return undefined;
    const state = decodeText(value[key], MAX_STATE_LENGTH);
    if (state === undefined) return undefined;
    states[key] = state;
  }
  return states;
}

function decodeBox(value: unknown): RawBox | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { width, height, inViewport } = value;
  if (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > MAX_BOX_SIDE)
    return undefined;
  if (typeof height !== "number" || !Number.isFinite(height) || height < 0 || height > MAX_BOX_SIDE) {
    return undefined;
  }
  if (typeof inViewport !== "boolean") return undefined;
  return { width, height, inViewport };
}

function decodeStyle(value: unknown): RawStyleFacts | undefined {
  if (!isRecord(value)) return undefined;
  const display = decodeText(value.display, MAX_STATE_LENGTH);
  const visibility = decodeText(value.visibility, MAX_STATE_LENGTH);
  const opacity = decodeText(value.opacity, MAX_STATE_LENGTH);
  const pointerEvents = decodeText(value.pointerEvents, MAX_STATE_LENGTH);
  if (
    display === undefined ||
    visibility === undefined ||
    opacity === undefined ||
    pointerEvents === undefined
  ) {
    return undefined;
  }
  return { display, visibility, opacity, pointerEvents };
}

function decodeCoveredBy(value: unknown): RawElementFacts["coveredBy"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const tag = decodeText(value.tag, MAX_NAME_LENGTH, TAG_PATTERN);
  const role = decodeNullableText(value.role, MAX_NAME_LENGTH);
  const ariaLabel = decodeNullableText(value.ariaLabel, MAX_STRING_LENGTH);
  if (tag === undefined || role === undefined || ariaLabel === undefined) return undefined;
  return { tag, role, ariaLabel };
}

function decodeLeaveControl(value: unknown): RawElementFacts | undefined {
  if (!isRecord(value)) return undefined;
  const tag = decodeText(value.tag, MAX_NAME_LENGTH, TAG_PATTERN);
  const role = decodeNullableText(value.role, MAX_NAME_LENGTH);
  const ariaLabel = decodeNullableText(value.ariaLabel, MAX_STRING_LENGTH);
  const title = decodeNullableText(value.title, MAX_STRING_LENGTH);
  const tooltip = decodeNullableText(value.tooltip, MAX_STRING_LENGTH);
  const text = decodeNullableText(value.text, MAX_STRING_LENGTH);
  const dataAttributeNames = decodeNames(value.dataAttributeNames, MAX_NAMES, DATA_NAME_PATTERN);
  const ariaStates = decodeAriaStates(value.ariaStates);
  const box = decodeBox(value.box);
  const style = decodeStyle(value.style);
  const hitTest = HIT_TESTS.find((candidate) => candidate === value.hitTest);
  const coveredBy = decodeCoveredBy(value.coveredBy);
  const matchedBy = decodeList(value.matchedBy, MAX_MATCHED_BY, (item) =>
    decodeText(item, MAX_NAME_LENGTH, MATCHED_BY_PATTERN)
  );
  if (tag === undefined || role === undefined || ariaLabel === undefined || title === undefined)
    return undefined;
  if (tooltip === undefined || text === undefined || dataAttributeNames === undefined) return undefined;
  if (ariaStates === undefined || box === undefined || style === undefined || hitTest === undefined) {
    return undefined;
  }
  if (coveredBy === undefined || matchedBy === undefined) return undefined;
  if (typeof value.disabled !== "boolean" || typeof value.inDialog !== "boolean") return undefined;
  if (coveredBy !== null && hitTest !== "other") return undefined;
  return {
    tag,
    role,
    ariaLabel,
    title,
    tooltip,
    text,
    dataAttributeNames,
    ariaStates,
    disabled: value.disabled,
    box,
    style,
    hitTest,
    coveredBy,
    inDialog: value.inDialog,
    matchedBy,
  };
}

function decodeLocatedString(value: unknown): RawLocatedString | undefined {
  if (!isRecord(value)) return undefined;
  const text = decodeText(value.value, MAX_STRING_LENGTH);
  const where = STRING_LOCATIONS.find((candidate) => candidate === value.where);
  if (text === undefined || text.length === 0 || where === undefined) return undefined;
  if (typeof value.visible !== "boolean" || typeof value.isNotranslateSpan !== "boolean") return undefined;
  return { value: text, where, visible: value.visible, isNotranslateSpan: value.isNotranslateSpan };
}

function decodeMutation(value: unknown): RawAttributeMutation | undefined {
  if (!isRecord(value)) return undefined;
  const attribute = decodeText(value.attribute, MAX_NAME_LENGTH, ATTRIBUTE_NAME_PATTERN);
  const count = decodeCount(value.count);
  const toggledClassTokens = decodeNames(value.toggledClassTokens, MAX_TOGGLED_TOKENS, CLASS_TOKEN_PATTERN);
  if (attribute === undefined || count === undefined || toggledClassTokens === undefined) return undefined;
  if (attribute !== "class" && toggledClassTokens.length > 0) return undefined;
  return { attribute, count, toggledClassTokens };
}

function decodeTile(value: unknown): RawTileFacts | undefined {
  if (!isRecord(value)) return undefined;
  const participantId = decodeText(value.participantId, 256);
  const classTokens = decodeNames(value.classTokens, MAX_CLASS_TOKENS, CLASS_TOKEN_PATTERN);
  const strings = decodeList(value.strings, MAX_STRINGS_PER_TILE, decodeLocatedString);
  const dataAttributeNames = decodeNames(value.dataAttributeNames, MAX_NAMES, DATA_NAME_PATTERN);
  const ariaStates = decodeAriaStates(value.ariaStates);
  const mutations = decodeList(value.mutations, MAX_MUTATED_ATTRIBUTES, decodeMutation);
  const mutationCount = decodeCount(value.mutationCount);
  if (participantId === undefined || participantId.length === 0 || classTokens === undefined)
    return undefined;
  if (strings === undefined || dataAttributeNames === undefined || ariaStates === undefined) return undefined;
  if (mutations === undefined || mutationCount === undefined) return undefined;
  return { participantId, classTokens, strings, dataAttributeNames, ariaStates, mutations, mutationCount };
}

function decodeSelectorCheck(value: unknown): RawSelectorCheck | undefined {
  if (!isRecord(value)) return undefined;
  const selector = DECOMPOSED_SELECTORS.find((candidate) => candidate === value.selector);
  const matched = decodeCount(value.matched);
  const visible = decodeCount(value.visible);
  if (selector === undefined || matched === undefined || visible === undefined || visible > matched) {
    return undefined;
  }
  return { selector, matched, visible };
}

function decodeSourceEntry(value: unknown): RawRtcSourceEntry | undefined {
  if (!isRecord(value)) return undefined;
  const source = decodeCount(value.source, MAX_SOURCE_ID);
  const audioLevel = decodeNullableFinite(value.audioLevel);
  const ageMs = decodeNullableFinite(value.ageMs);
  const timestampRaw = decodeNullableFinite(value.timestampRaw);
  if (source === undefined || audioLevel === undefined || ageMs === undefined || timestampRaw === undefined) {
    return undefined;
  }
  if (audioLevel !== null && (audioLevel < 0 || audioLevel > 1)) return undefined;
  return { source, audioLevel, ageMs, timestampRaw };
}

function decodeReceiver(value: unknown): RawRtcReceiverFacts | undefined {
  if (!isRecord(value)) return undefined;
  const readyState = decodeText(value.readyState, 16);
  const contributingSources = decodeList(value.contributingSources, MAX_SOURCE_ENTRIES, decodeSourceEntry);
  const synchronizationSources = decodeList(
    value.synchronizationSources,
    MAX_SOURCE_ENTRIES,
    decodeSourceEntry
  );
  if (readyState === undefined || typeof value.muted !== "boolean") return undefined;
  if (contributingSources === undefined || synchronizationSources === undefined) return undefined;
  return { readyState, muted: value.muted, contributingSources, synchronizationSources };
}

function decodeRtc(value: unknown): RawRtcFacts | undefined {
  if (!isRecord(value)) return undefined;
  const peerConnectionCount = decodeCount(value.peerConnectionCount, MAX_CONNECTIONS);
  const receivers = decodeList(value.receivers, MAX_RECEIVERS, decodeReceiver);
  if (peerConnectionCount === undefined || receivers === undefined) return undefined;
  return { peerConnectionCount, receivers };
}

function decodeDialog(value: unknown): RawDialogFacts | undefined {
  if (!isRecord(value)) return undefined;
  const ariaLabel = decodeNullableText(value.ariaLabel, MAX_STRING_LENGTH);
  const role = decodeNullableText(value.role, MAX_NAME_LENGTH);
  if (ariaLabel === undefined || role === undefined) return undefined;
  return { ariaLabel, role };
}

export const PROBE_SAMPLE_BINDING = "__notetakerProbeSample";

// Serialised with toString() and run inside the meeting page, so it must reference only its parameter, its own
// locals and page globals. It only observes: it never clicks, focuses, dispatches an event or writes to the DOM.
export function installMeetProbe(options: MeetProbePageOptions): void {
  const attempt = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  // An init script runs in every frame; only the top document is the call, and two frames would share one sequence.
  const isSubframe = attempt(() => {
    const topWindow: unknown = Reflect.get(globalThis, "top");
    return topWindow !== undefined && topWindow !== null && topWindow !== globalThis;
  }, true);
  if (isSubframe) return;

  const bound = (value: unknown, hardMax: number): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(hardMax, Math.floor(value)))
      : 0;
  const maxLeaveControls = bound(options.maxLeaveControls, 32);
  const maxTiles = bound(options.maxTiles, 64);
  const maxStringsPerTile = bound(options.maxStringsPerTile, 64);
  const maxStringLength = bound(options.maxStringLength, 512);
  const intervalMs =
    typeof options.intervalMs === "number" && Number.isFinite(options.intervalMs)
      ? Math.max(100, Math.min(60000, options.intervalMs))
      : 1000;
  const maxNameLength = 64;
  const maxNames = 64;
  const maxClassTokens = 256;
  const maxMutatedAttributes = 32;
  const maxToggledTokens = 64;
  const maxConnections = 16;
  const maxReceivers = 64;
  const maxSourceEntries = 32;
  const maxDialogs = 16;
  const maxBoxSide = 1000000;
  // Caps on how much of a large page one sample walks.
  const maxScannedElements = 2000;
  const maxMutationRecords = 5000;

  const tileSelector = "[data-participant-id]";
  const dialogSelector = '[role="dialog"], [role="alertdialog"], dialog';
  const decomposedSelectors = [
    "[data-participant-id]",
    '[data-participant-id]:has([aria-label*="speaking" i])',
    '[aria-label*="speaking" i]',
    "[data-participant-id] span.notranslate",
    "span.notranslate",
  ];
  // Only attributes whose values are short state tokens; free-text aria attributes are left out.
  const ariaStateNames = [
    "aria-pressed",
    "aria-expanded",
    "aria-disabled",
    "aria-hidden",
    "aria-selected",
    "aria-checked",
    "aria-busy",
    "aria-current",
    "aria-haspopup",
    "aria-live",
    "aria-modal",
    "aria-invalid",
  ];

  const clip = (value: unknown, max: number): string | null => {
    if (typeof value !== "string") return null;
    const clipped = value.replace(/\s+/g, " ").trim().slice(0, max);
    return clipped.length === 0 ? null : clipped;
  };
  const tagOf = (element: Element): string => {
    const tag = String(element.tagName).toLowerCase();
    return /^[a-z][a-z0-9-]{0,31}$/.test(tag) ? tag : "unknown";
  };
  const roleOf = (element: Element): string | null => clip(element.getAttribute("role"), maxNameLength);
  // The accessible name is approximated: aria-label, else the text of the first aria-labelledby target.
  const labelOf = (element: Element): string | null => {
    const label = clip(element.getAttribute("aria-label"), maxStringLength);
    if (label !== null) return label;
    const labelledBy = clip(element.getAttribute("aria-labelledby"), 256);
    if (labelledBy === null) return null;
    const target = document.getElementById(labelledBy.split(" ")[0] ?? "");
    return target ? clip(target.textContent, maxStringLength) : null;
  };
  const classTokensOf = (value: string | null): string[] =>
    (value ?? "").split(/\s+/).filter((token) => token.length > 0 && token.length <= maxNameLength);
  const addDataNames = (element: Element, into: Set<string>): void => {
    for (const name of element.getAttributeNames()) {
      if (into.size >= maxNames) return;
      const lower = name.toLowerCase();
      if (lower.length <= maxNameLength && /^data-[a-z0-9_.:-]+$/.test(lower)) into.add(lower);
    }
  };
  const ariaStatesOf = (element: Element): Record<string, string> => {
    const states: Record<string, string> = {};
    for (const name of ariaStateNames) {
      const value = clip(element.getAttribute(name), 32);
      if (value !== null) states[name] = value;
    }
    return states;
  };
  // Mirrors what Playwright's :visible asks for: a non-empty box and no hidden visibility.
  const isVisible = (element: Element): boolean =>
    attempt(() => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === "visible";
    }, false);

  const describeControl = (element: Element, matchedBy: string[]): RawElementFacts => {
    const rect = attempt(() => element.getBoundingClientRect(), null);
    const hasBox = rect !== null && (rect.width > 0 || rect.height > 0);
    const viewportWidth = attempt(() => Number(globalThis.innerWidth), 0);
    const viewportHeight = attempt(() => Number(globalThis.innerHeight), 0);
    const side = (value: number): number =>
      Number.isFinite(value) ? Math.max(0, Math.min(maxBoxSide, Math.round(value))) : 0;
    const box: RawBox | null =
      rect !== null && hasBox
        ? {
            width: side(rect.width),
            height: side(rect.height),
            inViewport:
              rect.left + rect.width > 0 &&
              rect.top + rect.height > 0 &&
              rect.left < viewportWidth &&
              rect.top < viewportHeight,
          }
        : null;
    const computed = attempt(() => getComputedStyle(element), null);
    const style: RawStyleFacts = {
      display: clip(computed?.display, 32) ?? "",
      visibility: clip(computed?.visibility, 32) ?? "",
      opacity: clip(computed?.opacity, 32) ?? "",
      pointerEvents: clip(computed?.pointerEvents, 32) ?? "",
    };
    let hitTest: RawHitTest = "none";
    let coveredBy: RawElementFacts["coveredBy"] = null;
    if (rect !== null && hasBox) {
      const hit = attempt(
        () => document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        null
      );
      if (hit === element) hitTest = "self";
      else if (hit && element.contains(hit)) hitTest = "descendant";
      else if (hit) {
        hitTest = "other";
        coveredBy = {
          tag: tagOf(hit),
          role: attempt(() => roleOf(hit), null),
          ariaLabel: attempt(() => labelOf(hit), null),
        };
      }
    }
    const dataNames = new Set<string>();
    attempt(() => addDataNames(element, dataNames), undefined);
    // A net can also catch a container (a dialog or panel labelled "leave"); its text is whatever it holds, so
    // text is read from button-like elements only.
    const isButtonLike =
      ["button", "a"].includes(tagOf(element)) ||
      ["button", "menuitem", "link"].includes(roleOf(element) ?? "");
    return {
      tag: tagOf(element),
      role: roleOf(element),
      ariaLabel: attempt(() => labelOf(element), null),
      title: clip(element.getAttribute("title"), maxStringLength),
      tooltip: clip(element.getAttribute("data-tooltip"), maxStringLength),
      text: isButtonLike ? clip(element.textContent, maxStringLength) : null,
      dataAttributeNames: Array.from(dataNames),
      ariaStates: attempt(() => ariaStatesOf(element), {}),
      disabled: Reflect.get(element, "disabled") === true || element.getAttribute("aria-disabled") === "true",
      box,
      style,
      hitTest,
      coveredBy,
      inDialog: attempt(() => element.closest(dialogSelector) !== null, false),
      matchedBy,
    };
  };

  const collectLeaveControls = (): RawElementFacts[] => {
    const found = new Map<Element, string[]>();
    const note = (element: Element, net: string): void => {
      const nets = found.get(element);
      if (nets) {
        if (!nets.includes(net)) nets.push(net);
        return;
      }
      if (found.size < maxLeaveControls) found.set(element, [net]);
    };
    for (const attribute of ["aria-label", "title", "data-tooltip"]) {
      for (const needle of ["leave", "hang", "end call"]) {
        attempt(() => {
          for (const element of document.querySelectorAll(`[${attribute}*="${needle}" i]`)) {
            note(element, `${attribute}*=${needle}`);
          }
        }, undefined);
      }
    }
    attempt(() => {
      let scanned = 0;
      for (const element of document.querySelectorAll('button, [role="button"]')) {
        scanned += 1;
        if (scanned > maxScannedElements) break;
        if ((element.textContent ?? "").toLowerCase().includes("leave")) note(element, "text:leave");
      }
    }, undefined);
    const controls: RawElementFacts[] = [];
    for (const [element, nets] of found) {
      attempt(() => {
        controls.push(describeControl(element, nets));
      }, undefined);
    }
    return controls;
  };

  type TileMutations = { total: number; attributes: Map<string, number>; toggled: Set<string> };
  // Keyed by element, not by id: Meet can show one participant id on several outermost elements.
  let pendingMutations = new Map<Element, TileMutations>();
  const isElement = (node: Node): node is Element => node.nodeType === 1;
  const absorbRecord = (record: MutationRecord, later: Map<Node, string>): void => {
    const target = record.target;
    const element = isElement(target) ? target : target.parentElement;
    if (!element) return;
    const isClass = record.type === "attributes" && record.attributeName === "class";
    // Walking the batch backwards, the value after this record is the old value of the next one for the same target.
    const after = isClass ? (later.get(target) ?? element.getAttribute("class") ?? "") : "";
    const before = isClass ? (record.oldValue ?? "") : "";
    if (isClass) later.set(target, before);
    let tile: Element | null = null;
    let cursor: Element | null = element.closest(tileSelector);
    while (cursor) {
      tile = cursor;
      cursor = cursor.parentElement ? cursor.parentElement.closest(tileSelector) : null;
    }
    if (!tile) return;
    let entry = pendingMutations.get(tile);
    if (!entry) {
      if (pendingMutations.size >= 64) return;
      entry = { total: 0, attributes: new Map<string, number>(), toggled: new Set<string>() };
      pendingMutations.set(tile, entry);
    }
    entry.total += 1;
    if (record.type !== "attributes" || typeof record.attributeName !== "string") return;
    const name = record.attributeName.toLowerCase();
    if (name.length > maxNameLength || !/^[a-z_:][a-z0-9_.:-]*$/.test(name)) return;
    const seen = entry.attributes.get(name);
    if (seen !== undefined) entry.attributes.set(name, seen + 1);
    else if (entry.attributes.size < maxMutatedAttributes) entry.attributes.set(name, 1);
    if (!isClass) return;
    const beforeTokens = new Set(classTokensOf(before));
    const afterTokens = new Set(classTokensOf(after));
    for (const token of [...beforeTokens, ...afterTokens]) {
      if (entry.toggled.size >= maxToggledTokens) break;
      if (beforeTokens.has(token) !== afterTokens.has(token)) entry.toggled.add(token);
    }
  };
  const absorbRecords = (records: MutationRecord[]): void => {
    const later = new Map<Node, string>();
    const first = Math.max(0, records.length - maxMutationRecords);
    for (let i = records.length - 1; i >= first; i -= 1) {
      const record = records[i];
      if (record) attempt(() => absorbRecord(record, later), undefined);
    }
  };
  const observer = attempt(() => {
    const created = new MutationObserver((records) => {
      attempt(() => absorbRecords(records), undefined);
    });
    // The document node itself: at init-script time there may be no documentElement yet.
    created.observe(document, {
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    return created;
  }, null);

  const describeTile = (tile: Element, mutations: TileMutations | undefined): RawTileFacts => {
    const elements: Element[] = [tile];
    attempt(() => {
      for (const element of tile.querySelectorAll("*")) {
        if (elements.length >= maxScannedElements) break;
        elements.push(element);
      }
    }, undefined);
    const classTokens = new Set<string>();
    const dataNames = new Set<string>();
    const strings: RawLocatedString[] = [];
    const seen = new Set<string>();
    for (const element of elements) {
      attempt(() => {
        const tokens = classTokensOf(element.getAttribute("class"));
        for (const token of tokens) {
          if (classTokens.size >= maxClassTokens) break;
          classTokens.add(token);
        }
        addDataNames(element, dataNames);
        const isNotranslateSpan = tagOf(element) === "span" && tokens.includes("notranslate");
        let visible: boolean | null = null;
        const add = (value: string | null, where: RawLocatedString["where"]): void => {
          if (value === null || strings.length >= maxStringsPerTile) return;
          if (visible === null) visible = isVisible(element);
          const key = `${where}|${visible}|${isNotranslateSpan}|${value}`;
          if (seen.has(key)) return;
          seen.add(key);
          strings.push({ value, where, visible, isNotranslateSpan });
        };
        add(clip(element.getAttribute("aria-label"), maxStringLength), "aria-label");
        add(clip(element.getAttribute("title"), maxStringLength), "title");
        add(clip(element.getAttribute("data-tooltip"), maxStringLength), "tooltip");
        if (isNotranslateSpan) {
          // The whole text, as the adapter reads it from this element.
          add(clip(element.textContent, maxStringLength), "text");
          return;
        }
        if (element.parentElement?.closest("span.notranslate")) return;
        let own = "";
        for (const node of element.childNodes) {
          if (node.nodeType === 3) own += ` ${node.textContent ?? ""}`;
        }
        add(clip(own, maxStringLength), "text");
      }, undefined);
    }
    const mutationFacts: RawAttributeMutation[] = [];
    if (mutations) {
      for (const [attribute, count] of mutations.attributes) {
        mutationFacts.push({
          attribute,
          count,
          toggledClassTokens: attribute === "class" ? Array.from(mutations.toggled) : [],
        });
      }
    }
    return {
      participantId: clip(tile.getAttribute("data-participant-id"), 256) ?? "",
      classTokens: Array.from(classTokens),
      strings,
      dataAttributeNames: Array.from(dataNames),
      ariaStates: attempt(() => ariaStatesOf(tile), {}),
      mutations: mutationFacts,
      mutationCount: mutations ? mutations.total : 0,
    };
  };

  const collectTiles = (): RawTileFacts[] => {
    if (observer) attempt(() => absorbRecords(observer.takeRecords()), undefined);
    const mutations = pendingMutations;
    pendingMutations = new Map<Element, TileMutations>();
    const tiles: RawTileFacts[] = [];
    for (const element of document.querySelectorAll(tileSelector)) {
      if (tiles.length >= maxTiles) break;
      attempt(() => {
        if (element.parentElement?.closest(tileSelector)) return;
        const facts = describeTile(element, mutations.get(element));
        if (facts.participantId.length > 0) tiles.push(facts);
      }, undefined);
    }
    return tiles;
  };

  const collectSelectorChecks = (): RawSelectorCheck[] => {
    const checks: RawSelectorCheck[] = [];
    for (const selector of decomposedSelectors) {
      // A selector the page cannot evaluate is left out rather than reported as zero matches.
      attempt(() => {
        const matches = document.querySelectorAll(selector);
        let visible = 0;
        let scanned = 0;
        for (const element of matches) {
          scanned += 1;
          if (scanned > maxScannedElements) break;
          if (isVisible(element)) visible += 1;
        }
        checks.push({ selector, matched: matches.length, visible });
      }, undefined);
    }
    return checks;
  };

  const connections: RTCPeerConnection[] = [];
  const NativePeerConnection = globalThis.RTCPeerConnection;
  if (typeof NativePeerConnection === "function") {
    attempt(() => {
      globalThis.RTCPeerConnection = new Proxy(NativePeerConnection, {
        construct(target, args, newTarget) {
          const connection: RTCPeerConnection = Reflect.construct(target, args, newTarget);
          if (connections.length < maxConnections) connections.push(connection);
          return connection;
        },
      });
    }, undefined);
  }
  const readSources = (read: () => RTCRtpContributingSource[]): RawRtcSourceEntry[] => {
    const entries: RawRtcSourceEntry[] = [];
    const now = Date.now();
    for (const entry of attempt(read, [])) {
      if (entries.length >= maxSourceEntries) break;
      attempt(() => {
        const source: unknown = entry.source;
        if (typeof source !== "number" || !Number.isInteger(source) || source < 0 || source > 0xffffffff)
          return;
        const level: unknown = entry.audioLevel;
        const timestamp: unknown = entry.timestamp;
        const timestampRaw = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
        entries.push({
          source,
          audioLevel:
            typeof level === "number" && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : null,
          // Against Date.now(), the clock src/audio/captureScript.ts compares these timestamps with.
          ageMs: timestampRaw === null ? null : now - timestampRaw,
          timestampRaw,
        });
      }, undefined);
    }
    return entries;
  };
  const collectRtc = (): RawRtcFacts => {
    for (let i = connections.length - 1; i >= 0; i -= 1) {
      const closed = attempt(() => connections[i]?.connectionState === "closed", false);
      if (closed) connections.splice(i, 1);
    }
    const receivers: RawRtcReceiverFacts[] = [];
    for (const connection of connections) {
      for (const receiver of attempt(() => connection.getReceivers(), [])) {
        if (receivers.length >= maxReceivers) break;
        attempt(() => {
          const track = receiver.track;
          if (!track || track.kind !== "audio") return;
          receivers.push({
            readyState: clip(track.readyState, 16) ?? "",
            muted: track.muted === true,
            contributingSources: readSources(() => receiver.getContributingSources()),
            synchronizationSources: readSources(() => receiver.getSynchronizationSources()),
          });
        }, undefined);
      }
    }
    return { peerConnectionCount: connections.length, receivers };
  };

  const collectDialogs = (): { count: number; dialogs: RawDialogFacts[] } => {
    const matches = document.querySelectorAll(dialogSelector);
    const dialogs: RawDialogFacts[] = [];
    for (const element of matches) {
      if (dialogs.length >= maxDialogs) break;
      attempt(() => {
        dialogs.push({ ariaLabel: labelOf(element), role: roleOf(element) });
      }, undefined);
    }
    return { count: matches.length, dialogs };
  };

  const installedAt = Date.now();
  let sequence = 0;
  const collect = (): void => {
    attempt(() => {
      sequence += 1;
      const dialogs = attempt(collectDialogs, { count: 0, dialogs: [] });
      const sample: RawPageSample = {
        sequence,
        pageTimeMs: Math.max(0, Date.now() - installedAt),
        leaveControls: attempt(collectLeaveControls, []),
        tiles: attempt(collectTiles, []),
        selectorChecks: attempt(collectSelectorChecks, []),
        rtc: attempt(collectRtc, { peerConnectionCount: 0, receivers: [] }),
        visibilityState: attempt(() => clip(document.visibilityState, 16), null) ?? "",
        hasFocus: attempt(() => document.hasFocus() === true, false),
        dialogCount: dialogs.count,
        dialogs: dialogs.dialogs,
      };
      const binding: unknown = Reflect.get(globalThis, "__notetakerProbeSample");
      if (typeof binding === "function") Promise.resolve(binding(sample)).catch(() => undefined);
    }, undefined);
  };
  attempt(() => setInterval(collect, intervalMs), null);
}

export function buildMeetProbeInitScript(options: MeetProbePageOptions): string {
  // tsx and esbuild keep-names inject a __name helper into stringified functions; the page has no such helper.
  return `(() => { const __name = (target) => target; (${installMeetProbe.toString()})(${JSON.stringify(options)}); })();`;
}

export function decodeProbeSamplePayload(payload: unknown): RawPageSample | null {
  if (!isRecord(payload)) return null;
  const sequence = decodeCount(payload.sequence);
  const pageTimeMs = payload.pageTimeMs;
  const leaveControls = decodeList(payload.leaveControls, MAX_LEAVE_CONTROLS, decodeLeaveControl);
  const tiles = decodeList(payload.tiles, MAX_TILES, decodeTile);
  const selectorChecks = decodeList(payload.selectorChecks, DECOMPOSED_SELECTORS.length, decodeSelectorCheck);
  const rtc = decodeRtc(payload.rtc);
  const visibilityState = decodeText(payload.visibilityState, 16);
  const dialogCount = decodeCount(payload.dialogCount);
  const dialogs = decodeList(payload.dialogs, MAX_DIALOGS, decodeDialog);
  if (sequence === undefined || sequence < 1) return null;
  if (typeof pageTimeMs !== "number" || !Number.isFinite(pageTimeMs) || pageTimeMs < 0) return null;
  if (leaveControls === undefined || tiles === undefined || selectorChecks === undefined) return null;
  if (rtc === undefined || visibilityState === undefined || typeof payload.hasFocus !== "boolean")
    return null;
  if (dialogCount === undefined || dialogs === undefined || dialogs.length > dialogCount) return null;
  return {
    sequence,
    pageTimeMs,
    leaveControls,
    tiles,
    selectorChecks,
    rtc,
    visibilityState,
    hasFocus: payload.hasFocus,
    dialogCount,
    dialogs,
  };
}

// @vitest-environment node
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  buildMeetProbeInitScript,
  decodeProbeSamplePayload,
  installMeetProbe,
  PROBE_SAMPLE_BINDING,
} from "./meetProbePageScript";
import type { MeetProbePageOptions, RawPageSample } from "./meetProbeTypes";

const OPTIONS: MeetProbePageOptions = {
  intervalMs: 1000,
  maxLeaveControls: 8,
  maxTiles: 8,
  maxStringsPerTile: 16,
  maxStringLength: 80,
};

const DECOMPOSED = [
  "[data-participant-id]",
  '[data-participant-id]:has([aria-label*="speaking" i])',
  '[aria-label*="speaking" i]',
  "[data-participant-id] span.notranslate",
  "span.notranslate",
];

type Compound = {
  tag: string | null;
  classes: string[];
  attributes: { name: string; operator: string | null; value: string; insensitive: boolean }[];
  has: string | null;
};

// Splits on a separator that sits outside brackets, parentheses and quotes.
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const char of input) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === "[" || char === "(")) depth += 1;
    if (!quoted && (char === "]" || char === ")")) depth -= 1;
    if (!quoted && depth === 0 && char === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseCompound(source: string): Compound {
  const compound: Compound = { tag: null, classes: [], attributes: [], has: null };
  let rest = source;
  const tag = /^[a-z*]+/.exec(rest);
  if (tag) {
    compound.tag = tag[0] === "*" ? null : tag[0];
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    const className = /^\.([\w-]+)/.exec(rest);
    if (className) {
      compound.classes.push(className[1] ?? "");
      rest = rest.slice(className[0].length);
      continue;
    }
    const attribute = /^\[([\w-]+)(?:(\*?=)"([^"]*)"( i)?)?\]/.exec(rest);
    if (attribute) {
      compound.attributes.push({
        name: attribute[1] ?? "",
        operator: attribute[2] ?? null,
        value: attribute[3] ?? "",
        insensitive: attribute[4] !== undefined,
      });
      rest = rest.slice(attribute[0].length);
      continue;
    }
    const has = /^:has\((.*)\)$/.exec(rest);
    if (has) {
      compound.has = has[1] ?? "";
      break;
    }
    throw new SyntaxError(`the stub cannot parse the selector "${source}"`);
  }
  return compound;
}

class StubText {
  readonly nodeType = 3;
  parentElement: StubElement | null = null;
  constructor(public textContent: string) {}
}

class StubElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly childNodes: (StubElement | StubText)[] = [];
  parentElement: StubElement | null = null;
  rect = { left: 10, top: 10, width: 20, height: 20 };
  style: Record<string, string> = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    pointerEvents: "auto",
  };
  disabled: boolean | undefined;
  failing = false;
  readonly click = vi.fn();
  readonly focus = vi.fn();
  readonly dispatchEvent = vi.fn();
  readonly setAttribute = vi.fn();
  readonly removeAttribute = vi.fn();
  readonly appendChild = vi.fn();
  readonly remove = vi.fn();

  constructor(tag: string, attrs: Record<string, string> = {}, children: (StubElement | string)[] = []) {
    this.tagName = tag.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
    for (const child of children) this.add(child);
  }

  add(child: StubElement | string): this {
    const node = typeof child === "string" ? new StubText(child) : child;
    node.parentElement = this;
    this.childNodes.push(node);
    return this;
  }

  getAttribute(name: string): string | null {
    if (this.failing) throw new Error("this element cannot be read");
    return this.attrs.get(name) ?? null;
  }

  getAttributeNames(): string[] {
    return [...this.attrs.keys()];
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect;
  }

  descendants(): StubElement[] {
    const found: StubElement[] = [];
    for (const node of this.childNodes) {
      if (node instanceof StubElement) found.push(node, ...node.descendants());
    }
    return found;
  }

  contains(other: unknown): boolean {
    return other === this || this.descendants().some((element) => element === other);
  }

  private matchesCompound(compound: Compound): boolean {
    if (compound.tag !== null && compound.tag !== this.tagName.toLowerCase()) return false;
    const classes = (this.attrs.get("class") ?? "").split(/\s+/);
    if (!compound.classes.every((name) => classes.includes(name))) return false;
    for (const attribute of compound.attributes) {
      const actual = this.attrs.get(attribute.name);
      if (actual === undefined) return false;
      if (attribute.operator === null) continue;
      const left = attribute.insensitive ? actual.toLowerCase() : actual;
      const right = attribute.insensitive ? attribute.value.toLowerCase() : attribute.value;
      if (attribute.operator === "=" ? left !== right : !left.includes(right)) return false;
    }
    return compound.has === null || this.querySelectorAll(compound.has).length > 0;
  }

  private matchesChain(chain: Compound[]): boolean {
    const last = chain[chain.length - 1];
    if (!last || !this.matchesCompound(last)) return false;
    if (chain.length === 1) return true;
    const rest = chain.slice(0, -1);
    for (let ancestor = this.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.matchesChain(rest)) return true;
    }
    return false;
  }

  matches(selector: string): boolean {
    return splitTopLevel(selector, ",").some((alternative) =>
      this.matchesChain(splitTopLevel(alternative, " ").map(parseCompound))
    );
  }

  closest(selector: string): StubElement | null {
    for (let element: StubElement | null = this; element; element = element.parentElement) {
      if (element.matches(selector)) return element;
    }
    return null;
  }

  querySelectorAll(selector: string): StubElement[] {
    return this.descendants().filter((element) => element.matches(selector));
  }
}

type StubRecord = {
  type: string;
  target: StubElement | StubText;
  attributeName: string | null;
  oldValue: string | null;
};

type SourceEntry = { source: unknown; timestamp: unknown; audioLevel?: unknown };

type StubReceiver = {
  track: { kind: string; readyState: string; muted: boolean } | null;
  getContributingSources: () => SourceEntry[];
  getSynchronizationSources: () => SourceEntry[];
};

function el(
  tag: string,
  attrs: Record<string, string> = {},
  children: (StubElement | string)[] = []
): StubElement {
  return new StubElement(tag, attrs, children);
}

function isConstructor(value: unknown): value is new () => unknown {
  return typeof value === "function";
}

function createHarness(config?: {
  options?: MeetProbePageOptions;
  withBinding?: boolean;
  withPeerConnection?: boolean;
  top?: unknown;
}) {
  const body = el("body");
  const root = el("html", {}, [body]);
  const failingSelectors = new Set<string>();
  let hit: StubElement | null | "throw" = null;

  class StubMutationObserver {
    static instances: StubMutationObserver[] = [];
    readonly observed: { target: unknown; options: unknown }[] = [];
    queue: StubRecord[] = [];
    constructor(readonly callback: (records: StubRecord[]) => void) {
      StubMutationObserver.instances.push(this);
    }
    observe(target: unknown, options: unknown): void {
      this.observed.push({ target, options });
    }
    takeRecords(): StubRecord[] {
      const records = this.queue;
      this.queue = [];
      return records;
    }
  }

  class StubPeerConnection {
    static instances: StubPeerConnection[] = [];
    connectionState = "connected";
    receivers: StubReceiver[] = [];
    constructor() {
      StubPeerConnection.instances.push(this);
    }
    getReceivers(): StubReceiver[] {
      return this.receivers;
    }
  }

  const document = {
    visibilityState: "visible",
    focused: true,
    hasFocus(): boolean {
      return this.focused;
    },
    querySelectorAll(selector: string): StubElement[] {
      if (failingSelectors.has(selector)) throw new SyntaxError("unsupported selector");
      return [root, ...root.descendants()].filter((element) => element.matches(selector));
    },
    getElementById(id: string): StubElement | null {
      return root.descendants().find((element) => element.attrs.get("id") === id) ?? null;
    },
    elementFromPoint: vi.fn<(x: number, y: number) => StubElement | null>(() => {
      if (hit === "throw") throw new Error("no hit test");
      return hit;
    }),
  };

  const intervals: { callback: () => void; ms: unknown }[] = [];
  const binding = vi.fn<(payload: unknown) => void>();
  const sandbox: Record<string, unknown> = {
    document,
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: (element: StubElement) => element.style,
    MutationObserver: StubMutationObserver,
    setInterval: (callback: () => void, ms: unknown) => {
      intervals.push({ callback, ms });
      return intervals.length;
    },
  };
  if (config?.withPeerConnection ?? true) sandbox.RTCPeerConnection = StubPeerConnection;
  if (config?.withBinding ?? true) sandbox[PROBE_SAMPLE_BINDING] = binding;
  if (config && "top" in config) sandbox.top = config.top;

  const context = vm.createContext(sandbox);
  vm.runInContext(buildMeetProbeInitScript(config?.options ?? OPTIONS), context);

  function tick(): void {
    const interval = intervals[0];
    if (!interval) throw new Error("no interval registered");
    interval.callback();
  }

  // The binding serialises its argument, so the test reads the sample the way Node receives it.
  function lastPayload(): unknown {
    const call = binding.mock.calls[binding.mock.calls.length - 1];
    if (!call) throw new Error("no sample was posted");
    return JSON.parse(JSON.stringify(call[0]));
  }

  function sample(): RawPageSample {
    tick();
    const decoded = decodeProbeSamplePayload(lastPayload());
    if (!decoded) throw new Error("the posted sample did not decode");
    return decoded;
  }

  function createConnection(): StubPeerConnection {
    const Wrapped = sandbox.RTCPeerConnection;
    if (!isConstructor(Wrapped)) throw new Error("RTCPeerConnection was removed from the sandbox");
    const instance = new Wrapped();
    if (!(instance instanceof StubPeerConnection)) throw new Error("not an instance of the stub class");
    return instance;
  }

  function observer(): StubMutationObserver {
    const instance = StubMutationObserver.instances[0];
    if (!instance) throw new Error("no MutationObserver was created");
    return instance;
  }

  return {
    body,
    root,
    document,
    sandbox,
    context,
    intervals,
    binding,
    failingSelectors,
    StubPeerConnection,
    setHit: (value: StubElement | null | "throw"): void => {
      hit = value;
    },
    tick,
    lastPayload,
    sample,
    createConnection,
    observer,
  };
}

function receiver(
  track: StubReceiver["track"],
  csrc: SourceEntry[] = [],
  ssrc: SourceEntry[] = []
): StubReceiver {
  return { track, getContributingSources: () => csrc, getSynchronizationSources: () => ssrc };
}

function attributeRecord(target: StubElement, attributeName: string, oldValue: string | null): StubRecord {
  return { type: "attributes", target, attributeName, oldValue };
}

function validSample(): Record<string, unknown> {
  return {
    sequence: 1,
    pageTimeMs: 12,
    leaveControls: [
      {
        tag: "button",
        role: "button",
        ariaLabel: "Leave call",
        title: null,
        tooltip: null,
        text: null,
        dataAttributeNames: ["data-x"],
        ariaStates: { "aria-pressed": "false" },
        disabled: false,
        box: { width: 10, height: 10, inViewport: true },
        style: { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" },
        hitTest: "other",
        coveredBy: { tag: "div", role: null, ariaLabel: null },
        inDialog: false,
        matchedBy: ["aria-label*=leave"],
      },
    ],
    tiles: [
      {
        participantId: "p1",
        classTokens: ["a"],
        strings: [{ value: "Ada", where: "text", visible: true, isNotranslateSpan: true }],
        dataAttributeNames: ["data-participant-id"],
        ariaStates: {},
        mutations: [{ attribute: "class", count: 2, toggledClassTokens: ["on"] }],
        mutationCount: 3,
      },
    ],
    selectorChecks: [{ selector: "span.notranslate", matched: 2, visible: 1 }],
    rtc: {
      peerConnectionCount: 1,
      receivers: [
        {
          readyState: "live",
          muted: false,
          contributingSources: [{ source: 7, audioLevel: 0.5, ageMs: 12, timestampRaw: 1000 }],
          synchronizationSources: [{ source: 9, audioLevel: null, ageMs: null, timestampRaw: null }],
        },
      ],
    },
    visibilityState: "visible",
    hasFocus: true,
    dialogCount: 1,
    dialogs: [{ ariaLabel: "Leave?", role: "dialog" }],
  };
}

// Returns a copy of the valid sample with the value at the path replaced.
function withChange(path: (string | number)[], value: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(validSample()));
  let cursor: unknown = copy;
  for (const key of path.slice(0, -1)) cursor = Reflect.get(Object(cursor), key);
  const last = path[path.length - 1];
  if (last === undefined) return value;
  Reflect.set(Object(cursor), last, value);
  return copy;
}

describe("buildMeetProbeInitScript", () => {
  it("pins the binding name the collector posts to", () => {
    expect(PROBE_SAMPLE_BINDING).toBe("__notetakerProbeSample");
    expect(installMeetProbe.toString()).toContain(`"${PROBE_SAMPLE_BINDING}"`);
  });

  it("wraps the stringified function with the name shim and the options", () => {
    expect(buildMeetProbeInitScript(OPTIONS)).toBe(
      `(() => { const __name = (target) => target; (${installMeetProbe.toString()})(${JSON.stringify(OPTIONS)}); })();`
    );
  });

  it("evaluates in a context holding only the stubs", () => {
    expect(() => createHarness()).not.toThrow();
  });

  it("evaluates in an empty context without throwing", () => {
    expect(() => vm.runInContext(buildMeetProbeInitScript(OPTIONS), vm.createContext({}))).not.toThrow();
  });

  it("covers the transpiler name helper with the shim", () => {
    const sandbox: Record<string, unknown> = {};
    const source = 'function () { const inner = function () {}; __name(inner, "x"); globalThis.ran = true; }';
    const script = buildMeetProbeInitScript(OPTIONS).replace(installMeetProbe.toString(), source);
    vm.runInContext(script, vm.createContext(sandbox));
    expect(sandbox.ran).toBe(true);
  });

  it("contains nothing that acts on the page, records, stores or reaches the network", () => {
    const script = buildMeetProbeInitScript(OPTIONS);
    expect(script).not.toMatch(
      /\.click\(|\.focus\(|dispatchEvent|setAttribute|removeAttribute|innerHTML|appendChild|\.remove\(|\.value\b/
    );
    expect(script).not.toMatch(
      /MediaRecorder|AudioContext|MediaStream|Blob|createObjectURL|download|localStorage|sessionStorage|indexedDB|cookie|XMLHttpRequest|WebSocket|sendBeacon|fetch\(|location|console\./
    );
  });
});

describe("installMeetProbe sampling", () => {
  it("registers one interval with the configured period", () => {
    const harness = createHarness({ options: { ...OPTIONS, intervalMs: 500 } });
    expect(harness.intervals).toHaveLength(1);
    expect(harness.intervals[0]?.ms).toBe(500);
  });

  it("keeps an unusable interval away from a busy loop", () => {
    expect(createHarness({ options: { ...OPTIONS, intervalMs: 0 } }).intervals[0]?.ms).toBe(100);
    expect(createHarness({ options: { ...OPTIONS, intervalMs: Number.NaN } }).intervals[0]?.ms).toBe(1000);
  });

  it("posts one sample per interval with an increasing sequence", () => {
    const harness = createHarness();
    expect(harness.binding).not.toHaveBeenCalled();
    const first = harness.sample();
    const second = harness.sample();
    const third = harness.sample();
    expect(harness.binding).toHaveBeenCalledTimes(3);
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(first.pageTimeMs).toBeGreaterThanOrEqual(0);
    expect(third.pageTimeMs).toBeGreaterThanOrEqual(first.pageTimeMs);
  });

  it("posts an empty but complete sample for an empty page", () => {
    const harness = createHarness();
    expect(harness.sample()).toEqual({
      sequence: 1,
      pageTimeMs: expect.any(Number),
      leaveControls: [],
      tiles: [],
      selectorChecks: DECOMPOSED.map((selector) => ({ selector, matched: 0, visible: 0 })),
      rtc: { peerConnectionCount: 0, receivers: [] },
      visibilityState: "visible",
      hasFocus: true,
      dialogCount: 0,
      dialogs: [],
    });
  });

  it("reports page visibility and focus", () => {
    const harness = createHarness();
    harness.document.visibilityState = "hidden";
    harness.document.focused = false;
    const sample = harness.sample();
    expect(sample.visibilityState).toBe("hidden");
    expect(sample.hasFocus).toBe(false);
  });

  it("ignores a missing binding silently", () => {
    const harness = createHarness({ withBinding: false });
    expect(() => harness.tick()).not.toThrow();
  });

  it("does nothing in a subframe", () => {
    const harness = createHarness({ top: {} });
    expect(harness.intervals).toHaveLength(0);
    expect(harness.sandbox.RTCPeerConnection).toBe(harness.StubPeerConnection);
  });

  it("observes mutations on the document without writing to it", () => {
    const harness = createHarness();
    expect(harness.observer().observed).toEqual([
      {
        target: harness.document,
        options: {
          attributes: true,
          attributeOldValue: true,
          childList: true,
          characterData: true,
          subtree: true,
        },
      },
    ]);
  });
});

describe("leave controls", () => {
  it("finds candidates through every discovery net and records which matched", () => {
    const harness = createHarness({ options: { ...OPTIONS, maxLeaveControls: 16 } });
    harness.body
      .add(el("button", { "aria-label": "Leave call", title: "Hang up", "data-tooltip": "End call now" }))
      .add(el("div", { "aria-label": "Hang up" }))
      .add(el("div", { "aria-label": "End call for all" }))
      .add(el("div", { title: "LEAVE" }))
      .add(el("div", { title: "end call" }))
      .add(el("div", { "data-tooltip": "Leave" }))
      .add(el("div", { "data-tooltip": "hang" }))
      .add(el("button", {}, ["Leave now"]))
      .add(el("div", { role: "button" }, [el("span", {}, ["Leave"])]))
      .add(el("div", {}, ["Leave is only text here"]))
      .add(el("button", { "aria-label": "Mute" }, ["Mute"]));

    const controls = harness.sample().leaveControls;
    expect(controls.map((control) => control.matchedBy)).toEqual([
      ["aria-label*=leave", "title*=hang", "data-tooltip*=end call"],
      ["aria-label*=hang"],
      ["aria-label*=end call"],
      ["title*=leave"],
      ["title*=end call"],
      ["data-tooltip*=leave"],
      ["data-tooltip*=hang"],
      ["text:leave"],
      ["text:leave"],
    ]);
  });

  it("records the facts of one control", () => {
    const harness = createHarness();
    const button = el(
      "button",
      {
        role: "switch",
        "aria-label": "Leave call",
        title: "Leave the call",
        "data-tooltip": "Leave",
        "data-idom-class": "secret-value",
        "data-mdc-dialog-action": "another-secret",
        "aria-pressed": "false",
        "aria-expanded": "true",
        "aria-describedby": "free-text-id",
      },
      ["  Leave \n call  "]
    );
    button.rect = { left: 100, top: 700, width: 40.4, height: 30.6 };
    button.style = { display: "inline-flex", visibility: "visible", opacity: "0.5", pointerEvents: "none" };
    harness.body.add(button);
    harness.setHit(button);

    const control = harness.sample().leaveControls[0];
    expect(control).toEqual({
      tag: "button",
      role: "switch",
      ariaLabel: "Leave call",
      title: "Leave the call",
      tooltip: "Leave",
      text: "Leave call",
      dataAttributeNames: ["data-tooltip", "data-idom-class", "data-mdc-dialog-action"],
      ariaStates: { "aria-pressed": "false", "aria-expanded": "true" },
      disabled: false,
      box: { width: 40, height: 31, inViewport: true },
      style: { display: "inline-flex", visibility: "visible", opacity: "0.5", pointerEvents: "none" },
      hitTest: "self",
      coveredBy: null,
      inDialog: false,
      matchedBy: ["aria-label*=leave", "title*=leave", "data-tooltip*=leave", "text:leave"],
    });
    expect(harness.document.elementFromPoint).toHaveBeenCalledWith(120.2, 715.3);
    expect(JSON.stringify(harness.lastPayload())).not.toMatch(/secret|free-text-id/);
  });

  it("reads the label through one level of aria-labelledby", () => {
    const harness = createHarness();
    harness.body
      .add(el("span", { id: "lbl" }, ["Leave call"]))
      .add(el("button", { title: "Leave", "aria-labelledby": "lbl other" }));
    expect(harness.sample().leaveControls[0]?.ariaLabel).toBe("Leave call");
  });

  it("reads text from button-like elements only", () => {
    const harness = createHarness();
    harness.body
      .add(el("div", { "aria-label": "Leave panel" }, ["whatever the container holds"]))
      .add(el("div", { role: "button", title: "Leave" }, ["Leave a"]))
      .add(el("a", { title: "Leave" }, ["Leave b"]))
      .add(el("div", { role: "menuitem", title: "Leave" }, ["Leave c"]));
    expect(harness.sample().leaveControls.map((control) => control.text)).toEqual([
      null,
      "Leave a",
      "Leave b",
      "Leave c",
    ]);
    expect(JSON.stringify(harness.lastPayload())).not.toContain("whatever");
  });

  it("reports disabled from the property and from aria-disabled", () => {
    const harness = createHarness();
    const byProperty = el("button", { title: "Leave a" });
    byProperty.disabled = true;
    harness.body
      .add(byProperty)
      .add(el("button", { title: "Leave b", "aria-disabled": "true" }))
      .add(el("button", { title: "Leave c" }));
    const controls = harness.sample().leaveControls;
    expect(controls.map((control) => control.disabled)).toEqual([true, true, false]);
    expect(controls[1]?.ariaStates).toEqual({ "aria-disabled": "true" });
  });

  it("reports a missing box, an off-screen box and no hit test without a box", () => {
    const harness = createHarness();
    const noBox = el("button", { title: "Leave a" });
    noBox.rect = { left: 0, top: 0, width: 0, height: 0 };
    noBox.style = { display: "none", visibility: "visible", opacity: "1", pointerEvents: "auto" };
    const offScreen = el("button", { title: "Leave b" });
    offScreen.rect = { left: 10, top: 900, width: 20, height: 20 };
    harness.body.add(noBox).add(offScreen);

    const controls = harness.sample().leaveControls;
    expect(controls[0]?.box).toBeNull();
    expect(controls[0]?.hitTest).toBe("none");
    expect(controls[0]?.style.display).toBe("none");
    expect(controls[1]?.box).toEqual({ width: 20, height: 20, inViewport: false });
    expect(controls[1]?.hitTest).toBe("none");
    expect(harness.document.elementFromPoint).toHaveBeenCalledTimes(1);
  });

  it("classifies the hit test at the box centre", () => {
    const harness = createHarness();
    const icon = el("i");
    const button = el("button", { title: "Leave" }, [icon]);
    const overlay = el("div", { role: "presentation", "aria-label": "Scrim" });
    harness.body.add(button).add(overlay);

    harness.setHit(icon);
    expect(harness.sample().leaveControls[0]).toMatchObject({ hitTest: "descendant", coveredBy: null });

    harness.setHit(overlay);
    expect(harness.sample().leaveControls[0]).toMatchObject({
      hitTest: "other",
      coveredBy: { tag: "div", role: "presentation", ariaLabel: "Scrim" },
    });

    harness.setHit(null);
    expect(harness.sample().leaveControls[0]).toMatchObject({ hitTest: "none", coveredBy: null });

    harness.setHit("throw");
    expect(harness.sample().leaveControls[0]).toMatchObject({ hitTest: "none", coveredBy: null });
  });

  it("reports whether a control sits in a dialog", () => {
    const harness = createHarness();
    harness.body
      .add(el("div", { role: "dialog" }, [el("div", {}, [el("button", { title: "Leave a" })])]))
      .add(el("div", { role: "alertdialog" }, [el("button", { title: "Leave b" })]))
      .add(el("dialog", {}, [el("button", { title: "Leave c" })]))
      .add(el("button", { title: "Leave d" }));
    expect(harness.sample().leaveControls.map((control) => control.inDialog)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("never clicks, focuses or changes a candidate", () => {
    const harness = createHarness();
    const button = el("button", { "aria-label": "Leave call" }, ["Leave"]);
    harness.body.add(button);
    harness.setHit(button);
    harness.sample();
    harness.sample();
    for (const spy of [
      button.click,
      button.focus,
      button.dispatchEvent,
      button.setAttribute,
      button.removeAttribute,
      button.appendChild,
      button.remove,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("participant tiles", () => {
  it("reports only the outermost tile elements", () => {
    const harness = createHarness();
    harness.body
      .add(el("div", { "data-participant-id": "outer-1" }, [el("div", { "data-participant-id": "inner" })]))
      .add(el("div", { "data-participant-id": "outer-2" }));
    expect(harness.sample().tiles.map((tile) => tile.participantId)).toEqual(["outer-1", "outer-2"]);
  });

  it("locates each string and flags visibility and the notranslate span", () => {
    const harness = createHarness();
    const hiddenLabel = el("div", { "aria-label": "Hidden Label" });
    hiddenLabel.style = { ...hiddenLabel.style, visibility: "hidden" };
    const noBoxTitle = el("div", { title: "Boxless Title" });
    noBoxTitle.rect = { left: 0, top: 0, width: 0, height: 0 };
    harness.body.add(
      el("div", { "data-participant-id": "p1", "aria-label": "Ada Lovelace tile" }, [
        el("span", { class: "notranslate name" }, ["Ada ", el("b", {}, ["Lovelace"])]),
        el("div", { title: "Ada title", "data-tooltip": "Ada tooltip" }, ["  plain   text "]),
        hiddenLabel,
        noBoxTitle,
        el("span", { class: "notranslate" }, ["Ada Lovelace"]),
      ])
    );

    const tile = harness.sample().tiles[0];
    expect(tile?.strings).toEqual([
      { value: "Ada Lovelace tile", where: "aria-label", visible: true, isNotranslateSpan: false },
      { value: "Ada Lovelace", where: "text", visible: true, isNotranslateSpan: true },
      { value: "Ada title", where: "title", visible: true, isNotranslateSpan: false },
      { value: "Ada tooltip", where: "tooltip", visible: true, isNotranslateSpan: false },
      { value: "plain text", where: "text", visible: true, isNotranslateSpan: false },
      { value: "Hidden Label", where: "aria-label", visible: false, isNotranslateSpan: false },
      { value: "Boxless Title", where: "title", visible: false, isNotranslateSpan: false },
    ]);
  });

  it("reports class tokens, data attribute names and aria states without attribute values", () => {
    const harness = createHarness();
    harness.body.add(
      el(
        "div",
        {
          "data-participant-id": "p1",
          class: "tile  speaking",
          "data-requested-id": "value-one",
          "aria-hidden": "false",
        },
        [el("div", { class: "ring tile", "data-ssrc": "value-two" })]
      )
    );
    const tile = harness.sample().tiles[0];
    expect(tile?.classTokens).toEqual(["tile", "speaking", "ring"]);
    expect(tile?.dataAttributeNames).toEqual(["data-participant-id", "data-requested-id", "data-ssrc"]);
    expect(tile?.ariaStates).toEqual({ "aria-hidden": "false" });
    expect(JSON.stringify(harness.lastPayload())).not.toMatch(/value-one|value-two/);
  });

  it("counts mutations per attribute since the previous sample and reports toggled class tokens", () => {
    const harness = createHarness();
    const ring = el("div", { class: "ring on" });
    const label = new StubText("Ada");
    const first = el("div", { "data-participant-id": "p1" }, [ring]);
    label.parentElement = ring;
    const second = el("div", { "data-participant-id": "p2" });
    const outside = el("div", { class: "x" });
    harness.body.add(first).add(second).add(outside);

    // Delivered through the callback: ring went "ring" -> "ring on" -> "ring loud" -> "ring on".
    harness
      .observer()
      .callback([
        attributeRecord(ring, "class", "ring"),
        attributeRecord(ring, "class", "ring on"),
        attributeRecord(ring, "class", "ring loud"),
        attributeRecord(ring, "style", null),
        attributeRecord(outside, "class", "y"),
      ]);
    // Still queued when the sample is taken.
    harness.observer().queue = [
      attributeRecord(first, "data-audio-level", "secret-old-value"),
      { type: "characterData", target: label, attributeName: null, oldValue: null },
      { type: "childList", target: ring, attributeName: null, oldValue: null },
    ];

    const tiles = harness.sample().tiles;
    expect(tiles[0]?.mutationCount).toBe(7);
    expect(tiles[0]?.mutations).toEqual([
      { attribute: "style", count: 1, toggledClassTokens: [] },
      { attribute: "class", count: 3, toggledClassTokens: ["loud", "on"] },
      { attribute: "data-audio-level", count: 1, toggledClassTokens: [] },
    ]);
    expect(tiles[1]).toMatchObject({ mutationCount: 0, mutations: [] });
    expect(JSON.stringify(harness.lastPayload())).not.toContain("secret-old-value");

    const next = harness.sample().tiles;
    expect(next[0]).toMatchObject({ mutationCount: 0, mutations: [] });
  });

  it("keeps mutations apart for two elements that carry the same participant id", () => {
    const harness = createHarness();
    const tile = el("div", { "data-participant-id": "p1" });
    const listItem = el("div", { "data-participant-id": "p1" });
    harness.body.add(tile).add(listItem);
    harness.observer().callback([attributeRecord(listItem, "class", "a")]);
    expect(harness.sample().tiles.map((facts) => facts.mutationCount)).toEqual([0, 1]);
  });
});

describe("decomposed selector checks", () => {
  it("counts matched and visible elements for each part of the speaker selector", () => {
    const harness = createHarness();
    const hiddenName = el("span", { class: "notranslate" }, ["Grace"]);
    hiddenName.style = { ...hiddenName.style, visibility: "hidden" };
    const hiddenTile = el("div", { "data-participant-id": "p3" });
    hiddenTile.rect = { left: 0, top: 0, width: 0, height: 0 };
    harness.body
      .add(
        el("div", { "data-participant-id": "p1" }, [
          el("div", { "aria-label": "Ada is Speaking" }),
          el("span", { class: "notranslate" }, ["Ada"]),
        ])
      )
      .add(el("div", { "data-participant-id": "p2" }, [hiddenName]))
      .add(hiddenTile)
      .add(el("div", { "aria-label": "speaking indicator" }))
      .add(el("span", { class: "notranslate" }, ["chat author"]));

    expect(harness.sample().selectorChecks).toEqual([
      { selector: "[data-participant-id]", matched: 3, visible: 2 },
      { selector: '[data-participant-id]:has([aria-label*="speaking" i])', matched: 1, visible: 1 },
      { selector: '[aria-label*="speaking" i]', matched: 2, visible: 2 },
      { selector: "[data-participant-id] span.notranslate", matched: 2, visible: 1 },
      { selector: "span.notranslate", matched: 3, visible: 2 },
    ]);
    expect(JSON.stringify(harness.lastPayload())).not.toContain("chat author");
  });

  it("leaves out a selector the page cannot evaluate", () => {
    const harness = createHarness();
    harness.failingSelectors.add(DECOMPOSED[1] ?? "");
    expect(harness.sample().selectorChecks.map((check) => check.selector)).toEqual([
      DECOMPOSED[0],
      DECOMPOSED[2],
      DECOMPOSED[3],
      DECOMPOSED[4],
    ]);
  });
});

describe("dialogs", () => {
  it("counts dialogs and reports their labels and roles only", () => {
    const harness = createHarness();
    harness.body
      .add(el("div", { role: "dialog", "aria-label": "Leave the call?" }, ["dialog body text"]))
      .add(el("h2", { id: "heading" }, ["Are you sure"]))
      .add(el("div", { role: "alertdialog", "aria-labelledby": "heading" }))
      .add(el("dialog"));
    const sample = harness.sample();
    expect(sample.dialogCount).toBe(3);
    expect(sample.dialogs).toEqual([
      { ariaLabel: "Leave the call?", role: "dialog" },
      { ariaLabel: "Are you sure", role: "alertdialog" },
      { ariaLabel: null, role: null },
    ]);
    expect(JSON.stringify(harness.lastPayload())).not.toContain("dialog body text");
  });
});

describe("WebRTC", () => {
  it("wraps RTCPeerConnection and keeps instanceof", () => {
    const harness = createHarness();
    expect(harness.sandbox.RTCPeerConnection).not.toBe(harness.StubPeerConnection);
    expect(harness.createConnection()).toBeInstanceOf(harness.StubPeerConnection);
    expect(vm.runInContext("new RTCPeerConnection()", harness.context)).toBeInstanceOf(
      harness.StubPeerConnection
    );
    expect(harness.sample().rtc.peerConnectionCount).toBe(2);
  });

  it("still samples the page when RTCPeerConnection does not exist", () => {
    const harness = createHarness({ withPeerConnection: false });
    expect(harness.sandbox.RTCPeerConnection).toBeUndefined();
    expect(harness.sample().rtc).toEqual({ peerConnectionCount: 0, receivers: [] });
  });

  it("reports audio receivers with their source entries and nothing of the track but state and mute", () => {
    const harness = createHarness();
    const connection = harness.createConnection();
    const now = Date.now();
    connection.receivers = [
      receiver(
        { kind: "audio", readyState: "live", muted: false },
        [
          { source: 7, timestamp: now - 50, audioLevel: 0.5 },
          { source: 8, timestamp: 1234.5 },
        ],
        [{ source: 9, timestamp: now, audioLevel: 0 }]
      ),
      receiver({ kind: "video", readyState: "live", muted: false }, [{ source: 1, timestamp: now }]),
      receiver({ kind: "audio", readyState: "ended", muted: true }),
      receiver(null),
    ];

    const rtc = harness.sample().rtc;
    expect(rtc.peerConnectionCount).toBe(1);
    expect(rtc.receivers).toHaveLength(2);
    const first = rtc.receivers[0];
    expect(first).toMatchObject({ readyState: "live", muted: false });
    expect(first?.contributingSources[0]).toMatchObject({
      source: 7,
      audioLevel: 0.5,
      timestampRaw: now - 50,
    });
    expect(first?.contributingSources[0]?.ageMs).toBeGreaterThanOrEqual(50);
    expect(first?.contributingSources[0]?.ageMs).toBeLessThan(5000);
    expect(first?.contributingSources[1]).toMatchObject({
      source: 8,
      audioLevel: null,
      timestampRaw: 1234.5,
    });
    // A timestamp on another clock shows up as an implausible age rather than being hidden.
    expect(first?.contributingSources[1]?.ageMs).toBeGreaterThan(1_000_000_000);
    expect(first?.synchronizationSources).toEqual([
      { source: 9, audioLevel: 0, ageMs: expect.any(Number), timestampRaw: now },
    ]);
    expect(rtc.receivers[1]).toEqual({
      readyState: "ended",
      muted: true,
      contributingSources: [],
      synchronizationSources: [],
    });
    expect(Object.keys(first ?? {})).toEqual([
      "readyState",
      "muted",
      "contributingSources",
      "synchronizationSources",
    ]);
  });

  it("drops unusable source entries and nulls unusable fields", () => {
    const harness = createHarness();
    harness.createConnection().receivers = [
      receiver({ kind: "audio", readyState: "live", muted: false }, [
        { source: "7", timestamp: 1 },
        { source: 1.5, timestamp: 1 },
        { source: -1, timestamp: 1 },
        { source: 3, timestamp: "soon", audioLevel: Number.NaN },
        { source: 4, timestamp: Number.POSITIVE_INFINITY, audioLevel: 7 },
      ]),
    ];
    expect(harness.sample().rtc.receivers[0]?.contributingSources).toEqual([
      { source: 3, audioLevel: null, ageMs: null, timestampRaw: null },
      { source: 4, audioLevel: 1, ageMs: null, timestampRaw: null },
    ]);
  });

  it("forgets closed connections", () => {
    const harness = createHarness();
    const closed = harness.createConnection();
    harness.createConnection();
    closed.connectionState = "closed";
    expect(harness.sample().rtc.peerConnectionCount).toBe(1);
  });
});

describe("bounds", () => {
  it("honours the option bounds", () => {
    const options: MeetProbePageOptions = {
      intervalMs: 1000,
      maxLeaveControls: 2,
      maxTiles: 3,
      maxStringsPerTile: 4,
      maxStringLength: 5,
    };
    const harness = createHarness({ options });
    for (let i = 0; i < 6; i += 1) {
      harness.body.add(el("button", { title: `Leave the call ${i}` }, ["Leave the call"]));
      const tile = el("div", { "data-participant-id": `p${i}` });
      for (let j = 0; j < 9; j += 1) tile.add(el("div", { title: `participant name ${j}` }));
      harness.body.add(tile);
    }
    harness.body.add(el("div", { role: "dialog", "aria-label": "A long dialog label" }));

    const sample = harness.sample();
    expect(sample.leaveControls).toHaveLength(2);
    expect(sample.leaveControls[0]).toMatchObject({ title: "Leave", text: "Leave" });
    expect(sample.tiles).toHaveLength(3);
    for (const tile of sample.tiles) {
      expect(tile.strings).toHaveLength(1);
      expect(tile.strings[0]?.value).toBe("parti");
    }
    expect(sample.dialogs).toEqual([{ ariaLabel: "A lon", role: "dialog" }]);
  });

  it("caps strings per tile after removing duplicates", () => {
    const harness = createHarness({ options: { ...OPTIONS, maxStringsPerTile: 3 } });
    const tile = el("div", { "data-participant-id": "p1" });
    for (let j = 0; j < 9; j += 1) tile.add(el("div", { title: `name ${j}` }));
    harness.body.add(tile);
    expect(harness.sample().tiles[0]?.strings.map((entry) => entry.value)).toEqual([
      "name 0",
      "name 1",
      "name 2",
    ]);
  });

  it("clamps oversized options to hard caps the decoder accepts", () => {
    const huge: MeetProbePageOptions = {
      intervalMs: 1000,
      maxLeaveControls: 10_000,
      maxTiles: 10_000,
      maxStringsPerTile: 10_000,
      maxStringLength: 100_000,
    };
    const harness = createHarness({ options: huge });
    const long = `Leave ${"x".repeat(2000)}`;
    for (let i = 0; i < 40; i += 1)
      harness.body.add(el("button", { title: `${long}${i}`, "aria-label": long }));
    for (let i = 0; i < 70; i += 1) {
      const tile = el("div", { "data-participant-id": `p${i}`, class: "c".repeat(100) });
      if (i === 0) {
        for (let j = 0; j < 80; j += 1) {
          tile.add(el("div", { title: `${j} ${long}`, class: `token-${j}`, [`data-n${j}`]: "v" }));
        }
        for (let j = 0; j < 300; j += 1) tile.add(el("i", { class: `t${j}` }));
      }
      harness.body.add(tile);
    }
    for (let i = 0; i < 20; i += 1) harness.body.add(el("div", { role: "dialog", "aria-label": long }));
    const connection = harness.createConnection();
    for (let i = 0; i < 80; i += 1) {
      const entries = Array.from({ length: 40 }, (_, source) => ({ source, timestamp: 1, audioLevel: 0.1 }));
      connection.receivers.push(
        receiver({ kind: "audio", readyState: "live", muted: false }, entries, entries)
      );
    }
    for (let i = 0; i < 20; i += 1) harness.createConnection();
    const mutated = harness.root.querySelectorAll("[data-participant-id]")[0];
    if (!mutated) throw new Error("no tile");
    harness
      .observer()
      .callback(
        Array.from({ length: 50 }, (_, index) => attributeRecord(mutated, `data-attr-${index}`, null))
      );

    const sample = harness.sample();
    expect(sample.leaveControls).toHaveLength(32);
    expect(sample.leaveControls[0]?.ariaLabel).toHaveLength(512);
    expect(sample.tiles).toHaveLength(64);
    expect(sample.tiles[0]?.strings).toHaveLength(64);
    expect(sample.tiles[0]?.strings[0]?.value).toHaveLength(512);
    expect(sample.tiles[0]?.classTokens).toHaveLength(256);
    expect(sample.tiles[0]?.classTokens).not.toContain("c".repeat(100));
    expect(sample.tiles[0]?.dataAttributeNames).toHaveLength(64);
    expect(sample.tiles[0]?.mutations).toHaveLength(32);
    expect(sample.tiles[0]?.mutationCount).toBe(50);
    expect(sample.dialogCount).toBe(20);
    expect(sample.dialogs).toHaveLength(16);
    expect(sample.rtc.peerConnectionCount).toBe(16);
    expect(sample.rtc.receivers).toHaveLength(64);
    expect(sample.rtc.receivers[0]?.contributingSources).toHaveLength(32);
    expect(sample.rtc.receivers[0]?.synchronizationSources).toHaveLength(32);
  });

  it("collects nothing when a bound is not a usable number", () => {
    const harness = createHarness({
      options: { ...OPTIONS, maxLeaveControls: Number.NaN, maxTiles: -4, maxStringLength: 0 },
    });
    harness.body
      .add(el("button", { title: "Leave" }))
      .add(el("div", { "data-participant-id": "p1" }))
      .add(el("div", { role: "dialog", "aria-label": "Label" }));
    const sample = harness.sample();
    expect(sample.leaveControls).toEqual([]);
    expect(sample.tiles).toEqual([]);
    expect(sample.dialogs).toEqual([{ ariaLabel: null, role: "dialog" }]);
  });
});

describe("failures inside the page", () => {
  it("still posts the sample when whole sections throw", () => {
    const harness = createHarness();
    harness.body.add(el("button", { title: "Leave" })).add(el("div", { "data-participant-id": "p1" }));
    harness.failingSelectors.add("[data-participant-id]");
    harness.failingSelectors.add('[role="dialog"], [role="alertdialog"], dialog');
    Object.defineProperty(harness.document, "visibilityState", {
      get: () => {
        throw new Error("no visibility");
      },
    });
    harness.document.hasFocus = () => {
      throw new Error("no focus");
    };
    harness.createConnection().getReceivers = () => {
      throw new Error("no receivers");
    };

    const sample = harness.sample();
    expect(sample.sequence).toBe(1);
    expect(sample.leaveControls).toHaveLength(1);
    expect(sample.tiles).toEqual([]);
    expect(sample.selectorChecks.map((check) => check.selector)).toEqual(DECOMPOSED.slice(1));
    expect(sample.rtc).toEqual({ peerConnectionCount: 1, receivers: [] });
    expect(sample.visibilityState).toBe("");
    expect(sample.hasFocus).toBe(false);
    expect(sample.dialogCount).toBe(0);
    expect(sample.dialogs).toEqual([]);
  });

  it("skips one unreadable element and keeps the rest", () => {
    const harness = createHarness();
    const brokenControl = el("button", { title: "Leave a" });
    const brokenChild = el("div", { title: "broken" });
    harness.body
      .add(brokenControl)
      .add(el("button", { title: "Leave b" }))
      .add(el("div", { "data-participant-id": "p1" }, [brokenChild, el("div", { title: "kept" })]));
    harness.sample();
    brokenControl.failing = true;
    brokenChild.failing = true;

    const sample = harness.sample();
    expect(sample.leaveControls.map((control) => control.title)).toEqual(["Leave b"]);
    expect(sample.tiles[0]?.strings.map((entry) => entry.value)).toEqual(["kept"]);
  });

  it("never throws out of the interval, the observer callback or the binding", async () => {
    const harness = createHarness();
    harness.binding.mockImplementation(() => {
      throw new Error("the binding is gone");
    });
    expect(() => harness.tick()).not.toThrow();
    harness.binding.mockImplementation(() => Promise.reject(new Error("the page is closing")));
    expect(() => harness.tick()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(() =>
      harness
        .observer()
        .callback([{ type: "attributes", target: new StubText("x"), attributeName: "class", oldValue: null }])
    ).not.toThrow();
    harness.document.querySelectorAll = () => {
      throw new Error("no document");
    };
    expect(harness.sample()).toMatchObject({ sequence: 3, leaveControls: [], tiles: [], selectorChecks: [] });
  });

  it("works without a MutationObserver", () => {
    const harness = createHarness();
    const sandbox: Record<string, unknown> = { ...harness.sandbox };
    delete sandbox.MutationObserver;
    const intervals: (() => void)[] = [];
    sandbox.setInterval = (callback: () => void) => intervals.push(callback);
    const binding = vi.fn<(payload: unknown) => void>();
    sandbox[PROBE_SAMPLE_BINDING] = binding;
    harness.body.add(el("div", { "data-participant-id": "p1" }));
    vm.runInContext(buildMeetProbeInitScript(OPTIONS), vm.createContext(sandbox));
    intervals[0]?.();
    const decoded = decodeProbeSamplePayload(JSON.parse(JSON.stringify(binding.mock.calls[0]?.[0])));
    expect(decoded?.tiles).toHaveLength(1);
  });
});

describe("decodeProbeSamplePayload", () => {
  it("accepts a valid sample and returns an equal copy", () => {
    const input = validSample();
    const decoded = decodeProbeSamplePayload(input);
    expect(decoded).toEqual(input);
    expect(decoded).not.toBe(input);
  });

  it("accepts a sample with every section empty", () => {
    const empty = {
      sequence: 1,
      pageTimeMs: 0,
      leaveControls: [],
      tiles: [],
      selectorChecks: [],
      rtc: { peerConnectionCount: 0, receivers: [] },
      visibilityState: "",
      hasFocus: false,
      dialogCount: 0,
      dialogs: [],
    };
    expect(decodeProbeSamplePayload(empty)).toEqual(empty);
  });

  it("never returns extra fields", () => {
    const input: unknown = JSON.parse(JSON.stringify(validSample()));
    const paths: (string | number)[][] = [
      [],
      ["leaveControls", 0],
      ["leaveControls", 0, "box"],
      ["leaveControls", 0, "style"],
      ["leaveControls", 0, "coveredBy"],
      ["tiles", 0],
      ["tiles", 0, "strings", 0],
      ["tiles", 0, "mutations", 0],
      ["selectorChecks", 0],
      ["rtc"],
      ["rtc", "receivers", 0],
      ["rtc", "receivers", 0, "contributingSources", 0],
      ["dialogs", 0],
    ];
    for (const path of paths) {
      let cursor: unknown = input;
      for (const key of path) cursor = Reflect.get(Object(cursor), key);
      Reflect.set(Object(cursor), "chatText", "a private message");
      Reflect.set(Object(cursor), "url", "https://meet.google.com/abc-defg-hij");
    }
    const decoded = decodeProbeSamplePayload(input);
    expect(decoded).toEqual(validSample());
    expect(JSON.stringify(decoded)).not.toMatch(/private message|abc-defg-hij/);
  });

  it("rejects payloads that are not a sample object", () => {
    for (const payload of [null, undefined, 1, "text", [], [validSample()], JSON.stringify(validSample())]) {
      expect(decodeProbeSamplePayload(payload)).toBeNull();
    }
  });

  it("rejects a sample with a missing field", () => {
    for (const key of Object.keys(validSample())) {
      const copy = validSample();
      delete copy[key];
      expect(decodeProbeSamplePayload(copy), key).toBeNull();
    }
  });

  it("rejects malformed fields", () => {
    const cases: [(string | number)[], unknown][] = [
      [["sequence"], 0],
      [["sequence"], 1.5],
      [["sequence"], "1"],
      [["pageTimeMs"], -1],
      [["pageTimeMs"], null],
      [["leaveControls"], {}],
      [["leaveControls", 0], null],
      [["leaveControls", 0, "tag"], "BUTTON"],
      [["leaveControls", 0, "tag"], "a b"],
      [["leaveControls", 0, "role"], 5],
      [["leaveControls", 0, "ariaLabel"], undefined],
      [["leaveControls", 0, "text"], ["x"]],
      [["leaveControls", 0, "dataAttributeNames"], ["class"]],
      [["leaveControls", 0, "dataAttributeNames"], ["data-x=1"]],
      [["leaveControls", 0, "ariaStates"], []],
      [["leaveControls", 0, "ariaStates"], { "aria-pressed": true }],
      [["leaveControls", 0, "ariaStates"], { onclick: "x" }],
      [["leaveControls", 0, "disabled"], "false"],
      [["leaveControls", 0, "box"], { width: -1, height: 1, inViewport: true }],
      [["leaveControls", 0, "box"], { width: 1, height: "1", inViewport: true }],
      [["leaveControls", 0, "box"], { width: 1, height: 1 }],
      [["leaveControls", 0, "style"], null],
      [["leaveControls", 0, "style", "opacity"], 1],
      [["leaveControls", 0, "hitTest"], "covered"],
      [["leaveControls", 0, "coveredBy"], "div"],
      [["leaveControls", 0, "coveredBy", "tag"], ""],
      [["leaveControls", 0, "inDialog"], 0],
      [["leaveControls", 0, "matchedBy"], ["aria-label*=anything"]],
      [["leaveControls", 0, "matchedBy"], "text:leave"],
      [["tiles", 0, "participantId"], ""],
      [["tiles", 0, "participantId"], 7],
      [["tiles", 0, "classTokens"], ["two tokens"]],
      [["tiles", 0, "classTokens"], [""]],
      [["tiles", 0, "strings", 0, "value"], ""],
      [["tiles", 0, "strings", 0, "where"], "chat"],
      [["tiles", 0, "strings", 0, "visible"], "yes"],
      [["tiles", 0, "strings", 0, "isNotranslateSpan"], null],
      [["tiles", 0, "mutations", 0, "attribute"], "on click"],
      [["tiles", 0, "mutations", 0, "count"], -1],
      [["tiles", 0, "mutations", 0, "toggledClassTokens"], [1]],
      [["tiles", 0, "mutations", 0, "attribute"], "style"],
      [["tiles", 0, "mutationCount"], 1.5],
      [["selectorChecks", 0, "selector"], "div.anything"],
      [["selectorChecks", 0, "matched"], "2"],
      [["selectorChecks", 0, "visible"], 3],
      [["rtc"], null],
      [["rtc", "peerConnectionCount"], -1],
      [["rtc", "receivers", 0, "readyState"], 1],
      [["rtc", "receivers", 0, "muted"], "no"],
      [["rtc", "receivers", 0, "contributingSources"], null],
      [["rtc", "receivers", 0, "contributingSources", 0, "source"], -1],
      [["rtc", "receivers", 0, "contributingSources", 0, "source"], 2 ** 32],
      [["rtc", "receivers", 0, "contributingSources", 0, "audioLevel"], 1.1],
      [["rtc", "receivers", 0, "contributingSources", 0, "audioLevel"], "0.5"],
      [["rtc", "receivers", 0, "contributingSources", 0, "ageMs"], "12"],
      [["rtc", "receivers", 0, "contributingSources", 0, "timestampRaw"], Number.NaN],
      [["rtc", "receivers", 0, "synchronizationSources", 0], []],
      [["visibilityState"], 1],
      [["hasFocus"], "true"],
      [["dialogCount"], 0],
      [["dialogCount"], -1],
      [["dialogs"], null],
      [["dialogs", 0, "role"], 1],
      [["dialogs", 0, "ariaLabel"], {}],
    ];
    for (const [path, value] of cases) {
      expect(
        decodeProbeSamplePayload(withChange(path, value)),
        `${path.join(".")} = ${String(value)}`
      ).toBeNull();
    }
  });

  it("rejects a covering element on a hit test that found none", () => {
    expect(decodeProbeSamplePayload(withChange(["leaveControls", 0, "hitTest"], "self"))).toBeNull();
  });

  it("rejects oversized payloads", () => {
    const control = validSample().leaveControls;
    const tile = validSample().tiles;
    const firstOf = (list: unknown): unknown => (Array.isArray(list) ? list[0] : undefined);
    const repeat = (item: unknown, length: number): unknown[] => Array.from({ length }, () => item);
    const source = { source: 1, audioLevel: 0.1, ageMs: 1, timestampRaw: 1 };
    const audioReceiver = {
      readyState: "live",
      muted: false,
      contributingSources: [],
      synchronizationSources: [],
    };
    const cases: [(string | number)[], unknown][] = [
      [["leaveControls"], repeat(firstOf(control), 33)],
      [["leaveControls", 0, "ariaLabel"], "x".repeat(513)],
      [["leaveControls", 0, "title"], "x".repeat(513)],
      [["leaveControls", 0, "tooltip"], "x".repeat(513)],
      [["leaveControls", 0, "text"], "x".repeat(513)],
      [["leaveControls", 0, "role"], "x".repeat(65)],
      [["leaveControls", 0, "tag"], "x".repeat(33)],
      [["leaveControls", 0, "dataAttributeNames"], repeat("data-x", 65)],
      [["leaveControls", 0, "dataAttributeNames"], [`data-${"x".repeat(60)}`]],
      [
        ["leaveControls", 0, "ariaStates"],
        Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`aria-${"abcdefghijklmnopq"[i]}`, "x"])),
      ],
      [["leaveControls", 0, "ariaStates"], { "aria-pressed": "x".repeat(65) }],
      [["leaveControls", 0, "box", "width"], 1_000_001],
      [["leaveControls", 0, "style", "display"], "x".repeat(65)],
      [["leaveControls", 0, "matchedBy"], repeat("text:leave", 17)],
      [["leaveControls", 0, "coveredBy", "ariaLabel"], "x".repeat(513)],
      [["tiles"], repeat(firstOf(tile), 65)],
      [["tiles", 0, "participantId"], "x".repeat(257)],
      [["tiles", 0, "classTokens"], repeat("a", 257)],
      [["tiles", 0, "classTokens"], ["x".repeat(65)]],
      [
        ["tiles", 0, "strings"],
        repeat({ value: "Ada", where: "text", visible: true, isNotranslateSpan: false }, 65),
      ],
      [["tiles", 0, "strings", 0, "value"], "x".repeat(513)],
      [["tiles", 0, "mutations"], repeat({ attribute: "style", count: 1, toggledClassTokens: [] }, 33)],
      [["tiles", 0, "mutations", 0, "toggledClassTokens"], repeat("a", 65)],
      [["tiles", 0, "mutations", 0, "attribute"], "x".repeat(65)],
      [["tiles", 0, "mutationCount"], Number.MAX_SAFE_INTEGER + 1],
      [["selectorChecks"], repeat({ selector: "span.notranslate", matched: 1, visible: 1 }, 6)],
      [["rtc", "peerConnectionCount"], 17],
      [["rtc", "receivers"], repeat(audioReceiver, 65)],
      [["rtc", "receivers", 0, "readyState"], "x".repeat(17)],
      [["rtc", "receivers", 0, "contributingSources"], repeat(source, 33)],
      [["rtc", "receivers", 0, "synchronizationSources"], repeat(source, 33)],
      [["visibilityState"], "x".repeat(17)],
      [["dialogs"], repeat({ ariaLabel: null, role: null }, 17)],
      [["dialogs", 0, "ariaLabel"], "x".repeat(513)],
      [["dialogs", 0, "role"], "x".repeat(65)],
    ];
    for (const [path, value] of cases) {
      expect(decodeProbeSamplePayload(withChange(path, value)), path.join(".")).toBeNull();
    }
  });

  it("accepts values at the bounds", () => {
    expect(
      decodeProbeSamplePayload(withChange(["leaveControls", 0, "text"], "x".repeat(512)))
    ).not.toBeNull();
    expect(decodeProbeSamplePayload(withChange(["rtc", "peerConnectionCount"], 16))).not.toBeNull();
    expect(
      decodeProbeSamplePayload(
        withChange(["rtc", "receivers", 0, "contributingSources", 0, "source"], 2 ** 32 - 1)
      )
    ).not.toBeNull();
    expect(
      decodeProbeSamplePayload(withChange(["rtc", "receivers", 0, "contributingSources", 0, "ageMs"], 1.7e12))
    ).not.toBeNull();
  });
});

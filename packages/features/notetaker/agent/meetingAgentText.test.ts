import { describe, expect, it } from "vitest";
import {
  chatMessageToPlainText,
  parseMeetingAgentTrigger,
  splitChatMessage,
  stripLeadingAgentName,
  utteranceWordsToText,
} from "./meetingAgentText";

describe("parseMeetingAgentTrigger", () => {
  it.each([
    ["BlueBeeBot what is X", "what is X"],
    ["bluebeebot, summarize the meeting", "summarize the meeting"],
    ["  BlueBeeBot: list the action items", "list the action items"],
    ["Blue Bee Bot, who spoke first?", "who spoke first?"],
    ["blue-bee bot what was decided", "what was decided"],
    ["Blue be bot repeat that", "repeat that"],
    ["@BlueBeeBot hi", "hi"],
    ["BLUEBEEBOT!", ""],
    ["Bluebee-Bot. Pokaż zadania i ustalenia", "Pokaż zadania i ustalenia"],
    ["Blu bee bot what time is it", "what time is it"],
  ])("matches %j", (text, command) => {
    expect(parseMeetingAgentTrigger(text)).toEqual({ command });
  });

  it.each([
    "hey BlueBeeBot what is X",
    "BlueBeeBots are everywhere",
    "Bluebird bot",
    "blue beetle bot",
    "",
  ])("ignores %j", (text) => {
    expect(parseMeetingAgentTrigger(text)).toBeNull();
  });
});

describe("chatMessageToPlainText", () => {
  it("strips HTML tags", () => {
    expect(chatMessageToPlainText("<p>BlueBeeBot <b>hi</b></p>")).toBe("BlueBeeBot hi");
  });

  it("decodes HTML entities", () => {
    expect(chatMessageToPlainText("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f")).toBe(
      "a & b <c> \"d\" 'e' f"
    );
  });

  it("decodes a double-encoded entity only once", () => {
    expect(chatMessageToPlainText("&amp;lt;")).toBe("&lt;");
  });

  it("collapses and trims whitespace", () => {
    expect(chatMessageToPlainText("  <div>one\n\n  two</div>\t three  ")).toBe("one two three");
  });
});

describe("utteranceWordsToText", () => {
  it("joins words and collapses whitespace", () => {
    expect(
      utteranceWordsToText([{ text: " Hello" }, { text: "" }, { text: "there " }, { text: "world" }])
    ).toBe("Hello there world");
  });

  it("returns an empty string for no words", () => {
    expect(utteranceWordsToText([])).toBe("");
  });
});

describe("stripLeadingAgentName", () => {
  it("strips a leading name", () => {
    expect(stripLeadingAgentName("BlueBeeBot: hello")).toBe("hello");
  });

  it("strips repeated leading names", () => {
    expect(stripLeadingAgentName("BlueBeeBot: Blue Bee Bot, hello")).toBe("hello");
  });

  it("keeps a name that is not leading", () => {
    expect(stripLeadingAgentName("I am BlueBeeBot, hello")).toBe("I am BlueBeeBot, hello");
  });

  it("leaves text without a name unchanged", () => {
    expect(stripLeadingAgentName("The meeting ended at noon.")).toBe("The meeting ended at noon.");
  });
});

describe("splitChatMessage", () => {
  const sentence = (n: number): string =>
    `This is sentence number ${n} of a longer answer about the meeting.`;
  const paragraph = (start: number, count: number): string =>
    Array.from({ length: count }, (_, i) => sentence(start + i)).join(" ");

  it("keeps short text in one part", () => {
    expect(splitChatMessage("  Short answer.  ")).toEqual(["Short answer."]);
  });

  it("returns no parts for empty or whitespace-only text", () => {
    expect(splitChatMessage("")).toEqual([]);
    expect(splitChatMessage("   \n\t ")).toEqual([]);
  });

  it("splits long text at paragraph and sentence boundaries", () => {
    const text = [paragraph(1, 4), paragraph(5, 10), paragraph(15, 2)].join("\n\n");
    const parts = splitChatMessage(text);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(4);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(500);
      expect(part).toMatch(/^This is sentence/);
      expect(part).toMatch(/meeting\.$/);
    }
    expect(parts[0]).toBe(paragraph(1, 4));
  });

  it("respects a custom maxLength", () => {
    const parts = splitChatMessage(paragraph(1, 6), 150);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(150);
    }
  });

  it("truncates to four parts and marks the last one", () => {
    const parts = splitChatMessage(paragraph(1, 20), 150);

    expect(parts).toHaveLength(4);
    expect(parts[3].endsWith("…")).toBe(true);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(150);
    }
  });

  it("hard-cuts a single word longer than maxLength", () => {
    const word = "x".repeat(2500);
    const parts = splitChatMessage(word);

    expect(parts).toHaveLength(4);
    expect(parts.slice(0, 3)).toEqual(["x".repeat(500), "x".repeat(500), "x".repeat(500)]);
    expect(parts[3]).toBe(`${"x".repeat(499)}…`);
  });
});

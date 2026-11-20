import { describe, expect, it } from "vitest";
import {
  chatMessageToPlainText,
  parseMeetingAgentTrigger,
  splitChatMessage,
  stripLeadingAgentName,
  toSpokenText,
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
    ["hey BlueBeeBot what is X", "hey what is X"],
    ["Pokaż mi proszę stronę firmy, BlueBeeBot", "Pokaż mi proszę stronę firmy"],
    ["Pokaż mi proszę stronę firmy, BlueBeeBot.", "Pokaż mi proszę stronę firmy."],
    ["Czy BlueBeeBot może sprawdzić pogodę?", "Czy może sprawdzić pogodę?"],
    ["Możesz, BlueBeeBot, pokazać X?", "Możesz pokazać X?"],
    ["Zapytajmy Blue Bee Bota o cenę", "Zapytajmy o cenę"],
    ["Dzięki BlueBeeBocie, a teraz podsumuj", "Dzięki a teraz podsumuj"],
    ["Can you, @BlueBeeBot, list the decisions?", "Can you list the decisions?"],
    ["What do you think, Blue Bee Bot?", "What do you think?"],
    ["Blue Bee Botowi: przypomnij zadania", "przypomnij zadania"],
    ["@BlueBeeBot", ""],
    ["  BlueBeeBot ?! ", ""],
  ])("matches %j", (text, command) => {
    expect(parseMeetingAgentTrigger(text)).toEqual({ command });
  });

  it.each([
    "BlueBeeBots are everywhere",
    "BlueBeeBots are great",
    "xBlueBeeBot what is X",
    "ask BlueBeeBot2 about it",
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

describe("toSpokenText", () => {
  it("keeps the label of a markdown link and drops its URL", () => {
    expect(toSpokenText("See [the docs](https://example.com/docs) for more.")).toBe("See the docs for more.");
  });

  it("removes bare http, https and www URLs", () => {
    expect(toSpokenText("Open https://example.com/a?b=1 or http://x.pl and www.example.org now")).toBe(
      "Open or and now"
    );
  });

  it("removes list markers and markdown symbols", () => {
    expect(
      toSpokenText("# Summary\n- **first** item\n* _second_ item\n1. `third`\n2) > fourth | ~fifth~")
    ).toBe("Summary first item second item third fourth fifth");
  });

  it("keeps numbers that are not list markers", () => {
    expect(toSpokenText("We have 3 tasks and 2.5 hours left.")).toBe("We have 3 tasks and 2.5 hours left.");
  });

  it("collapses whitespace and keeps Polish diacritics", () => {
    expect(toSpokenText("  Zażółć   gęślą\n\n jaźń  ")).toBe("Zażółć gęślą jaźń");
  });

  it("returns an empty string when only URLs remain", () => {
    expect(toSpokenText("https://example.com/page\nwww.example.org")).toBe("");
    expect(toSpokenText("   ")).toBe("");
  });

  it("returns text within the limit unchanged", () => {
    expect(toSpokenText("Short answer.", 13)).toBe("Short answer.");
  });

  it("truncates at the last sentence end within the limit", () => {
    expect(toSpokenText("First sentence here. Second one! Third sentence is long", 40)).toBe(
      "First sentence here. Second one!"
    );
  });

  it("ignores a sentence end in the first half and truncates at a word instead", () => {
    expect(toSpokenText("Hi. this is a long reply without further punctuation at all", 30)).toBe(
      "Hi. this is a long reply…"
    );
  });

  it("hard cuts a single long word", () => {
    const spoken = toSpokenText("a".repeat(50), 20);

    expect(spoken).toBe(`${"a".repeat(19)}…`);
    expect(spoken).toHaveLength(20);
  });

  it("defaults to a 600 character limit", () => {
    const spoken = toSpokenText("word ".repeat(200));

    expect(spoken.length).toBeLessThanOrEqual(600);
    expect(spoken.endsWith("…")).toBe(true);
  });
});

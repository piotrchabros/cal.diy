import { describe, expect, it } from "vitest";
import type { MeetingAgentLine } from "./IMeetingAgent";
import { MeetingAgentStateStore } from "./MeetingAgentStateStore";

const T0: number = new Date("2026-01-01T10:00:00.000Z").getTime();
const SECOND: number = 1000;
const MINUTE: number = 60 * SECOND;
const HOUR: number = 60 * MINUTE;

function at(offsetMs: number): Date {
  return new Date(T0 + offsetMs);
}

function line(text: string, offsetMs: number = 0): MeetingAgentLine {
  return { source: "CHAT", speakerName: "Alice", text, at: at(offsetMs) };
}

describe("MeetingAgentStateStore", () => {
  describe("markDelivery", () => {
    it("returns false for a repeated delivery id", () => {
      const store = new MeetingAgentStateStore();
      expect(store.markDelivery("bot", "d1", at(0))).toBe(true);
      expect(store.markDelivery("bot", "d1", at(SECOND))).toBe(false);
      expect(store.markDelivery("bot", "d2", at(SECOND))).toBe(true);
    });

    it("tracks delivery ids per bot", () => {
      const store = new MeetingAgentStateStore();
      expect(store.markDelivery("bot-a", "d1", at(0))).toBe(true);
      expect(store.markDelivery("bot-b", "d1", at(0))).toBe(true);
    });

    it("keeps only the last 200 delivery ids", () => {
      const store = new MeetingAgentStateStore();
      for (let i = 0; i <= 200; i++) {
        expect(store.markDelivery("bot", `d${i}`, at(i))).toBe(true);
      }
      expect(store.markDelivery("bot", "d200", at(300))).toBe(false);
      expect(store.markDelivery("bot", "d1", at(300))).toBe(false);
      expect(store.markDelivery("bot", "d0", at(300))).toBe(true);
    });
  });

  describe("appendLine / getRecentLines", () => {
    it("returns [] for an unknown bot", () => {
      const store = new MeetingAgentStateStore();
      expect(store.getRecentLines("unknown")).toEqual([]);
    });

    it("keeps the last 20 lines by default", () => {
      const store = new MeetingAgentStateStore();
      for (let i = 0; i < 25; i++) store.appendLine("bot", line(`line ${i}`, i));
      const lines = store.getRecentLines("bot");
      expect(lines).toHaveLength(20);
      expect(lines[0].text).toBe("line 5");
      expect(lines[19].text).toBe("line 24");
    });

    it("truncates lines to 500 characters by default", () => {
      const store = new MeetingAgentStateStore();
      store.appendLine("bot", line("x".repeat(600)));
      store.appendLine("bot", line("y".repeat(500)));
      const [first, second] = store.getRecentLines("bot");
      expect(first.text).toBe("x".repeat(500));
      expect(second.text).toBe("y".repeat(500));
    });

    it("honours custom maxLines and maxLineChars", () => {
      const store = new MeetingAgentStateStore({ maxLines: 2, maxLineChars: 3 });
      store.appendLine("bot", line("abcdef", 0));
      store.appendLine("bot", line("ghijkl", 1));
      store.appendLine("bot", line("mn", 2));
      expect(store.getRecentLines("bot").map((l) => l.text)).toEqual(["ghi", "mn"]);
    });

    it("preserves the other line fields", () => {
      const store = new MeetingAgentStateStore();
      const input: MeetingAgentLine = { source: "SPEECH", speakerName: null, text: "hello", at: at(5) };
      store.appendLine("bot", input);
      expect(store.getRecentLines("bot")).toEqual([input]);
    });

    it("returns a copy that does not affect stored lines", () => {
      const store = new MeetingAgentStateStore();
      store.appendLine("bot", line("one"));
      const lines = store.getRecentLines("bot");
      lines.push(line("injected"));
      lines.length = 0;
      expect(store.getRecentLines("bot").map((l) => l.text)).toEqual(["one"]);
    });
  });

  describe("pending triggers", () => {
    it("returns false when no trigger is pending", () => {
      const store = new MeetingAgentStateStore();
      expect(store.takePendingTrigger("bot", 1, at(0))).toBe(false);
    });

    it("takes a pending trigger only once within the 15s window", () => {
      const store = new MeetingAgentStateStore();
      store.setPendingTrigger("bot", 1, at(0));
      expect(store.takePendingTrigger("bot", 1, at(15 * SECOND))).toBe(true);
      expect(store.takePendingTrigger("bot", 1, at(15 * SECOND))).toBe(false);
    });

    it("returns false and clears an expired trigger", () => {
      const store = new MeetingAgentStateStore();
      store.setPendingTrigger("bot", 1, at(0));
      expect(store.takePendingTrigger("bot", 1, at(15 * SECOND + 1))).toBe(false);
      expect(store.takePendingTrigger("bot", 1, at(15 * SECOND + 2))).toBe(false);
    });

    it("tracks triggers per participant", () => {
      const store = new MeetingAgentStateStore();
      store.setPendingTrigger("bot", 1, at(0));
      expect(store.takePendingTrigger("bot", 2, at(SECOND))).toBe(false);
      expect(store.takePendingTrigger("bot", 1, at(SECOND))).toBe(true);
    });

    it("honours a custom window", () => {
      const store = new MeetingAgentStateStore();
      store.setPendingTrigger("bot", 1, at(0));
      expect(store.takePendingTrigger("bot", 1, at(2 * SECOND), SECOND)).toBe(false);
    });
  });

  describe("isDuplicateCommand", () => {
    it("treats a normalised repeat within 10s as a duplicate", () => {
      const store = new MeetingAgentStateStore();
      expect(store.isDuplicateCommand("bot", "p1", "Summarize the meeting", at(0))).toBe(false);
      expect(store.isDuplicateCommand("bot", "p1", "  summarize   THE meeting ", at(10 * SECOND))).toBe(true);
    });

    it("does not treat the same command from a different participant as a duplicate", () => {
      const store = new MeetingAgentStateStore();
      expect(store.isDuplicateCommand("bot", "p1", "summarize", at(0))).toBe(false);
      expect(store.isDuplicateCommand("bot", "p2", "summarize", at(SECOND))).toBe(false);
    });

    it("does not treat a repeat after the window as a duplicate", () => {
      const store = new MeetingAgentStateStore();
      expect(store.isDuplicateCommand("bot", "p1", "summarize", at(0))).toBe(false);
      expect(store.isDuplicateCommand("bot", "p1", "summarize", at(10 * SECOND + 1))).toBe(false);
    });

    it("does not treat a different command as a duplicate", () => {
      const store = new MeetingAgentStateStore();
      expect(store.isDuplicateCommand("bot", "p1", "summarize", at(0))).toBe(false);
      expect(store.isDuplicateCommand("bot", "p1", "list action items", at(SECOND))).toBe(false);
    });
  });

  describe("tryConsumeCommand", () => {
    it("returns MEETING_LIMIT once perMeeting commands were consumed", () => {
      const store = new MeetingAgentStateStore();
      const limits = { perMinute: 10, perMeeting: 2 };
      expect(store.tryConsumeCommand("bot", at(0), limits)).toBe("OK");
      expect(store.tryConsumeCommand("bot", at(2 * MINUTE), limits)).toBe("OK");
      expect(store.tryConsumeCommand("bot", at(4 * MINUTE), limits)).toBe("MEETING_LIMIT");
      expect(store.tryConsumeCommand("bot", at(10 * MINUTE), limits)).toBe("MEETING_LIMIT");
    });

    it("returns MINUTE_LIMIT when perMinute commands ran in the last 60s and frees up afterwards", () => {
      const store = new MeetingAgentStateStore();
      const limits = { perMinute: 2, perMeeting: 100 };
      expect(store.tryConsumeCommand("bot", at(0), limits)).toBe("OK");
      expect(store.tryConsumeCommand("bot", at(SECOND), limits)).toBe("OK");
      expect(store.tryConsumeCommand("bot", at(59 * SECOND), limits)).toBe("MINUTE_LIMIT");
      expect(store.tryConsumeCommand("bot", at(MINUTE), limits)).toBe("OK");
    });

    it("does not count rejected attempts", () => {
      const store = new MeetingAgentStateStore();
      const limits = { perMinute: 1, perMeeting: 2 };
      expect(store.tryConsumeCommand("bot", at(0), limits)).toBe("OK");
      for (let i = 1; i <= 5; i++) {
        expect(store.tryConsumeCommand("bot", at(i * SECOND), limits)).toBe("MINUTE_LIMIT");
      }
      expect(store.tryConsumeCommand("bot", at(MINUTE), limits)).toBe("OK");
      expect(store.tryConsumeCommand("bot", at(3 * MINUTE), limits)).toBe("MEETING_LIMIT");
    });

    it("tracks limits per bot", () => {
      const store = new MeetingAgentStateStore();
      const limits = { perMinute: 1, perMeeting: 1 };
      expect(store.tryConsumeCommand("bot-a", at(0), limits)).toBe("OK");
      expect(store.tryConsumeCommand("bot-b", at(0), limits)).toBe("OK");
    });
  });

  describe("markLimitNoticeSent", () => {
    it("returns true only the first time per bot", () => {
      const store = new MeetingAgentStateStore();
      expect(store.markLimitNoticeSent("bot-a")).toBe(true);
      expect(store.markLimitNoticeSent("bot-a")).toBe(false);
      expect(store.markLimitNoticeSent("bot-b")).toBe(true);
    });
  });

  describe("recordSentMessage / wasSentByBot", () => {
    it("returns false for an unknown bot", () => {
      const store = new MeetingAgentStateStore();
      expect(store.wasSentByBot("bot", "hello", at(0))).toBe(false);
    });

    it("matches normalised text within 2 minutes", () => {
      const store = new MeetingAgentStateStore();
      store.recordSentMessage("bot", "Here are the  Action Items", at(0));
      expect(store.wasSentByBot("bot", " here are the action items ", at(2 * MINUTE))).toBe(true);
      expect(store.wasSentByBot("bot", "something else", at(SECOND))).toBe(false);
    });

    it("returns false after the window", () => {
      const store = new MeetingAgentStateStore();
      store.recordSentMessage("bot", "hello", at(0));
      expect(store.wasSentByBot("bot", "hello", at(2 * MINUTE + 1))).toBe(false);
    });

    it("tracks sent messages per bot", () => {
      const store = new MeetingAgentStateStore();
      store.recordSentMessage("bot-a", "hello", at(0));
      expect(store.wasSentByBot("bot-b", "hello", at(0))).toBe(false);
    });
  });

  describe("eviction", () => {
    it("evicts the least recently used bot beyond maxBots", () => {
      const store = new MeetingAgentStateStore({ maxBots: 2 });
      store.appendLine("bot-a", line("a", 0));
      store.appendLine("bot-b", line("b", 1));
      store.appendLine("bot-c", line("c", 2));
      expect(store.getRecentLines("bot-a")).toEqual([]);
      expect(store.getRecentLines("bot-b")).toHaveLength(1);
      expect(store.getRecentLines("bot-c")).toHaveLength(1);
    });

    it("keeps a recently touched bot", () => {
      const store = new MeetingAgentStateStore({ maxBots: 2 });
      store.appendLine("bot-a", line("a", 0));
      store.appendLine("bot-b", line("b", 1));
      store.markDelivery("bot-a", "d1", at(2));
      store.appendLine("bot-c", line("c", 3));
      expect(store.getRecentLines("bot-a")).toHaveLength(1);
      expect(store.getRecentLines("bot-b")).toEqual([]);
      expect(store.getRecentLines("bot-c")).toHaveLength(1);
    });

    it("evicts beyond the default of 500 bots", () => {
      const store = new MeetingAgentStateStore();
      for (let i = 0; i <= 500; i++) store.appendLine(`bot-${i}`, line("x", i));
      expect(store.getRecentLines("bot-0")).toEqual([]);
      expect(store.getRecentLines("bot-1")).toHaveLength(1);
      expect(store.getRecentLines("bot-500")).toHaveLength(1);
    });

    it("resets the state of a bot that was idle longer than idleTtlMs", () => {
      const store = new MeetingAgentStateStore({ idleTtlMs: MINUTE });
      store.appendLine("bot-a", line("a", 0));
      store.markDelivery("bot-a", "d1", at(0));
      expect(store.markLimitNoticeSent("bot-a")).toBe(true);

      store.markDelivery("bot-b", "d1", at(MINUTE + 1));

      expect(store.getRecentLines("bot-a")).toEqual([]);
      expect(store.markDelivery("bot-a", "d1", at(MINUTE + 2))).toBe(true);
      expect(store.markLimitNoticeSent("bot-a")).toBe(true);
    });

    it("keeps a bot that was idle exactly idleTtlMs", () => {
      const store = new MeetingAgentStateStore({ idleTtlMs: MINUTE });
      store.appendLine("bot-a", line("a", 0));
      store.markDelivery("bot-b", "d1", at(MINUTE));
      expect(store.getRecentLines("bot-a")).toHaveLength(1);
    });

    it("evicts idle bots after the default of 6 hours", () => {
      const store = new MeetingAgentStateStore();
      store.appendLine("bot-a", line("a", 0));
      store.appendLine("bot-b", line("b", 6 * HOUR));
      expect(store.getRecentLines("bot-a")).toHaveLength(1);
      store.appendLine("bot-b", line("b", 6 * HOUR + 1));
      expect(store.getRecentLines("bot-a")).toEqual([]);
    });
  });
});

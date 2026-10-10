// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  aliasLabel,
  findLeaks,
  type LeakSecret,
  MEET_UI_VOCABULARY,
  NameRedactor,
  UNKNOWN_WORD_PLACEHOLDER,
} from "./meetProbeRedaction";

const redactor = (enabled = true) => new NameRedactor({ enabled });

describe("aliasLabel", () => {
  it("counts A to Z, then AA, AB", () => {
    expect(aliasLabel(0)).toBe("Participant A");
    expect(aliasLabel(1)).toBe("Participant B");
    expect(aliasLabel(25)).toBe("Participant Z");
    expect(aliasLabel(26)).toBe("Participant AA");
    expect(aliasLabel(27)).toBe("Participant AB");
    expect(aliasLabel(51)).toBe("Participant AZ");
    expect(aliasLabel(52)).toBe("Participant BA");
    expect(aliasLabel(701)).toBe("Participant ZZ");
    expect(aliasLabel(702)).toBe("Participant AAA");
  });

  it("gives every index its own label", () => {
    const labels = new Set(Array.from({ length: 2000 }, (_, index) => aliasLabel(index)));
    expect(labels.size).toBe(2000);
  });

  it("rejects an index that is not a non-negative integer", () => {
    expect(() => aliasLabel(-1)).toThrow(/non-negative integer/);
    expect(() => aliasLabel(1.5)).toThrow(/non-negative integer/);
  });
});

describe("MEET_UI_VOCABULARY", () => {
  it("holds the generic words around tiles and call controls", () => {
    for (const word of [
      "speaking",
      "muted",
      "microphone",
      "camera",
      "presenting",
      "pinned",
      "leave",
      "call",
    ]) {
      expect(MEET_UI_VOCABULARY.has(word)).toBe(true);
    }
    for (const word of ["you", "and", "is", "name"]) expect(MEET_UI_VOCABULARY.has(word)).toBe(true);
  });

  it("holds only lower-case words of two letters or more", () => {
    for (const word of MEET_UI_VOCABULARY) {
      expect(word).toMatch(/^[a-z]{2,}$/);
    }
  });

  it("leaves out words that are also common names", () => {
    for (const word of [
      "will",
      "may",
      "mark",
      "bill",
      "don",
      "can",
      "an",
      "he",
      "do",
      "hang",
      "mike",
      "rose",
    ]) {
      expect(MEET_UI_VOCABULARY.has(word)).toBe(false);
    }
  });
});

describe("NameRedactor aliases", () => {
  it("gives aliases in first-seen order and keeps them stable across the file", () => {
    const names = redactor();
    names.learnTileString("Ada Lovelace", "text", "tile-1");
    names.learnTileString("Grzegorz", "text", "tile-2");
    names.learnTileString("Ada Lovelace", "aria-label", "tile-1");

    expect(names.redactTileString("Ada Lovelace")).toBe("Participant A");
    expect(names.redactTileString("Grzegorz")).toBe("Participant B");
    expect(names.redactTileString("Ada Lovelace")).toBe("Participant A");
    expect(names.redactOtherString("Grzegorz and Ada Lovelace joined")).toBe(
      "Participant B and Participant A joined"
    );
  });

  it("keys a name by case, whitespace, Unicode form and surrounding punctuation", () => {
    const names = redactor();
    names.learnTileString("José  Álvarez", "text", "tile-1");
    names.learnTileString("  JOSÉ ÁLVAREZ. ", "title", "tile-1");
    names.learnTileString("(josé álvarez)", "tooltip", "tile-1");

    expect(names.summary()).toEqual([
      {
        alias: "Participant A",
        locations: ["text", "title", "tooltip"],
        tileCount: 1,
        inSpeakerEvents: false,
      },
    ]);
    expect(names.redactTileString("JOSÉ ÁLVAREZ")).toBe("Participant A");
  });

  it("treats a multi-word run as one name and punctuation as a boundary between names", () => {
    const names = redactor();
    names.learnTileString("Jean-Luc O'Neill, Zofia Wójcik", "text", "tile-1");

    expect(names.summary().map((entry) => entry.alias)).toEqual(["Participant A", "Participant B"]);
    expect(names.redactTileString("Jean-Luc O'Neill, Zofia Wójcik")).toBe("Participant A, Participant B");
  });

  it("handles non-ASCII scripts and emoji", () => {
    const names = redactor();
    names.learnTileString("山田 太郎", "text", "tile-1");
    names.learnTileString("Łukasz Żółć 🚀", "text", "tile-2");
    names.learnTileString("Мария", "aria-label", "tile-3");

    expect(names.redactTileString("山田 太郎")).toBe("Participant A");
    expect(names.redactTileString("Łukasz Żółć 🚀")).toBe("Participant B");
    expect(names.redactOtherString("Мария is presenting")).toBe("Participant C is presenting");
  });

  it("does not learn a short count as a name but learns a dial-in number", () => {
    const names = redactor();
    names.learnTileString("+3", "text", "tile-1");
    names.learnTileString("2 others", "text", "tile-1");
    names.learnTileString("+48 601 234 567", "text", "tile-2");

    expect(names.summary()).toHaveLength(1);
    expect(names.redactTileString("+3")).toBe(`+${UNKNOWN_WORD_PLACEHOLDER}`);
    expect(names.redactTileString("2 others")).toBe(`${UNKNOWN_WORD_PLACEHOLDER} others`);
    expect(names.redactTileString("+48 601 234 567")).toBe("+Participant A");
  });
});

describe("NameRedactor names learned whole", () => {
  it("replaces a name made only of vocabulary words wherever it occurs", () => {
    const names = redactor();
    names.learnName("Guest Speaker", "text", "tile-1");

    expect(names.redactTileString("Guest Speaker")).toBe("Participant A");
    expect(names.redactOtherString("Guest Speaker is speaking")).toBe("Participant A is speaking");
    expect(names.redactOtherString("name:Guest Speaker")).toBe("name:Participant A");
    expect(names.redactOtherString("Mute the speaker")).toBe("Mute the speaker");
  });

  it("recognises a whole name in a tile string that was learned before the name itself", () => {
    const names = redactor();
    names.learnTileString("Main Hand is speaking", "aria-label", "tile-1");
    names.learnName("Main Hand", "text", "tile-1");

    expect(names.redactTileString("Main Hand is speaking")).toBe("Participant A is speaking");
    expect(names.summary()).toEqual([
      { alias: "Participant A", locations: ["text", "aria-label"], tileCount: 1, inSpeakerEvents: false },
    ]);
  });

  it("rewrites ids of the form name:<name>", () => {
    const names = redactor();
    names.learnName("Ada Lovelace", "event", null);

    expect(names.redactOtherString("name:Ada Lovelace")).toBe("name:Participant A");
    expect(names.redactOtherString("name:ada lovelace")).toBe("name:Participant A");
    expect(names.redactOtherString("name:Xavier Unknown")).toBe(`name:${UNKNOWN_WORD_PLACEHOLDER}`);
  });

  it("ignores a name without any word", () => {
    const names = redactor();
    names.learnName("  ", "text", "tile-1");
    names.learnName("...", "text", "tile-1");

    expect(names.summary()).toEqual([]);
  });

  it("replaces longer names before the shorter ones they contain", () => {
    const names = redactor();
    names.learnName("Ada", "text", "tile-1");
    names.learnName("Ada Lovelace", "text", "tile-2");
    names.learnName("Lovelace", "text", "tile-3");

    expect(names.redactOtherString("Ada Lovelace is speaking")).toBe("Participant B is speaking");
    expect(names.redactOtherString("Ada is speaking")).toBe("Participant A is speaking");
    expect(names.redactOtherString("Lovelace, Ada")).toBe("Participant C, Participant A");
  });
});

describe("NameRedactor sentences", () => {
  it("keeps the sentence around a name in an aria-label", () => {
    const names = redactor();
    names.learnTileString("Ada Lovelace is speaking", "aria-label", "tile-1");
    names.learnTileString("Pin Ada Lovelace to your main screen", "aria-label", "tile-1");
    names.learnTileString("Mute Ada Lovelace's microphone", "aria-label", "tile-1");

    expect(names.redactTileString("Ada Lovelace is speaking")).toBe("Participant A is speaking");
    expect(names.redactTileString("Pin Ada Lovelace to your main screen")).toBe(
      "Pin Participant A to your main screen"
    );
    expect(names.redactTileString("Mute Ada Lovelace's microphone")).toBe("Mute Participant A's microphone");
    expect(names.summary()).toHaveLength(1);
  });

  it("turns unknown words outside tiles into the placeholder", () => {
    const names = redactor();
    names.learnTileString("Ada", "text", "tile-1");

    expect(names.redactOtherString("Leave call")).toBe("Leave call");
    expect(names.redactOtherString("Zebra crossing: leave call")).toBe(
      `${UNKNOWN_WORD_PLACEHOLDER}: leave call`
    );
    expect(names.redactOtherString("Ada wants to join, Brunhilde too")).toBe(
      `Participant A ${UNKNOWN_WORD_PLACEHOLDER} to join, ${UNKNOWN_WORD_PLACEHOLDER}`
    );
    expect(names.redactOtherString("")).toBe("");
  });

  it("keeps the contraction after a vocabulary word but never a bare letter", () => {
    const names = redactor();

    expect(names.redactOtherString("You're presenting")).toBe("You're presenting");
    expect(names.redactOtherString("It's X")).toBe(`It's ${UNKNOWN_WORD_PLACEHOLDER}`);
    expect(names.redactOtherString("'s")).toBe(`'${UNKNOWN_WORD_PLACEHOLDER}`);
  });

  it("does not mint an alias while redacting a tile string it never learned", () => {
    const names = redactor();
    names.learnTileString("Ada", "text", "tile-1");

    expect(names.redactTileString("Brunhilde is speaking")).toBe(`${UNKNOWN_WORD_PLACEHOLDER} is speaking`);
    expect(names.redactTileString("Brunhilde von Ada")).toBe(`${UNKNOWN_WORD_PLACEHOLDER} Participant A`);
    expect(names.summary()).toHaveLength(1);
  });

  it("keeps aliases stable when more is learned after redaction started", () => {
    const names = redactor();
    names.learnTileString("Ada", "text", "tile-1");
    expect(names.redactTileString("Ada")).toBe("Participant A");

    names.learnTileString("Brunhilde", "text", "tile-2");
    expect(names.redactTileString("Ada")).toBe("Participant A");
    expect(names.redactTileString("Brunhilde")).toBe("Participant B");
  });
});

describe("NameRedactor summary", () => {
  it("reports locations, tile count and speaker events per alias, never the name", () => {
    const names = redactor();
    names.learnName("Ada Lovelace", "text", "tile-1");
    names.learnTileString("Ada Lovelace is speaking", "aria-label", "tile-1");
    names.learnTileString("Ada Lovelace", "tooltip", "tile-4");
    names.learnName("Ada Lovelace", "event", null);
    names.learnTileString("Grzegorz", "title", "tile-2");
    names.learnName("Zofia", null, null);

    const summary = names.summary();
    expect(summary).toEqual([
      {
        alias: "Participant A",
        locations: ["text", "aria-label", "tooltip"],
        tileCount: 2,
        inSpeakerEvents: true,
      },
      { alias: "Participant B", locations: ["title"], tileCount: 1, inSpeakerEvents: false },
      { alias: "Participant C", locations: [], tileCount: 0, inSpeakerEvents: true },
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/ada|lovelace|grzegorz|zofia/i);
  });
});

describe("NameRedactor disabled", () => {
  it("passes strings through unchanged and reports the raw names", () => {
    const names = redactor(false);
    names.learnName("Ada Lovelace", "text", "tile-1");
    names.learnTileString("Ada Lovelace is speaking", "aria-label", "tile-1");
    names.learnTileString("Grzegorz", "title", "tile-2");
    names.learnName("Ada Lovelace", "event", null);

    expect(names.redactTileString("Ada  Lovelace is speaking")).toBe("Ada  Lovelace is speaking");
    expect(names.redactOtherString("name:Ada Lovelace")).toBe("name:Ada Lovelace");
    expect(names.redactOtherString("Zebra ﬁ")).toBe("Zebra ﬁ");
    expect(names.summary()).toEqual([
      { alias: "Ada Lovelace", locations: ["text", "aria-label"], tileCount: 1, inSpeakerEvents: true },
      { alias: "Grzegorz", locations: ["title"], tileCount: 1, inSpeakerEvents: false },
    ]);
  });
});

describe("NameRedactor default-deny", () => {
  const rawNames = [
    "Ada Lovelace",
    "Grzegorz Brzęczyszczykiewicz",
    "José Álvarez",
    "山田 太郎",
    "Мария Иванова",
    "Jean-Luc O'Neill",
    "Guest Speaker",
    "Zoë",
    "Dr. Strangelove Jr.",
    "+48 601 234 567",
    "Renée 🚀",
  ];
  const templates = [
    (name: string) => name,
    (name: string) => `${name} is speaking`,
    (name: string) => `Pin ${name} to your main screen`,
    (name: string) => `Mute ${name}'s microphone`,
    (name: string) => `${name} (presenting)`,
    (name: string) => `${name.toUpperCase()} is muted`,
    (name: string) => `  ${name.toLowerCase()}  `,
    (name: string) => `More options for ${name}`,
  ];

  it("leaves none of the raw names, nor any word of them, in the redacted output", () => {
    const names = redactor();
    rawNames.forEach((name, index) => {
      if (index % 2 === 0) names.learnName(name, "text", `tile-${index}`);
      for (const template of templates) names.learnTileString(template(name), "aria-label", `tile-${index}`);
    });

    const output: string[] = [];
    for (const name of rawNames) {
      for (const template of templates) {
        output.push(names.redactTileString(template(name)));
        output.push(names.redactOtherString(`${template(name)} and Unseen Stranger`));
      }
      output.push(names.redactOtherString(`name:${name}`));
    }
    const everything = `${output.join("\n")}\n${JSON.stringify(names.summary())}`.toLowerCase();

    const forbidden = rawNames
      .flatMap((name) => [name, ...name.split(/[\s.'’-]+/u)])
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 2 && !MEET_UI_VOCABULARY.has(part));
    expect(forbidden.length).toBeGreaterThan(20);
    for (const part of forbidden) expect(everything).not.toContain(part);
    expect(everything).not.toContain("unseen");
    expect(everything).not.toContain("stranger");
    expect(output.join("\n")).not.toMatch(/\d/);
  });

  it("lets through only vocabulary words, aliases and the placeholder", () => {
    const names = redactor();
    for (const name of rawNames) names.learnTileString(`${name} is speaking`, "aria-label", "tile-1");

    for (const name of rawNames) {
      const redacted = names.redactOtherString(`Xyzzy ${name} is speaking; quux 42 → ok`);
      const words = redacted
        .replaceAll(UNKNOWN_WORD_PLACEHOLDER, " ")
        .replace(/Participant [A-Z]+/g, " ")
        .match(/[^\s\p{P}+|]+/gu);
      for (const word of words ?? []) expect(MEET_UI_VOCABULARY.has(word.toLowerCase())).toBe(true);
    }
  });
});

describe("findLeaks", () => {
  const json = JSON.stringify({
    run: { meeting: { host: "meet.google.com" }, channel: "chrome" },
    strings: ["Participant A is speaking", 'He said "hi" to José'],
  });

  it("returns the labels of the secrets found, never the values", () => {
    const leaks = findLeaks(`${json} https://meet.google.com/abc-defg-hij hunter2secret`, [
      { label: "meeting code", value: "abc-defg-hij" },
      { label: "account password", value: "hunter2secret" },
      { label: "account email", value: "owner@example.com" },
    ]);

    expect(leaks).toEqual(["meeting code", "account password"]);
    expect(leaks.join(" ")).not.toContain("hunter2secret");
  });

  it("returns nothing when no secret is present", () => {
    expect(findLeaks(json, [{ label: "account email", value: "owner@example.com" }])).toEqual([]);
    expect(findLeaks(json, [])).toEqual([]);
  });

  it("matches case-insensitively and across Unicode forms", () => {
    expect(findLeaks(json, [{ label: "host", value: "MEET.Google.COM" }])).toEqual(["host"]);
    expect(findLeaks(json, [{ label: "name", value: "JOSÉ" }])).toEqual(["name"]);
  });

  it("finds a value that JSON escaped", () => {
    expect(findLeaks(json, [{ label: "quoted", value: 'said "hi" to' }])).toEqual(["quoted"]);
  });

  it("ignores empty and very short values", () => {
    expect(
      findLeaks(json, [
        { label: "empty", value: "" },
        { label: "blank", value: "   " },
        { label: "one", value: "a" },
        { label: "two", value: "is" },
      ])
    ).toEqual([]);
  });

  it("matches a short value only as a whole token", () => {
    expect(findLeaks(json, [{ label: "inside a word", value: "Ann" }])).toEqual([]);
    expect(findLeaks(`${json} "Ann"`, [{ label: "whole token", value: "ann" }])).toEqual(["whole token"]);
    expect(findLeaks(json, [{ label: "short name", value: "José" }])).toEqual(["short name"]);
  });

  it("reports a label once", () => {
    expect(
      findLeaks(json, [
        { label: "host", value: "meet.google.com" },
        { label: "host", value: "google.com" },
      ])
    ).toEqual(["host"]);
  });

  describe("with match: token", () => {
    const name = (value: string) => [{ label: "name", value, match: "token" as const }];

    it("does not find a long value inside a longer word or next to another word character", () => {
      expect(findLeaks(json, name("Google Something"))).toEqual([]);
      expect(findLeaks(json, name("speakin"))).toEqual([]);
      expect(findLeaks(json, name("articipant A is speaking"))).toEqual([]);
      expect(findLeaks(`${json} Grzegorzewski grzegorz2`, name("Grzegorz"))).toEqual([]);
    });

    it("finds a whole value whatever surrounds it, case-insensitively and across Unicode forms", () => {
      expect(findLeaks(json, name("PARTICIPANT A"))).toEqual(["name"]);
      expect(findLeaks(json, name("google"))).toEqual(["name"]);
      expect(findLeaks(`${json} name:Grzegorz.`, name("grzegorz"))).toEqual(["name"]);
      expect(findLeaks(json.normalize("NFD"), name("José"))).toEqual(["name"]);
      expect(findLeaks(JSON.stringify(["ｆｕｌｌ　ｗｉｄｔｈ"]), name("Full Width"))).toEqual(["name"]);
      expect(findLeaks(JSON.stringify(["山田 太郎さん"]), name("山田 太郎"))).toEqual([]);
      expect(findLeaks(JSON.stringify(["(山田 太郎)"]), name("山田 太郎"))).toEqual(["name"]);
    });

    it("finds a value that JSON escaped", () => {
      expect(findLeaks(json, name('said "hi" to'))).toEqual(["name"]);
      expect(findLeaks(JSON.stringify(["C:\\Users\\Ada is muted"]), name("C:\\Users\\Ada"))).toEqual([
        "name",
      ]);
    });

    it("treats an escaped control character as a boundary, not as a letter", () => {
      expect(findLeaks(JSON.stringify(["Leave call\nAda Lovelace\tmuted"]), name("Ada Lovelace"))).toEqual([
        "name",
      ]);
      expect(findLeaks(JSON.stringify(["x\u0007Ada Lovelace"]), name("Ada Lovelace"))).toEqual(["name"]);
      expect(findLeaks(JSON.stringify(["Ada\n  Lovelace"]), name("Ada Lovelace"))).toEqual(["name"]);
      expect(findLeaks(JSON.stringify(["back\\nAda Lovelace"]), name("Ada Lovelace"))).toEqual([]);
    });

    it("takes punctuation at the edge of a value as its own boundary", () => {
      expect(findLeaks(JSON.stringify(["tel+48 601 234 567"]), name("+48 601 234 567"))).toEqual(["name"]);
      expect(findLeaks(JSON.stringify(["Renée 🚀x"]), name("Renée 🚀"))).toEqual(["name"]);
      expect(findLeaks(JSON.stringify(["+48 601 234 5678"]), name("+48 601 234 567"))).toEqual([]);
    });

    it("still ignores empty and very short values", () => {
      expect(findLeaks(json, name("is"))).toEqual([]);
      expect(findLeaks(json, name("  "))).toEqual([]);
    });

    it("leaves a secret without it a substring match", () => {
      expect(findLeaks(json, [{ label: "host", value: "google" }])).toEqual(["host"]);
      expect(findLeaks(json, [{ label: "part", value: "articipant A" }])).toEqual(["part"]);
    });
  });
});

describe("findLeaks for hashed identifiers", () => {
  const SALT = "ab".repeat(32);
  const PARTICIPANT_ID = "spaces/q1/devices/111";
  const SOURCE_ID = "2718281828";
  const secrets: LeakSecret[] = [
    { label: "probe salt", value: SALT },
    { label: "participant id", value: PARTICIPANT_ID },
    { label: "audio source id", value: SOURCE_ID, match: "token" },
  ];

  it("reports the label of a raw participant id inside a JSON string", () => {
    const json = JSON.stringify({ note: `tile for ${PARTICIPANT_ID} is active` });
    expect(findLeaks(json, secrets)).toEqual(["participant id"]);
  });

  it("reports the label of the salt", () => {
    const json = JSON.stringify({ note: `salt ${SALT}` });
    expect(findLeaks(json, secrets)).toEqual(["probe salt"]);
  });

  it("reports a source id written as a JSON number and inside a csrc key", () => {
    expect(findLeaks(JSON.stringify({ source: Number(SOURCE_ID) }), secrets)).toEqual(["audio source id"]);
    expect(findLeaks(JSON.stringify({ sourceKey: `csrc:${SOURCE_ID}` }), secrets)).toEqual([
      "audio source id",
    ]);
  });

  it("never puts the secret value in its answer", () => {
    const json = JSON.stringify({ a: PARTICIPANT_ID, b: SOURCE_ID, c: SALT });
    const labels = findLeaks(json, secrets);
    expect(labels).toEqual(["probe salt", "participant id", "audio source id"]);
    for (const secret of secrets) {
      for (const label of labels) expect(label).not.toContain(secret.value);
    }
  });

  it("does not report a source id that is only part of a longer number", () => {
    expect(findLeaks(JSON.stringify({ n: 12718281828 }), secrets)).toEqual([]);
    expect(findLeaks(JSON.stringify({ n: 27182818281 }), secrets)).toEqual([]);
  });

  it("does not report a source id that is part of a 16-hex hash", () => {
    const json = JSON.stringify({ sourceHash: "2718281828ab12cd", other: "ab122718281828cd" });
    expect(findLeaks(json, secrets)).toEqual([]);
  });

  it("reports the digits of a float's fraction, because a decimal point is a token boundary", () => {
    expect(findLeaks(JSON.stringify({ audioLevel: 0.2718281828 }), secrets)).toEqual(["audio source id"]);
  });

  it("finds no leak in a report holding only hashes, tile keys and hashed source keys", () => {
    const report = {
      schemaVersion: 2,
      tiles: [
        {
          tileKey: "tile-1",
          participantIdHash: "0f1e2d3c4b5a6978",
          sourceHashes: ["a1b2c3d4e5f60718"],
        },
      ],
      events: [{ kind: "source_activity", sourceKey: "csrc:a1b2c3d4e5f60718", participantId: "tile-1" }],
      rtc: { contributingSources: [{ sourceHash: "a1b2c3d4e5f60718", audioLevel: 0.31, ageMs: 40 }] },
    };
    expect(findLeaks(JSON.stringify(report), secrets)).toEqual([]);
  });
});

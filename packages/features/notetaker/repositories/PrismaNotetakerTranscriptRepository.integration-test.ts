import { prisma } from "@calcom/prisma";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isQuickstartIsolatedDatabase, QUICKSTART_SKIP_MESSAGE } from "../tests/quickstartHarness";
import type { NotetakerPassageRecord } from "./interfaces/INotetakerTranscriptRepository";
import { PrismaNotetakerTranscriptRepository } from "./PrismaNotetakerTranscriptRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "PrismaNotetakerTranscriptRepository (integration)";

const repository = new PrismaNotetakerTranscriptRepository(prisma);

let userId: number | undefined;
let bookingId: number | undefined;
let sessionId: string | undefined;
let transcriptId: string | undefined;
let bookingCounter = 0;

function makePassage(index: number, text = `passage ${index}`): NotetakerPassageRecord {
  const isKnownSpeaker = index % 2 === 0;
  return {
    index,
    speakerKey: isKnownSpeaker ? "speaker-known" : "speaker-unknown-1",
    speakerName: isKnownSpeaker ? "Alice" : null,
    unknownSpeakerNumber: isKnownSpeaker ? null : 1,
    startMs: index * 1000,
    endMs: index * 1000 + 800,
    text,
    language: "en",
  };
}

function requireIds() {
  if (bookingId === undefined || sessionId === undefined || transcriptId === undefined) {
    throw new Error("Test setup did not complete: booking, session or transcript id is missing");
  }
  return { bookingId, sessionId, transcriptId };
}

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `notetaker-transcript-it-${runId}@example.com`,
        username: `notetaker-transcript-it-${runId}`,
      },
      select: { id: true },
    });
    userId = user.id;
  });

  beforeEach(async () => {
    if (userId === undefined) throw new Error("Test user was not created");
    bookingCounter += 1;
    const startTime = new Date("2030-01-01T10:00:00.000Z");
    const booking = await prisma.booking.create({
      data: {
        uid: `notetaker-it-${runId}-${bookingCounter}`,
        title: "Notetaker transcript integration test",
        startTime,
        endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
        userId,
      },
      select: { id: true },
    });
    bookingId = booking.id;

    const session = await prisma.notetakerSession.create({
      data: {
        bookingId: booking.id,
        platform: "GOOGLE_MEET",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        botProvider: "FAKE",
        displayName: "Notetaker",
        scheduledStartAt: startTime,
      },
      select: { id: true },
    });
    sessionId = session.id;

    const transcript = await repository.createIfMissing({ sessionId: session.id, bookingId: booking.id });
    transcriptId = transcript.id;
  });

  afterEach(async () => {
    // Prisma treats `where: { id: undefined }` as no filter, so every delete needs an explicit guard
    // to avoid wiping a real database when setup failed before the id was assigned.
    if (bookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: bookingId } });
    }
    bookingId = undefined;
    sessionId = undefined;
    transcriptId = undefined;
  });

  afterAll(async () => {
    if (userId !== undefined) {
      await prisma.booking.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    userId = undefined;
  });

  it("insertPassages is idempotent and keeps the first write", async () => {
    const ids = requireIds();

    const first = await repository.insertPassages(
      ids.transcriptId,
      [0, 1, 2].map((i) => makePassage(i))
    );
    expect(first).toBe(3);

    const second = await repository.insertPassages(
      ids.transcriptId,
      [0, 1, 2].map((i) => makePassage(i, `overwritten ${i}`))
    );
    expect(second).toBe(0);

    expect(await repository.countPassages(ids.transcriptId)).toBe(3);
    const all = await repository.findAllPassages(ids.transcriptId);
    expect(all.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(all.map((p) => p.text)).toEqual(["passage 0", "passage 1", "passage 2"]);
  });

  it("insertPassages with overlapping indexes only inserts the new ones", async () => {
    const ids = requireIds();

    await repository.insertPassages(
      ids.transcriptId,
      [0, 1, 2].map((i) => makePassage(i))
    );
    const inserted = await repository.insertPassages(
      ids.transcriptId,
      [1, 2, 3, 4].map((i) => makePassage(i))
    );

    expect(inserted).toBe(2);
    expect(await repository.countPassages(ids.transcriptId)).toBe(5);
    const all = await repository.findAllPassages(ids.transcriptId);
    expect(all.map((p) => p.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("pages passages by cursor and reports the last end offset", async () => {
    const ids = requireIds();

    expect(await repository.findLastPassageEndMs(ids.transcriptId)).toBeNull();
    expect(await repository.insertPassages(ids.transcriptId, [])).toBe(0);

    await repository.insertPassages(
      ids.transcriptId,
      [0, 1, 2, 3].map((i) => makePassage(i))
    );

    const firstPage = await repository.findPassagesPage({
      transcriptId: ids.transcriptId,
      cursor: null,
      limit: 2,
    });
    expect(firstPage.map((p) => p.index)).toEqual([0, 1]);

    const secondPage = await repository.findPassagesPage({
      transcriptId: ids.transcriptId,
      cursor: 1,
      limit: 2,
    });
    expect(secondPage.map((p) => p.index)).toEqual([2, 3]);

    expect(await repository.findLastPassageEndMs(ids.transcriptId)).toBe(makePassage(3).endMs);
  });

  it("createIfMissing returns the existing transcript for the same session", async () => {
    const ids = requireIds();

    const again = await repository.createIfMissing({ sessionId: ids.sessionId, bookingId: ids.bookingId });

    expect(again.id).toBe(ids.transcriptId);
    expect(again.completeness).toBe("PARTIAL");
  });

  it("deleteById cascades to passages and summary but keeps the session", async () => {
    const ids = requireIds();
    await repository.insertPassages(
      ids.transcriptId,
      [0, 1].map((i) => makePassage(i))
    );
    await prisma.notetakerSummary.create({
      data: { transcriptId: ids.transcriptId },
      select: { id: true },
    });

    await repository.deleteById(ids.transcriptId);

    expect(await repository.countPassages(ids.transcriptId)).toBe(0);
    const summary = await prisma.notetakerSummary.findUnique({
      where: { transcriptId: ids.transcriptId },
      select: { id: true },
    });
    expect(summary).toBeNull();
    const session = await prisma.notetakerSession.findUnique({
      where: { id: ids.sessionId },
      select: { id: true },
    });
    expect(session).not.toBeNull();

    await expect(repository.deleteById(ids.transcriptId)).resolves.not.toThrow();
  });

  it("deleting the booking cascades to every notetaker row", async () => {
    const ids = requireIds();
    await prisma.bookingNotetaker.create({
      data: { bookingId: ids.bookingId, enabled: true, source: "HOST" },
      select: { bookingId: true },
    });
    await repository.insertPassages(
      ids.transcriptId,
      [0, 1].map((i) => makePassage(i))
    );
    await prisma.notetakerSummary.create({
      data: { transcriptId: ids.transcriptId },
      select: { id: true },
    });
    await prisma.notetakerSharingGrant.create({
      data: { bookingId: ids.bookingId },
      select: { bookingId: true },
    });
    await prisma.notetakerActivity.create({
      data: { bookingId: ids.bookingId, action: "ENABLED", actorType: "SYSTEM" },
      select: { id: true },
    });

    await prisma.booking.delete({ where: { id: ids.bookingId }, select: { id: true } });

    expect(
      await prisma.bookingNotetaker.findUnique({
        where: { bookingId: ids.bookingId },
        select: { bookingId: true },
      })
    ).toBeNull();
    expect(
      await prisma.notetakerSession.findUnique({ where: { id: ids.sessionId }, select: { id: true } })
    ).toBeNull();
    expect(
      await prisma.notetakerTranscript.findUnique({ where: { id: ids.transcriptId }, select: { id: true } })
    ).toBeNull();
    expect(await prisma.notetakerTranscriptPassage.count({ where: { transcriptId: ids.transcriptId } })).toBe(
      0
    );
    expect(
      await prisma.notetakerSummary.findUnique({
        where: { transcriptId: ids.transcriptId },
        select: { id: true },
      })
    ).toBeNull();
    expect(
      await prisma.notetakerSharingGrant.findUnique({
        where: { bookingId: ids.bookingId },
        select: { bookingId: true },
      })
    ).toBeNull();
    expect(await prisma.notetakerActivity.count({ where: { bookingId: ids.bookingId } })).toBe(0);
  });

  it("updatePassageSpeakersBySpeakerKey resolves the matching passages and nothing else", async () => {
    const ids = requireIds();
    await repository.insertPassages(
      ids.transcriptId,
      [0, 1, 2, 3, 4].map((i) => makePassage(i))
    );
    const before = await repository.findAllPassages(ids.transcriptId);

    const resolved = await repository.updatePassageSpeakersBySpeakerKey({
      transcriptId: ids.transcriptId,
      speakerKey: "speaker-unknown-1",
      resolvedSpeakerKey: "participant-42",
      speakerName: "Bob",
    });

    expect(resolved).toBe(2);
    const after = await repository.findAllPassages(ids.transcriptId);
    expect(after).toHaveLength(5);
    for (const passage of after) {
      const original = before.find((p) => p.index === passage.index);
      expect(original).toBeDefined();
      expect(passage.startMs).toBe(original?.startMs);
      expect(passage.endMs).toBe(original?.endMs);
      expect(passage.text).toBe(original?.text);
      expect(passage.language).toBe(original?.language);
      if (passage.index === 1 || passage.index === 3) {
        expect(passage.speakerKey).toBe("participant-42");
        expect(passage.speakerName).toBe("Bob");
        expect(passage.unknownSpeakerNumber).toBeNull();
      } else {
        expect(passage).toEqual(original);
      }
    }
  });

  it("updatePassageSpeakersBySpeakerKey resolves to 0 and changes nothing when no passage has the key", async () => {
    const ids = requireIds();
    await repository.insertPassages(
      ids.transcriptId,
      [0, 1, 2].map((i) => makePassage(i))
    );
    const before = await repository.findAllPassages(ids.transcriptId);

    const resolved = await repository.updatePassageSpeakersBySpeakerKey({
      transcriptId: ids.transcriptId,
      speakerKey: "speaker-unknown-9",
      resolvedSpeakerKey: "participant-42",
      speakerName: "Bob",
    });

    expect(resolved).toBe(0);
    expect(await repository.findAllPassages(ids.transcriptId)).toEqual(before);
  });

  it("updatePassageSpeakersBySpeakerKey is scoped to one transcript", async () => {
    const ids = requireIds();
    await repository.insertPassages(
      ids.transcriptId,
      [1, 3].map((i) => makePassage(i))
    );
    if (userId === undefined) throw new Error("Test user was not created");
    const startTime = new Date("2030-01-02T10:00:00.000Z");
    const otherBooking = await prisma.booking.create({
      data: {
        uid: `notetaker-transcript-it-${runId}-other`,
        title: "Notetaker transcript integration test, second booking",
        startTime,
        endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
        userId,
      },
      select: { id: true },
    });

    try {
      const otherSession = await prisma.notetakerSession.create({
        data: {
          bookingId: otherBooking.id,
          platform: "GOOGLE_MEET",
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          botProvider: "FAKE",
          displayName: "Notetaker",
          scheduledStartAt: startTime,
        },
        select: { id: true },
      });
      const otherTranscript = await repository.createIfMissing({
        sessionId: otherSession.id,
        bookingId: otherBooking.id,
      });
      await repository.insertPassages(
        otherTranscript.id,
        [1, 3].map((i) => makePassage(i))
      );

      const resolved = await repository.updatePassageSpeakersBySpeakerKey({
        transcriptId: ids.transcriptId,
        speakerKey: "speaker-unknown-1",
        resolvedSpeakerKey: "participant-42",
        speakerName: "Bob",
      });

      expect(resolved).toBe(2);
      const untouched = await repository.findAllPassages(otherTranscript.id);
      expect(untouched.map((p) => p.speakerKey)).toEqual(["speaker-unknown-1", "speaker-unknown-1"]);
      expect(untouched.map((p) => p.speakerName)).toEqual([null, null]);
      expect(untouched.map((p) => p.unknownSpeakerNumber)).toEqual([1, 1]);
    } finally {
      await prisma.booking.deleteMany({ where: { id: otherBooking.id } });
    }
  });

  it("updatePassageSpeakersBySpeakerKey can resolve onto a key that already exists in the transcript", async () => {
    const ids = requireIds();
    await repository.insertPassages(
      ids.transcriptId,
      [0, 1, 2, 3, 4].map((i) => makePassage(i))
    );

    const resolved = await repository.updatePassageSpeakersBySpeakerKey({
      transcriptId: ids.transcriptId,
      speakerKey: "speaker-unknown-1",
      resolvedSpeakerKey: "speaker-known",
      speakerName: "Alice",
    });

    expect(resolved).toBe(2);
    const all = await repository.findAllPassages(ids.transcriptId);
    expect(all.map((p) => p.speakerKey)).toEqual(Array(5).fill("speaker-known"));
    expect(all.map((p) => p.speakerName)).toEqual(Array(5).fill("Alice"));
  });

  it("updatePassageSpeakersBySpeakerKey is idempotent", async () => {
    const ids = requireIds();
    await repository.insertPassages(
      ids.transcriptId,
      [0, 1, 2, 3, 4].map((i) => makePassage(i))
    );
    const params = {
      transcriptId: ids.transcriptId,
      speakerKey: "speaker-unknown-1",
      resolvedSpeakerKey: "participant-42",
      speakerName: "Bob",
    };

    expect(await repository.updatePassageSpeakersBySpeakerKey(params)).toBe(2);
    expect(await repository.updatePassageSpeakersBySpeakerKey(params)).toBe(0);
  });

  it("stores speakerNamesAvailable through update without disturbing the other columns", async () => {
    const ids = requireIds();
    const created = await repository.findById(ids.transcriptId);
    expect(created?.speakerNamesAvailable).toBeNull();

    const markedUnavailable = await repository.update(ids.transcriptId, { speakerNamesAvailable: false });
    expect(markedUnavailable.speakerNamesAvailable).toBe(false);

    const afterOtherUpdate = await repository.update(ids.transcriptId, { passageCount: 3 });
    expect(afterOtherUpdate.speakerNamesAvailable).toBe(false);
    expect(afterOtherUpdate.passageCount).toBe(3);

    const markedAvailable = await repository.update(ids.transcriptId, { speakerNamesAvailable: true });
    expect(markedAvailable.speakerNamesAvailable).toBe(true);

    expect(markedAvailable.language).toBe(created?.language);
    expect(markedAvailable.completeness).toBe(created?.completeness);
    expect(markedAvailable.durationMs).toBe(created?.durationMs);
  });
});

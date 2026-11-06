import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
const mockUuidv4 = vi.fn();
const mockConvertSvgToPng = vi.fn();

vi.mock("uuid", () => ({
  v4: (...args: unknown[]) => mockUuidv4(...args),
}));

vi.mock("@calcom/prisma", () => ({
  prisma: {
    avatar: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

vi.mock("./imageUtils", () => ({
  convertSvgToPng: (...args: unknown[]) => mockConvertSvgToPng(...args),
}));

import { uploadAvatar } from "./avatar";

describe("uploadAvatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConvertSvgToPng.mockImplementation((data: string) => Promise.resolve(`processed_${data}`));
    mockUpsert.mockResolvedValue(undefined);
    mockUuidv4.mockReturnValue("generated-uuid-1234");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates new objectKey via uuidv4 when no existing avatar", async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await uploadAvatar({ userId: 1, avatar: "image-data" });

    expect(mockUuidv4).toHaveBeenCalled();
    expect(result).toBe("/api/avatar/generated-uuid-1234.png?v=1767225600000");
  });

  it("reuses existing objectKey and does NOT call uuidv4", async () => {
    mockFindUnique.mockResolvedValue({ objectKey: "existing-key-5678" });

    const result = await uploadAvatar({ userId: 1, avatar: "image-data" });

    expect(mockUuidv4).not.toHaveBeenCalled();
    expect(result).toBe("/api/avatar/existing-key-5678.png?v=1767225600000");
  });

  it("includes objectKey in create clause but NOT in update clause", async () => {
    mockFindUnique.mockResolvedValue(null);

    await uploadAvatar({ userId: 1, avatar: "image-data" });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ objectKey: "generated-uuid-1234" }),
        update: expect.not.objectContaining({ objectKey: expect.anything() }),
      })
    );
  });

  it("returns /api/avatar/{objectKey}.png with a version query", async () => {
    mockFindUnique.mockResolvedValue({ objectKey: "my-key" });

    const result = await uploadAvatar({ userId: 5, avatar: "data" });

    expect(result).toBe("/api/avatar/my-key.png?v=1767225600000");
  });

  it("returns a different URL on re-upload while keeping the same objectKey", async () => {
    mockFindUnique.mockResolvedValue({ objectKey: "k" });

    const first = await uploadAvatar({ userId: 5, avatar: "data" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const second = await uploadAvatar({ userId: 5, avatar: "data" });

    expect(first.startsWith("/api/avatar/k.png?v=")).toBe(true);
    expect(second.startsWith("/api/avatar/k.png?v=")).toBe(true);
    expect(second).not.toBe(first);
  });

  it("uses correct compound unique key for lookup and upsert", async () => {
    mockFindUnique.mockResolvedValue(null);

    await uploadAvatar({ userId: 42, avatar: "data" });

    const expectedWhere = {
      teamId_userId_isBanner: { teamId: 0, userId: 42, isBanner: false },
    };

    expect(mockFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
  });

  it("calls convertSvgToPng on input data", async () => {
    mockFindUnique.mockResolvedValue(null);

    await uploadAvatar({ userId: 1, avatar: "svg-data-here" });

    expect(mockConvertSvgToPng).toHaveBeenCalledWith("svg-data-here");
  });

  it("passes processed data to upsert create and update", async () => {
    mockFindUnique.mockResolvedValue(null);

    await uploadAvatar({ userId: 1, avatar: "raw-data" });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ data: "processed_raw-data" }),
        update: expect.objectContaining({ data: "processed_raw-data" }),
      })
    );
  });

  it("sets isBanner to false in create clause", async () => {
    mockFindUnique.mockResolvedValue(null);

    await uploadAvatar({ userId: 1, avatar: "data" });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isBanner: false }),
      })
    );
  });
});

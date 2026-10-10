import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { z } from "zod";
import type {
  INotetakerActivityRepository,
  NotetakerActivityRecord,
} from "./interfaces/INotetakerActivityRepository";

const activitySelect = {
  id: true,
  bookingId: true,
  sessionId: true,
  action: true,
  actorType: true,
  actorUserId: true,
  actorName: true,
  detail: true,
  createdAt: true,
} satisfies Prisma.NotetakerActivitySelect;

type ActivityRow = Prisma.NotetakerActivityGetPayload<{ select: typeof activitySelect }>;

const activityDetailSchema = z.record(z.unknown());

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// Prisma's InputJsonValue rejects Record<string, unknown>, so the detail payload is narrowed explicitly.
// Values that JSON cannot represent (undefined, functions, non-finite numbers) are dropped.
function toInputJson(value: unknown): Prisma.InputJsonValue | null {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => toInputJson(item));
  }
  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    const result: { [key: string]: Prisma.InputJsonValue | null } = {};
    for (const [key, entry] of Object.entries(value)) {
      const converted = toInputJson(entry);
      if (converted === null && (entry === undefined || typeof entry === "function")) continue;
      result[key] = converted;
    }
    return result;
  }
  return null;
}

export class PrismaNotetakerActivityRepository implements INotetakerActivityRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async create(data: Omit<NotetakerActivityRecord, "id" | "createdAt">): Promise<NotetakerActivityRecord> {
    const detailJson = data.detail === null ? null : toInputJson(data.detail);
    const row = await this.prismaClient.notetakerActivity.create({
      data: {
        bookingId: data.bookingId,
        sessionId: data.sessionId,
        action: data.action,
        actorType: data.actorType,
        actorUserId: data.actorUserId,
        actorName: data.actorName,
        ...(detailJson !== null ? { detail: detailJson } : {}),
      },
      select: activitySelect,
    });
    return this.toRecord(row);
  }

  async findByBookingId({
    bookingId,
    limit,
  }: {
    bookingId: number;
    limit: number;
  }): Promise<NotetakerActivityRecord[]> {
    const rows = await this.prismaClient.notetakerActivity.findMany({
      where: { bookingId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: activitySelect,
    });
    return rows.map((row) => this.toRecord(row));
  }

  async existsByBookingIdAndActionAndActorUserId({
    bookingId,
    action,
    actorUserId,
  }: {
    bookingId: number;
    action: NotetakerActivityRecord["action"];
    actorUserId: number;
  }): Promise<boolean> {
    const row = await this.prismaClient.notetakerActivity.findFirst({
      where: { bookingId, action, actorUserId },
      select: { id: true },
    });
    return row !== null;
  }

  async findDistinctActorUserIdsByBookingIdAndAction({
    bookingId,
    action,
  }: {
    bookingId: number;
    action: NotetakerActivityRecord["action"];
  }): Promise<number[]> {
    const rows = await this.prismaClient.notetakerActivity.findMany({
      where: { bookingId, action, actorUserId: { not: null } },
      distinct: ["actorUserId"],
      select: { actorUserId: true },
    });
    const userIds: number[] = [];
    for (const row of rows) {
      if (row.actorUserId !== null) userIds.push(row.actorUserId);
    }
    return userIds;
  }

  private toRecord(row: ActivityRow): NotetakerActivityRecord {
    return {
      id: row.id,
      bookingId: row.bookingId,
      sessionId: row.sessionId,
      action: row.action,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorName: row.actorName,
      detail: this.toDetail(row.detail),
      createdAt: row.createdAt,
    };
  }

  // History list must keep rendering even if a stored detail is not a JSON object.
  private toDetail(detail: ActivityRow["detail"]): Record<string, unknown> | null {
    if (detail === null) return null;
    const parsed = activityDetailSchema.safeParse(detail);
    if (!parsed.success) return null;
    return parsed.data;
  }
}

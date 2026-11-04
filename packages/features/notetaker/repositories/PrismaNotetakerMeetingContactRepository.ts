import type { PrismaClient } from "@calcom/prisma";
import type {
  INotetakerMeetingContactRepository,
  NotetakerMeetingContactRecord,
  NotetakerMeetingContactSource,
} from "./interfaces/INotetakerMeetingContactRepository";

export class PrismaNotetakerMeetingContactRepository implements INotetakerMeetingContactRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async listByBookingId(bookingId: number): Promise<NotetakerMeetingContactRecord[]> {
    return await this.prismaClient.notetakerMeetingContact.findMany({
      where: { bookingId },
      select: { email: true, name: true, source: true },
      orderBy: [{ createdAt: "asc" }, { email: "asc" }],
    });
  }

  async replaceForSource(params: {
    bookingId: number;
    source: NotetakerMeetingContactSource;
    contacts: { email: string; name: string | null }[];
  }): Promise<void> {
    const { bookingId, source, contacts } = params;
    // One transaction so a reader never sees the source half-replaced. skipDuplicates keeps a row
    // of the other source when it already holds the email, instead of failing on the unique key.
    await this.prismaClient.$transaction([
      this.prismaClient.notetakerMeetingContact.deleteMany({ where: { bookingId, source } }),
      this.prismaClient.notetakerMeetingContact.createMany({
        data: contacts.map((contact) => ({ bookingId, email: contact.email, name: contact.name, source })),
        skipDuplicates: true,
      }),
    ]);
  }
}

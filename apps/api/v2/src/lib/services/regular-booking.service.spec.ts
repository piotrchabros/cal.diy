// platform-libraries is mocked virtually because its dist is only present after `yarn dev:build`.
import { RegularBookingService } from "@/lib/services/regular-booking.service";

const baseCreateBooking = jest.fn();
const baseRescheduleBooking = jest.fn();

jest.mock(
  "@calcom/platform-libraries/bookings",
  () => ({
    RegularBookingService: class {
      createBooking(input: unknown) {
        return baseCreateBooking(input);
      }
      rescheduleBooking(input: unknown) {
        return baseRescheduleBooking(input);
      }
    },
  }),
  { virtual: true }
);
jest.mock("@/lib/repositories/prisma-booking.repository", () => ({ PrismaBookingRepository: class {} }));
jest.mock("@/lib/repositories/prisma-user.repository", () => ({ PrismaUserRepository: class {} }));
jest.mock("@/lib/services/booking-event-handler.service", () => ({ BookingEventHandlerService: class {} }));
jest.mock("@/lib/services/check-booking-and-duration-limits.service", () => ({
  CheckBookingAndDurationLimitsService: class {},
}));
jest.mock("@/lib/services/hashed-link.service", () => ({ HashedLinkService: class {} }));
jest.mock("@/lib/services/lucky-user.service", () => ({ LuckyUserService: class {} }));
jest.mock("@/lib/services/tasker/booking-emails-sms-tasker.service", () => ({
  BookingEmailAndSmsTasker: class {},
}));
jest.mock("@/modules/prisma/prisma-write.service", () => ({ PrismaWriteService: class {} }));

type Deps = ConstructorParameters<typeof RegularBookingService>;

function buildService(): RegularBookingService {
  const deps = [{}, { prisma: {} }, {}, {}, {}, {}, {}, {}, {}] as unknown as Deps;
  return new RegularBookingService(...deps);
}

const bookingData = { eventTypeId: 1 } as Parameters<
  RegularBookingService["createBooking"]
>[0]["bookingData"];

describe("RegularBookingService (API v2)", () => {
  beforeEach(() => {
    baseCreateBooking.mockReset().mockResolvedValue({ uid: "created" });
    baseRescheduleBooking.mockReset().mockResolvedValue({ uid: "rescheduled" });
  });

  it("skips the web host-organization check when creating a booking, keeping the rest of the meta", async () => {
    const result = await buildService().createBooking({
      bookingData,
      bookingMeta: { userId: 3, hostname: "localhost:5555", platformClientId: "client" },
    });

    expect(result).toEqual({ uid: "created" });
    expect(baseCreateBooking).toHaveBeenCalledWith({
      bookingData,
      bookingMeta: {
        userId: 3,
        hostname: "localhost:5555",
        platformClientId: "client",
        skipHostOrganizationCheck: true,
      },
    });
  });

  it("skips the check when no booking meta is passed", async () => {
    await buildService().createBooking({ bookingData });

    expect(baseCreateBooking).toHaveBeenCalledWith({
      bookingData,
      bookingMeta: { skipHostOrganizationCheck: true },
    });
  });

  it("skips the check when rescheduling a booking", async () => {
    const result = await buildService().rescheduleBooking({ bookingData, bookingMeta: { userId: 3 } });

    expect(result).toEqual({ uid: "rescheduled" });
    expect(baseRescheduleBooking).toHaveBeenCalledWith({
      bookingData,
      bookingMeta: { userId: 3, skipHostOrganizationCheck: true },
    });
  });
});

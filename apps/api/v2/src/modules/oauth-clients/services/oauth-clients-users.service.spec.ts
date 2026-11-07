jest.mock(
  "@calcom/platform-libraries",
  () => ({
    CreationSource: { API_V2: "API_V2" },
    createNewUsersConnectToOrgIfExists: jest.fn(),
    slugify: (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
  }),
  { virtual: true }
);
jest.mock("@/platform/calendars/services/calendars.service", () => ({ CalendarsService: class {} }));
jest.mock("@/platform/event-types/event-types_2024_04_15/services/event-types.service", () => ({
  EventTypesService_2024_04_15: class {},
}));
jest.mock("@/platform/schedules/schedules_2024_04_15/services/schedules.service", () => ({
  SchedulesService_2024_04_15: class {},
}));
jest.mock("@/modules/users/users.repository", () => ({ UsersRepository: class {} }));
jest.mock("@/modules/tokens/tokens.repository", () => ({ TokensRepository: class {} }));

import { OAuthClientUsersService } from "./oauth-clients-users.service";
import type { TokensRepository } from "@/modules/tokens/tokens.repository";
import type { UsersRepository } from "@/modules/users/users.repository";
import type { CalendarsService } from "@/platform/calendars/services/calendars.service";
import type { EventTypesService_2024_04_15 } from "@/platform/event-types/event-types_2024_04_15/services/event-types.service";
import type { SchedulesService_2024_04_15 } from "@/platform/schedules/schedules_2024_04_15/services/schedules.service";

describe("OAuthClientUsersService.updateOAuthClientUser", () => {
  let updateUsernameAndUpsertOrgProfile: jest.Mock;
  let update: jest.Mock;
  let service: OAuthClientUsersService;

  beforeEach(() => {
    updateUsernameAndUpsertOrgProfile = jest.fn().mockResolvedValue(undefined);
    update = jest.fn().mockResolvedValue({ id: 3 });
    const usersRepository = { updateUsernameAndUpsertOrgProfile, update } as unknown as UsersRepository;
    service = new OAuthClientUsersService(
      usersRepository,
      {} as TokensRepository,
      {} as EventTypesService_2024_04_15,
      {} as SchedulesService_2024_04_15,
      {} as CalendarsService
    );
  });

  it("renames the user and their org profile together when the email changes", async () => {
    await service.updateOAuthClientUser("client1", 3, { email: "jane@example.com" }, 7);

    expect(updateUsernameAndUpsertOrgProfile).toHaveBeenCalledWith(3, 7, "jane-client1-example-com");
    expect(update).toHaveBeenCalledWith(3, { email: "jane+client1@example.com" });
  });

  it("does not touch the username without an email change", async () => {
    await service.updateOAuthClientUser("client1", 3, { name: "Jane" }, 7);

    expect(updateUsernameAndUpsertOrgProfile).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(3, { name: "Jane" });
  });

  it("does not update the other fields when the rename fails", async () => {
    updateUsernameAndUpsertOrgProfile.mockRejectedValue(new Error("Unique constraint failed"));

    await expect(
      service.updateOAuthClientUser("client1", 3, { email: "jane@example.com" }, 7)
    ).rejects.toThrow("Unique constraint failed");
    expect(update).not.toHaveBeenCalled();
  });
});

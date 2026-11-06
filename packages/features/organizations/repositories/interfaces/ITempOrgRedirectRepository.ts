export type RedirectTypeDto = "User" | "Team" | "UserEventType" | "TeamEventType";

export type TempOrgRedirectRecord = { from: string; toUrl: string };

export interface ITempOrgRedirectRepository {
  findEnabledByFromSlugs(params: {
    fromOrgId: number;
    type: RedirectTypeDto;
    fromSlugs: string[];
  }): Promise<TempOrgRedirectRecord[]>;
}

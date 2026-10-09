export type EventTypeNotetakerSettingsRecord = {
  eventTypeId: number;
  enabledByDefault: boolean;
  updatedAt: Date;
};

export type NotetakerEventTypeContext = {
  id: number;
  userId: number | null;
  teamId: number | null;
  locations: unknown;
  ownerName: string | null;
  settings: EventTypeNotetakerSettingsRecord | null;
};

export interface IEventTypeNotetakerSettingsRepository {
  findByEventTypeId(eventTypeId: number): Promise<EventTypeNotetakerSettingsRecord | null>;
  upsert(data: { eventTypeId: number; enabledByDefault: boolean }): Promise<EventTypeNotetakerSettingsRecord>;
  findByEventTypeIdIncludeEventType(eventTypeId: number): Promise<NotetakerEventTypeContext | null>;
}

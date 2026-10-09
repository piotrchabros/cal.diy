export type NotetakerUserRecord = {
  id: number;
  name: string | null;
  email: string;
  locale: string | null;
  timeZone: string;
};

// Narrow port over the users repository, so notetaker services depend on five fields
// instead of the full user row that UserRepository.findByIds selects.
export interface INotetakerUserLookup {
  findByIds(params: { ids: number[] }): Promise<NotetakerUserRecord[]>;
}

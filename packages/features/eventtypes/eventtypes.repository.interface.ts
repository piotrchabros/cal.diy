/**
 * EventTypes Repository Interface
 *
 * Central interface for EventType repository methods.
 */

export interface IEventTypesRepository {
  /**
   * @param eventTypeId - The event type to check
   * @returns Parent ID if this is a managed child event type, null otherwise
   */
  findParentEventTypeId(eventTypeId: number): Promise<number | null>;
  /**
   * @param id - The event type to load
   * @returns The owner and team scope of the event type, or null when it does not exist
   */
  findByIdWithUserIdAndTeamId(id: { id: number }): Promise<{
    userId: number | null;
    teamId: number | null;
  } | null>;
}

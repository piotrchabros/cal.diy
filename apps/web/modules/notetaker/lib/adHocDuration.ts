export const AD_HOC_DURATION_CHOICES_MINUTES = [15, 30, 45, 60, 90, 120, 180, 240];

const MIN_DURATION_MINUTES = AD_HOC_DURATION_CHOICES_MINUTES[0];

export function pickAdHocDurationMinutes(remainingMinutes: number, maxDurationMinutes: number): number {
  const allowed = AD_HOC_DURATION_CHOICES_MINUTES.filter((minutes) => minutes <= maxDurationMinutes);
  if (allowed.length === 0) return MIN_DURATION_MINUTES;
  return allowed.find((minutes) => minutes >= remainingMinutes) ?? allowed[allowed.length - 1];
}

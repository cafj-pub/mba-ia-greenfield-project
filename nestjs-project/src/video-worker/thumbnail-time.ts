// phase-03-videos/TD-04: frame at 10% of the duration, 0s when unknown
const THUMBNAIL_POSITION = 0.1;

export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return durationSeconds * THUMBNAIL_POSITION;
}

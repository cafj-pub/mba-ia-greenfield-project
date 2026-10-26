import type { JobsOptions } from 'bullmq';

/** Payload of the `process-video` job (phase-03 plan → Events/Messages). */
export interface ProcessVideoJobData {
  videoId: string;
}

// phase-03-videos/TD-07: 3 attempts, exponential backoff 5s → 10s.
// jobId = videoId deduplicates re-enqueues of the same video.
export const processVideoJobOptions = (videoId: string): JobsOptions => ({
  jobId: videoId,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
});

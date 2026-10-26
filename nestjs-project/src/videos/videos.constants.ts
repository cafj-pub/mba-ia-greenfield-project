export const VIDEO_STATUS = {
  DRAFT: 'draft',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
} as const;

export type VideoStatus = (typeof VIDEO_STATUS)[keyof typeof VIDEO_STATUS];

// 10 GiB — phase-03-videos/TD-02
export const MAX_VIDEO_FILE_SIZE = 10 * 1024 * 1024 * 1024;

// 64 MiB parts → a 10 GiB upload has 160 parts (S3 limit: 10,000)
export const UPLOAD_PART_SIZE = 64 * 1024 * 1024;

export const UPLOAD_URL_EXPIRATION_SECONDS = 60 * 60;

// phase-03-videos/TD-06
export const PLAYBACK_URL_EXPIRATION_SECONDS = 15 * 60;

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export const VIDEO_SLUG_LENGTH = 11;

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export const videoSourceKey = (videoId: string): string =>
  `videos/${videoId}/source`;

export const videoThumbnailKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;

// Worker input URL lifetime; ffprobe + one-frame extraction finish well within it
export const WORKER_SOURCE_URL_EXPIRATION_SECONDS = 60 * 60;

import type { VideoMetadata } from '../videos/entities/video.entity';
import { UnsupportedMediaError } from './media-processing.error';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
  size?: string;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ffprobe reports rates as fractions ("30000/1001"); "0/0" means unknown
function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!den || !Number.isFinite(num / den)) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/** Maps `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbeOutput(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height || !video.codec_name) {
    throw new UnsupportedMediaError('No video stream found');
  }
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const format = output.format ?? {};
  const duration = toNumber(format.duration);

  return {
    durationSeconds:
      duration === null ? null : Math.round(duration * 1000) / 1000,
    metadata: {
      format_name: format.format_name ?? 'unknown',
      bit_rate: toNumber(format.bit_rate),
      size: toNumber(format.size),
      width: video.width,
      height: video.height,
      video_codec: video.codec_name,
      audio_codec: audio?.codec_name ?? null,
      frame_rate: parseFrameRate(video.avg_frame_rate),
    },
  };
}

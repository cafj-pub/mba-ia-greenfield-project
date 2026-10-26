import { spawnSync } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface SampleVideoOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  withAudio?: boolean;
}

/** Generates a small H.264/AAC MP4 with ffmpeg's test sources. */
export function createSampleVideo(options: SampleVideoOptions = {}): string {
  const {
    durationSeconds = 2,
    width = 320,
    height = 240,
    withAudio = true,
  } = options;
  const path = join(tmpdir(), `streamtube-sample-${randomUUID()}.mp4`);
  const args = [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=10`,
    ...(withAudio
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`]
      : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...(withAudio ? ['-c:a', 'aac'] : []),
    '-movflags',
    '+faststart',
    path,
  ];
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Fixture generation failed: ${result.stderr}`);
  }
  return path;
}

/** Random bytes with a video extension — not decodable by ffmpeg. */
export function createCorruptVideo(size = 64 * 1024): string {
  const path = join(tmpdir(), `streamtube-corrupt-${randomUUID()}.mp4`);
  writeFileSync(path, randomBytes(size));
  return path;
}

export function removeFixture(path: string): void {
  rmSync(path, { force: true });
}

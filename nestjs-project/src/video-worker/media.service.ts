import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import { MediaProcessingError } from './media-processing.error';
import { FfprobeOutput, parseProbeOutput, ProbeResult } from './probe-parser';

const STDERR_TAIL_LENGTH = 2000;
// A stalled HTTP read must not hold the worker (concurrency 1) forever
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const THUMBNAIL_WIDTH = 1280;

/**
 * Drives the ffprobe/ffmpeg CLIs (phase-03-videos/TD-04). `input` may be a
 * file path or an HTTP(S) URL — FFmpeg reads remote input with range
 * requests, so the source video is never written to local disk.
 */
@Injectable()
export class MediaService {
  async probe(input: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      input,
    ]);
    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout.toString('utf8')) as FfprobeOutput;
    } catch {
      throw new MediaProcessingError('ffprobe returned invalid JSON');
    }
    return parseProbeOutput(parsed);
  }

  /** Single JPEG frame at `atSeconds`, scaled to 1280px width (aspect kept). */
  async extractThumbnail(input: string, atSeconds: number): Promise<Buffer> {
    const jpeg = await this.run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `scale=${THUMBNAIL_WIDTH}:-2`,
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (jpeg.length === 0) {
      throw new MediaProcessingError(
        `ffmpeg produced no frame at ${atSeconds}s`,
      );
    }
    return jpeg;
  }

  private run(command: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: PROCESS_TIMEOUT_MS,
      });
      const stdout: Buffer[] = [];
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_LENGTH);
      });
      child.on('error', (err) =>
        reject(
          new MediaProcessingError(
            `${command} failed to start: ${err.message}`,
          ),
        ),
      );
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve(Buffer.concat(stdout));
          return;
        }
        const reason = signal ? `killed by ${signal}` : `exit code ${code}`;
        reject(
          new MediaProcessingError(`${command} ${reason}: ${stderr.trim()}`),
        );
      });
    });
  }
}

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import type { ProcessVideoJobData } from '../videos/video-processing.job';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { UnsupportedMediaError } from './media-processing.error';
import { VideoProcessingService } from './video-processing.service';

// One job at a time per container; scale with replicas (phase-03-videos/TD-04)
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    try {
      await this.processingService.process(job.data.videoId);
    } catch (err) {
      // Errors propagate so BullMQ retries (TD-07); a file that is not a
      // usable video fails immediately instead of burning the attempts.
      if (err instanceof UnsupportedMediaError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const isFinal =
      error instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!isFinal) {
      this.logger.warn(
        `Video ${job.data.videoId} attempt ${job.attemptsMade}/${attempts} failed: ${error.message}`,
      );
      return;
    }
    // Event handler (background context): log instead of rethrowing,
    // per nestjs-services.md — there is no caller to propagate to.
    try {
      await this.processingService.markFailed(job.data.videoId, error.message);
    } catch (markError) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        markError instanceof Error ? markError.stack : String(markError),
      );
    }
  }
}

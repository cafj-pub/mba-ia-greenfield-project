import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  ProcessVideoJobData,
  processVideoJobOptions,
} from './video-processing.job';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      processVideoJobOptions(videoId),
    );
  }
}

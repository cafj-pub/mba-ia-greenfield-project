import { Test } from '@nestjs/testing';
import { Job, UnrecoverableError } from 'bullmq';
import type { ProcessVideoJobData } from '../videos/video-processing.job';
import {
  MediaProcessingError,
  UnsupportedMediaError,
} from './media-processing.error';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = 'video-1';

function buildJob(
  attemptsMade: number,
  attempts = 3,
): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let processingService: { process: jest.Mock; markFailed: jest.Mock };

  beforeEach(async () => {
    processingService = {
      process: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: VideoProcessingService, useValue: processingService },
      ],
    }).compile();
    processor = module.get(VideoProcessingProcessor);
  });

  describe('process', () => {
    it('should delegate the job to the processing service', async () => {
      await processor.process(buildJob(0));

      expect(processingService.process).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should rethrow processing errors so BullMQ retries', async () => {
      const error = new MediaProcessingError('ffprobe exit code 1');
      processingService.process.mockRejectedValue(error);

      await expect(processor.process(buildJob(0))).rejects.toBe(error);
    });

    it('should turn an unsupported file into an UnrecoverableError (no retries)', async () => {
      processingService.process.mockRejectedValue(
        new UnsupportedMediaError('No video stream found'),
      );

      await expect(processor.process(buildJob(0))).rejects.toThrow(
        UnrecoverableError,
      );
    });
  });

  describe('onFailed', () => {
    it('should not mark the video failed while attempts remain', async () => {
      await processor.onFailed(buildJob(1), new Error('transient'));

      expect(processingService.markFailed).not.toHaveBeenCalled();
    });

    it('should mark the video failed after the final attempt', async () => {
      await processor.onFailed(buildJob(3), new Error('still broken'));

      expect(processingService.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'still broken',
      );
    });

    it('should mark the video failed immediately on an UnrecoverableError', async () => {
      await processor.onFailed(
        buildJob(1),
        new UnrecoverableError('No video stream found'),
      );

      expect(processingService.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'No video stream found',
      );
    });

    it('should swallow and log a failure to mark the video (background handler)', async () => {
      processingService.markFailed.mockRejectedValue(new Error('DB down'));

      await expect(
        processor.onFailed(buildJob(3), new Error('broken')),
      ).resolves.toBeUndefined();
    });
  });
});

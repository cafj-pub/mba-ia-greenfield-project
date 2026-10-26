import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { testBullRootModule } from '../test/queue';
import { ProcessVideoJobData } from './video-processing.job';
import { VideoProcessingProducer } from './video-processing.producer';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';

describe('VideoProcessingProducer (integration — Redis)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        testBullRootModule('test-producer'),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('should enqueue process-video with the video id and the retry policy', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    expect(await job!.getState()).toBe('waiting');
  });

  it('should deduplicate a second enqueue of the same video', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    expect(await queue.getWaitingCount()).toBe(1);
  });
});

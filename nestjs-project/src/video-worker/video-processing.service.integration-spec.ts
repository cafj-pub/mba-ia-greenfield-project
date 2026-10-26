import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createCorruptVideo,
  createSampleVideo,
  removeFixture,
} from '../test/media-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import {
  UPLOAD_PART_SIZE,
  videoSourceKey,
  videoThumbnailKey,
} from '../videos/videos.constants';
import type { VideoStatus } from '../videos/videos.constants';
import { MediaProcessingError } from './media-processing.error';
import { MediaService } from './media.service';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration — DB + MinIO + ffmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let processing: VideoProcessingService;
  let channelId: string;
  let sample: Buffer;
  let corrupt: Buffer;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [MediaService, VideoProcessingService],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    storage = module.get(StorageService);
    processing = module.get(VideoProcessingService);

    const samplePath = createSampleVideo({ durationSeconds: 2 });
    const corruptPath = createCorruptVideo();
    sample = readFileSync(samplePath);
    corrupt = readFileSync(corruptPath);
    removeFixture(samplePath);
    removeFixture(corruptPath);
  }, 60000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'worker', nickname: 'worker', user_id: user.id });
    channelId = channel.id;
  });

  afterEach(async () => {
    for (const video of await videoRepository.find()) {
      await storage.deleteObject(video.source_key);
      await storage.deleteObject(videoThumbnailKey(video.id));
    }
  });

  let slugCounter = 0;
  async function seedVideo(
    content: Buffer,
    status: VideoStatus = 'processing',
  ): Promise<Video> {
    const id = randomUUID();
    await storage.putObject(videoSourceKey(id), content, 'video/mp4');
    return videoRepository.save(
      videoRepository.create({
        id,
        channel_id: channelId,
        slug: `wrk${String(++slugCounter).padStart(8, '0')}`,
        title: 'Worker video',
        status,
        original_file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        file_size: content.length,
        part_size: UPLOAD_PART_SIZE,
        part_count: 1,
        source_key: videoSourceKey(id),
      }),
    );
  }

  describe('process', () => {
    it('should fill duration, metadata and thumbnail and move the video to ready', async () => {
      const video = await seedVideo(sample);

      await processing.process(video.id);

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('ready');
      expect(row.duration_seconds).toBeCloseTo(2, 0);
      expect(row.metadata).toMatchObject({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
      });
      expect(row.thumbnail_key).toBe(videoThumbnailKey(video.id));
      expect(row.processed_at).toBeInstanceOf(Date);
      expect(row.processing_error).toBeNull();
      expect(await storage.getObjectSize(row.thumbnail_key!)).toBeGreaterThan(
        0,
      );
    });

    it('should be idempotent when the same job is delivered twice', async () => {
      const video = await seedVideo(sample);

      await processing.process(video.id);
      const first = await videoRepository.findOneByOrFail({ id: video.id });
      await processing.process(video.id);

      const second = await videoRepository.findOneByOrFail({ id: video.id });
      expect(second.status).toBe('ready');
      expect(second.processed_at).toEqual(first.processed_at);
    });

    it.each<VideoStatus>(['draft', 'failed'])(
      'should leave a %s video untouched',
      async (status) => {
        const video = await seedVideo(sample, status);

        await processing.process(video.id);

        const row = await videoRepository.findOneByOrFail({ id: video.id });
        expect(row.status).toBe(status);
        expect(row.thumbnail_key).toBeNull();
      },
    );

    it('should resolve without changes when the video no longer exists', async () => {
      await expect(processing.process(randomUUID())).resolves.toBeUndefined();
    });

    it('should throw MediaProcessingError for an undecodable source and keep the video processing', async () => {
      const video = await seedVideo(corrupt);

      await expect(processing.process(video.id)).rejects.toThrow(
        MediaProcessingError,
      );

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('processing');
    });
  });

  describe('markFailed', () => {
    it('should move a processing video to failed with the reason', async () => {
      const video = await seedVideo(corrupt);

      await processing.markFailed(
        video.id,
        'ffprobe exit code 1: invalid data',
      );

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('failed');
      expect(row.processing_error).toBe('ffprobe exit code 1: invalid data');
    });

    it('should not overwrite a video that already became ready', async () => {
      const video = await seedVideo(sample, 'ready');

      await processing.markFailed(video.id, 'late failure');

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('ready');
      expect(row.processing_error).toBeNull();
    });
  });
});

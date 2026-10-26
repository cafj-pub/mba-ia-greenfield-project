import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { testBullRootModule } from '../test/queue';
import { requestPresignedUrl } from '../test/s3';
import { User } from '../users/entities/user.entity';
import {
  InvalidVideoStatusException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { UPLOAD_PART_SIZE, VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — DB + MinIO)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let videosService: VideosService;
  let storageService: StorageService;
  let queue: Queue;
  let userId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        testBullRootModule(),
        VideosModule,
      ],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    await dataSource
      .getRepository(Channel)
      .save({ name: 'uploader', nickname: 'uploader', user_id: user.id });
    userId = user.id;
  });

  afterEach(async () => {
    for (const video of await videoRepository.find()) {
      if (video.upload_id) {
        await storageService.abortMultipartUpload(
          video.source_key,
          video.upload_id,
        );
      } else {
        await storageService.deleteObject(video.source_key);
      }
    }
  });

  function buildDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
    return {
      title: 'Integration video',
      file_name: 'clip.mp4',
      file_size: UPLOAD_PART_SIZE + 1024,
      mime_type: 'video/mp4',
      ...overrides,
    };
  }

  describe('createDraft', () => {
    it('should persist a draft row pointing at an open multipart upload', async () => {
      const result = await videosService.createDraft(userId, buildDto());

      const row = await videoRepository.findOneByOrFail({
        id: result.video.id,
      });
      expect(row.status).toBe('draft');
      expect(row.slug).toBe(result.video.slug);
      expect(row.part_count).toBe(2);
      expect(row.upload_id).toEqual(expect.any(String));
      expect(row.source_key).toBe(`videos/${row.id}/source`);
      // The upload exists in MinIO and has no parts yet
      expect(
        await storageService.listParts(row.source_key, row.upload_id!),
      ).toEqual([]);
    });

    it('should return one working presigned URL per part', async () => {
      const result = await videosService.createDraft(userId, buildDto());

      expect(result.upload.parts).toHaveLength(2);
      const part = randomBytes(1024);
      const res = await requestPresignedUrl(result.upload.parts[1].url, {
        method: 'PUT',
        body: part,
      });
      expect(res.status).toBe(200);

      const row = await videoRepository.findOneByOrFail({
        id: result.video.id,
      });
      const parts = await storageService.listParts(
        row.source_key,
        row.upload_id!,
      );
      expect(parts.map((p) => [p.partNumber, p.size])).toEqual([[2, 1024]]);
    });

    it('should give every draft a distinct slug', async () => {
      const first = await videosService.createDraft(userId, buildDto());
      const second = await videosService.createDraft(userId, buildDto());

      expect(first.video.slug).not.toBe(second.video.slug);
    });
  });

  describe('getUploadStatus', () => {
    it('should list the stored part and re-issue a URL only for the missing one', async () => {
      const { video, upload } = await videosService.createDraft(
        userId,
        buildDto(),
      );
      const part1 = randomBytes(UPLOAD_PART_SIZE);
      const put = await requestPresignedUrl(upload.parts[0].url, {
        method: 'PUT',
        body: part1,
      });
      expect(put.status).toBe(200);

      const status = await videosService.getUploadStatus(userId, video.slug);

      expect(status.uploaded_parts).toEqual([
        { part_number: 1, size: UPLOAD_PART_SIZE },
      ]);
      expect(status.parts.map((p) => p.part_number)).toEqual([2]);
      const retry = await requestPresignedUrl(status.parts[0].url, {
        method: 'PUT',
        body: randomBytes(1024),
      });
      expect(retry.status).toBe(200);
    });

    it("should not expose another user's video", async () => {
      const { video } = await videosService.createDraft(userId, buildDto());
      const other = await dataSource
        .getRepository(User)
        .save({ email: 'other@example.com', password: 'hashed' });

      await expect(
        videosService.getUploadStatus(other.id, video.slug),
      ).rejects.toThrow(VideoNotFoundException);
      await expect(
        videosService.findOwnedBySlug(other.id, video.slug),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should refuse to resume a video that is no longer a draft', async () => {
      const { video } = await videosService.createDraft(userId, buildDto());
      await videoRepository.update({ id: video.id }, { status: 'processing' });

      await expect(
        videosService.getUploadStatus(userId, video.slug),
      ).rejects.toThrow(InvalidVideoStatusException);
    });
  });

  describe('completeUpload', () => {
    async function uploadAllParts(
      parts: { url: string }[],
      sizes: number[],
    ): Promise<void> {
      for (const [index, part] of parts.entries()) {
        const res = await requestPresignedUrl(part.url, {
          method: 'PUT',
          body: randomBytes(sizes[index]),
        });
        expect(res.status).toBe(200);
      }
    }

    it('should assemble the object, move the video to processing and enqueue the job', async () => {
      const dto = buildDto({ file_size: 3000 });
      const { video, upload } = await videosService.createDraft(userId, dto);
      await uploadAllParts(upload.parts, [3000]);

      const result = await videosService.completeUpload(userId, video.slug);

      expect(result.status).toBe('processing');
      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('processing');
      expect(row.upload_id).toBeNull();
      expect(await storageService.getObjectSize(row.source_key)).toBe(3000);
      const job = await queue.getJob(video.id);
      expect(job?.data).toEqual({ videoId: video.id });
    });

    it('should mark the video failed when the uploaded size differs from the declared one', async () => {
      const { video, upload } = await videosService.createDraft(
        userId,
        buildDto({ file_size: 3000 }),
      );
      await uploadAllParts(upload.parts, [2999]);

      await expect(
        videosService.completeUpload(userId, video.slug),
      ).rejects.toThrow(UploadSizeMismatchException);

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('failed');
      expect(row.upload_id).toBeNull();
      expect(row.processing_error).toBe(
        'Uploaded 2999 bytes but 3000 were declared',
      );
      expect(await queue.getJob(video.id)).toBeUndefined();
    });
  });
});

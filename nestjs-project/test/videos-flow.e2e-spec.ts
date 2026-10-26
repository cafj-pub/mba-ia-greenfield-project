import { readFileSync } from 'fs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createCorruptVideo,
  createSampleVideo,
  removeFixture,
} from '../src/test/media-fixtures';
import { requestPresignedUrl } from '../src/test/s3';
import { Video } from '../src/videos/entities/video.entity';
import { videoThumbnailKey } from '../src/videos/videos.constants';

/**
 * Full pipeline against real infrastructure: API → MinIO (presigned parts)
 * → Redis → the Compose `video-worker` container (ffprobe/ffmpeg) → DB.
 * Requires `docker compose up -d` (video-worker running).
 */

const PASSWORD = 'password123';
const POLL_INTERVAL_MS = 500;
// Failure path: 3 attempts with 5s + 10s backoff before `failed`
const PROCESSING_TIMEOUT_MS = 60_000;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);

interface VideoBody {
  id: string;
  slug: string;
  status: string;
  duration_seconds: number | null;
  metadata: { width: number; height: number; video_codec: string } | null;
  processing_error: string | null;
  processed_at: string | null;
}

describe('Video upload → processing → delivery (e2e, full infrastructure)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let token: string;
  let sample: Buffer;
  let corrupt: Buffer;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    moduleFixture
      .get<ThrottlerStorageService>(ThrottlerStorage)
      .storage.clear();

    const samplePath = createSampleVideo({ durationSeconds: 3 });
    const corruptPath = createCorruptVideo();
    sample = readFileSync(samplePath);
    corrupt = readFileSync(corruptPath);
    removeFixture(samplePath);
    removeFixture(corruptPath);

    await cleanAllTables(dataSource);
    token = await loginAs('flow@example.com');
  }, 60_000);

  afterAll(async () => {
    for (const video of await videoRepository.find()) {
      await storageService.deleteObject(video.source_key);
      await storageService.deleteObject(videoThumbnailKey(video.id));
    }
    await cleanAllTables(dataSource);
    await app.close();
  });

  async function loginAs(email: string): Promise<string> {
    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_email: string, _name: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    return (res.body as { access_token: string }).access_token;
  }

  /** Runs the client side of the upload protocol and returns the slug. */
  async function uploadVideo(content: Buffer, title: string): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title,
        file_name: `${title}.mp4`,
        file_size: content.length,
        mime_type: 'video/mp4',
      })
      .expect(201);
    const body = created.body as {
      video: VideoBody;
      upload: {
        part_size: number;
        parts: { part_number: number; url: string }[];
      };
    };
    expect(body.video.status).toBe('draft');

    for (const part of body.upload.parts) {
      const start = (part.part_number - 1) * body.upload.part_size;
      const res = await requestPresignedUrl(part.url, {
        method: 'PUT',
        body: content.subarray(start, start + body.upload.part_size),
      });
      expect(res.status).toBe(200);
    }

    const completed = await request(app.getHttpServer())
      .post(`/videos/${body.video.slug}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
    expect((completed.body as VideoBody).status).toBe('processing');
    return body.video.slug;
  }

  async function waitUntilProcessed(slug: string): Promise<VideoBody> {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const video = res.body as VideoBody;
      if (video.status !== 'processing') return video;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Video ${slug} still processing after timeout`);
  }

  it('should take a real video from draft to ready and serve it', async () => {
    const slug = await uploadVideo(sample, 'sample');

    const video = await waitUntilProcessed(slug);

    // Processing: duration + metadata + thumbnail, status cycle in the DB
    expect(video.status).toBe('ready');
    expect(video.duration_seconds).toBeCloseTo(3, 0);
    expect(video.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
    });
    expect(video.processed_at).not.toBeNull();
    const row = await videoRepository.findOneByOrFail({ slug });
    expect(row.status).toBe('ready');

    // Thumbnail
    const thumb = await request(app.getHttpServer())
      .get(`/videos/${slug}/thumbnail`)
      .expect(302);
    const image = await requestPresignedUrl(thumb.headers.location);
    expect(image.status).toBe(200);
    expect(image.body.subarray(0, 2).equals(JPEG_SOI)).toBe(true);

    // Streaming: first bytes via a range request, no full download
    const stream = await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .expect(302);
    const ranged = await requestPresignedUrl(stream.headers.location, {
      headers: { range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.body.equals(sample.subarray(0, 1024))).toBe(true);

    // Download: the original file as an attachment
    const download = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .expect(302);
    const file = await requestPresignedUrl(download.headers.location);
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="sample.mp4"',
    );
    expect(file.body.equals(sample)).toBe(true);
  }, 90_000);

  it('should give two uploads of the same file different slugs', async () => {
    const first = await uploadVideo(sample, 'copy-a');
    const second = await uploadVideo(sample, 'copy-b');

    expect(first).not.toBe(second);
    await waitUntilProcessed(first);
    await waitUntilProcessed(second);
  }, 90_000);

  it('should end in failed with the ffprobe error when the file is not a video', async () => {
    const slug = await uploadVideo(corrupt, 'not-a-video');

    const video = await waitUntilProcessed(slug);

    expect(video.status).toBe('failed');
    expect(video.processing_error).toContain('ffprobe');
    await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .expect(409);
  }, 90_000);
});

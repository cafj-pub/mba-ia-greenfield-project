import { randomBytes, randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresignedUrl } from '../src/test/s3';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import {
  MAX_VIDEO_FILE_SIZE,
  UPLOAD_PART_SIZE,
  videoSourceKey,
  videoThumbnailKey,
} from '../src/videos/videos.constants';
import type { VideoStatus } from '../src/videos/videos.constants';

const PASSWORD = 'password123';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;

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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
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
      await storageService.deleteObject(videoThumbnailKey(video.id));
    }
  });

  async function loginAs(email: string): Promise<string> {
    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _name: string, token: string) => {
          confirmationToken = token;
          return Promise.resolve();
        },
      );
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

  const validBody = {
    title: 'My first upload',
    file_name: 'holiday.mp4',
    file_size: UPLOAD_PART_SIZE * 2 + 10,
    mime_type: 'video/mp4',
  };

  describe('POST /videos', () => {
    it('should create a draft and return one presigned URL per part', async () => {
      const token = await loginAs('creator@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody)
        .expect(201);

      const body = res.body as {
        video: { id: string; slug: string; status: string; file_size: number };
        upload: {
          part_size: number;
          part_count: number;
          expires_at: string;
          parts: { part_number: number; url: string }[];
        };
      };
      expect(body.video.status).toBe('draft');
      expect(body.video.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(body.video.file_size).toBe(validBody.file_size);
      expect(body.upload.part_size).toBe(UPLOAD_PART_SIZE);
      expect(body.upload.part_count).toBe(3);
      expect(body.upload.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
      expect(
        body.upload.parts.every((p) =>
          p.url.startsWith(process.env.S3_PUBLIC_ENDPOINT!),
        ),
      ).toBe(true);
      expect(new Date(body.upload.expires_at).getTime()).toBeGreaterThan(
        Date.now(),
      );

      const row = await videoRepository.findOneByOrFail({
        id: body.video.id,
      });
      expect(row.status).toBe('draft');
    });

    it('should accept the 10 GiB maximum', async () => {
      const token = await loginAs('max@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validBody, file_size: MAX_VIDEO_FILE_SIZE })
        .expect(201);

      expect(
        (res.body as { upload: { part_count: number } }).upload.part_count,
      ).toBe(160);
    });

    it.each([
      ['a file above 10 GiB', { file_size: MAX_VIDEO_FILE_SIZE + 1 }],
      ['a MIME type that is not a video', { mime_type: 'image/png' }],
      ['an empty title', { title: '' }],
      ['an unknown property', { visibility: 'public' }],
    ])('should reject %s with 400 VALIDATION_ERROR', async (_label, patch) => {
      const token = await loginAs('invalid@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validBody, ...patch })
        .expect(400);

      expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
      expect(await videoRepository.count()).toBe(0);
    });

    it('should return 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validBody)
        .expect(401);
    });

    it('should not be rate limited by the auth throttler', async () => {
      const token = await loginAs('burst@example.com');

      for (let i = 0; i < 12; i++) {
        await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${token}`)
          .send(validBody)
          .expect(201);
      }
    });
  });

  async function createDraft(
    token: string,
  ): Promise<{ id: string; slug: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(201);
    return (res.body as { video: { id: string; slug: string } }).video;
  }

  describe('GET /videos/:slug', () => {
    it('should return the video to its owner', async () => {
      const token = await loginAs('owner@example.com');
      const draft = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: draft.id,
        slug: draft.slug,
        title: validBody.title,
        status: 'draft',
        duration_seconds: null,
        metadata: null,
      });
    });

    it('should answer 404 to another user and for an unknown slug', async () => {
      const ownerToken = await loginAs('owner2@example.com');
      const draft = await createDraft(ownerToken);
      const otherToken = await loginAs('intruder@example.com');

      const other = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
      const unknown = await request(app.getHttpServer())
        .get('/videos/doesNotExis')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);

      expect((other.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
      expect((unknown.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });

    it('should return 401 without an access token', async () => {
      await request(app.getHttpServer()).get('/videos/anyslug0000').expect(401);
    });
  });

  describe('GET /videos/:slug/upload', () => {
    it('should list no uploaded parts and return URLs for all parts of a fresh draft', async () => {
      const token = await loginAs('resume@example.com');
      const draft = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = res.body as {
        part_count: number;
        uploaded_parts: unknown[];
        parts: { part_number: number }[];
      };
      expect(body.uploaded_parts).toEqual([]);
      expect(body.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    });

    it('should return 409 INVALID_VIDEO_STATUS once the video left draft', async () => {
      const token = await loginAs('late@example.com');
      const draft = await createDraft(token);
      await videoRepository.update({ id: draft.id }, { status: 'processing' });

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      expect((res.body as { error: string }).error).toBe(
        'INVALID_VIDEO_STATUS',
      );
    });

    it('should answer 404 to another user', async () => {
      const draft = await createDraft(await loginAs('owner3@example.com'));
      const otherToken = await loginAs('intruder3@example.com');

      await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/upload`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
    });
  });

  describe('POST /videos/:slug/upload/complete', () => {
    async function startSmallUpload(
      token: string,
      declaredSize: number,
    ): Promise<{ id: string; slug: string; partUrl: string }> {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validBody, file_size: declaredSize })
        .expect(201);
      const body = res.body as {
        video: { id: string; slug: string };
        upload: { parts: { url: string }[] };
      };
      return { ...body.video, partUrl: body.upload.parts[0].url };
    }

    async function putPart(url: string, size: number): Promise<void> {
      const res = await requestPresignedUrl(url, {
        method: 'PUT',
        body: randomBytes(size),
      });
      expect(res.status).toBe(200);
    }

    function complete(token: string, slug: string): request.Test {
      return request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${token}`);
    }

    it('should return 202 and move the video to processing', async () => {
      const token = await loginAs('done@example.com');
      const video = await startSmallUpload(token, 4096);
      await putPart(video.partUrl, 4096);

      const res = await complete(token, video.slug).expect(202);

      expect((res.body as { status: string }).status).toBe('processing');
      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('processing');
      expect(row.upload_id).toBeNull();
    });

    it('should return 409 UPLOAD_INCOMPLETE when no part was uploaded', async () => {
      const token = await loginAs('empty@example.com');
      const video = await startSmallUpload(token, 4096);

      const res = await complete(token, video.slug).expect(409);

      expect((res.body as { error: string }).error).toBe('UPLOAD_INCOMPLETE');
      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('draft');
    });

    it('should return 422 UPLOAD_SIZE_MISMATCH and mark the video failed', async () => {
      const token = await loginAs('liar@example.com');
      const video = await startSmallUpload(token, 4096);
      await putPart(video.partUrl, 1000);

      const res = await complete(token, video.slug).expect(422);

      expect((res.body as { error: string }).error).toBe(
        'UPLOAD_SIZE_MISMATCH',
      );
      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.status).toBe('failed');
    });

    it('should return 409 INVALID_VIDEO_STATUS on a second completion', async () => {
      const token = await loginAs('twice@example.com');
      const video = await startSmallUpload(token, 4096);
      await putPart(video.partUrl, 4096);
      await complete(token, video.slug).expect(202);

      const res = await complete(token, video.slug).expect(409);

      expect((res.body as { error: string }).error).toBe(
        'INVALID_VIDEO_STATUS',
      );
    });

    it('should answer 404 to another user and 401 without a token', async () => {
      const video = await startSmallUpload(
        await loginAs('owner4@example.com'),
        4096,
      );
      const otherToken = await loginAs('intruder4@example.com');

      await complete(otherToken, video.slug).expect(404);
      await request(app.getHttpServer())
        .post(`/videos/${video.slug}/upload/complete`)
        .expect(401);
    });
  });

  describe('GET /videos/:slug/stream | download | thumbnail', () => {
    const source = randomBytes(8192);
    const thumbnail = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      randomBytes(512),
    ]);

    // Seeds the final state the worker produces, without going through the
    // queue, so delivery is tested independently of processing.
    async function seedVideo(status: VideoStatus): Promise<Video> {
      const owner = await dataSource.getRepository(User).save({
        email: `viewer-owner-${randomUUID()}@example.com`,
        password: 'hashed',
      });
      const channel = await dataSource.getRepository(Channel).save({
        name: 'deliver',
        nickname: `deliver_${randomUUID().slice(0, 8)}`,
        user_id: owner.id,
      });
      const id = randomUUID();
      await storageService.putObject(videoSourceKey(id), source, 'video/mp4');
      await storageService.putObject(
        videoThumbnailKey(id),
        thumbnail,
        'image/jpeg',
      );
      return videoRepository.save({
        id,
        channel_id: channel.id,
        slug: id.replace(/-/g, '').slice(0, 11),
        title: 'Deliverable',
        status,
        original_file_name: 'my "best" clip.mp4',
        mime_type: 'video/mp4',
        file_size: source.length,
        part_size: UPLOAD_PART_SIZE,
        part_count: 1,
        source_key: videoSourceKey(id),
        thumbnail_key: status === 'ready' ? videoThumbnailKey(id) : null,
      });
    }

    function location(res: request.Response): string {
      return res.headers.location;
    }

    it('should redirect an anonymous viewer to a presigned URL that serves byte ranges (206)', async () => {
      const video = await seedVideo('ready');

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .expect(302);

      expect(location(res).startsWith(process.env.S3_PUBLIC_ENDPOINT!)).toBe(
        true,
      );
      const ranged = await requestPresignedUrl(location(res), {
        headers: { range: 'bytes=0-99' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers['content-range']).toBe(
        `bytes 0-99/${source.length}`,
      );
      expect(ranged.body.equals(source.subarray(0, 100))).toBe(true);
    });

    it('should redirect to a download URL served as an attachment', async () => {
      const video = await seedVideo('ready');

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/download`)
        .expect(302);

      const file = await requestPresignedUrl(location(res));
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toBe(
        'attachment; filename="my _best_ clip.mp4"',
      );
      expect(file.body.equals(source)).toBe(true);
    });

    it('should redirect to the JPEG thumbnail', async () => {
      const video = await seedVideo('ready');

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/thumbnail`)
        .expect(302);

      const image = await requestPresignedUrl(location(res));
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/jpeg');
    });

    it.each(['stream', 'download', 'thumbnail'])(
      'should answer 409 VIDEO_NOT_READY on /%s while the video is processing',
      async (endpoint) => {
        const video = await seedVideo('processing');

        const res = await request(app.getHttpServer())
          .get(`/videos/${video.slug}/${endpoint}`)
          .expect(409);

        expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
      },
    );

    it('should answer 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/unknownslug/stream')
        .expect(404);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});

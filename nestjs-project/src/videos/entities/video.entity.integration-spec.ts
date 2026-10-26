import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import {
  MAX_VIDEO_FILE_SIZE,
  UPLOAD_PART_SIZE,
  videoSourceKey,
} from '../videos.constants';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: user.id });
  });

  let slugCounter = 0;
  function buildVideo(overrides: Partial<Video> = {}): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      channel_id: channel.id,
      slug: `slug${String(++slugCounter).padStart(7, '0')}`,
      title: 'My video',
      original_file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      file_size: 1024,
      part_size: UPLOAD_PART_SIZE,
      part_count: 1,
      source_key: videoSourceKey(id),
      ...overrides,
    });
  }

  it('should default status to draft and nullable processing fields to null', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe('draft');
    expect(found.upload_id).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.processed_at).toBeNull();
  });

  it('should keep the application-generated id', async () => {
    const video = buildVideo();

    const saved = await videoRepository.save(video);

    expect(saved.id).toBe(video.id);
  });

  it('should enforce a unique slug', async () => {
    await videoRepository.save(buildVideo({ slug: 'dupSlug0001' }));

    await expect(
      videoRepository.save(buildVideo({ slug: 'dupSlug0001' })),
    ).rejects.toThrow();
  });

  it('should reject a status outside the video_status enum', async () => {
    const saved = await videoRepository.save(buildVideo());

    await expect(
      dataSource.query(
        `UPDATE "videos" SET "status" = 'published' WHERE id = $1`,
        [saved.id],
      ),
    ).rejects.toThrow();
  });

  it('should round-trip a 10 GiB file_size and a fractional duration as numbers', async () => {
    const saved = await videoRepository.save(
      buildVideo({
        file_size: MAX_VIDEO_FILE_SIZE,
        part_count: 160,
        duration_seconds: 3725.125,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.file_size).toBe(10_737_418_240);
    expect(found.duration_seconds).toBe(3725.125);
  });

  it('should store metadata as jsonb', async () => {
    const metadata = {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      bit_rate: 1_000_000,
      size: 2048,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: null,
      frame_rate: 30,
    };
    const saved = await videoRepository.save(buildVideo({ metadata }));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual(metadata);
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toThrow();
  });

  it('should delete videos when their channel is deleted', async () => {
    const saved = await videoRepository.save(buildVideo());

    await dataSource.query('DELETE FROM "channels" WHERE id = $1', [
      channel.id,
    ]);

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });

  it('should load the owning channel through the relation', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });
    expect(found.channel.user_id).toBe(channel.user_id);
  });
});

import { randomUUID } from 'crypto';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { URL_AUDIENCE } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  createCorruptVideo,
  createSampleVideo,
  removeFixture,
} from '../test/media-fixtures';
import { MediaProcessingError } from './media-processing.error';
import { MediaService } from './media.service';

const JPEG_SOI = Buffer.from([0xff, 0xd8]);

describe('MediaService (integration — real ffmpeg)', () => {
  let module: TestingModule;
  let media: MediaService;
  let storage: StorageService;
  let sample: string;
  let silent: string;
  let corrupt: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaService],
    }).compile();
    media = module.get(MediaService);
    storage = module.get(StorageService);

    sample = createSampleVideo({ durationSeconds: 2, width: 320, height: 240 });
    silent = createSampleVideo({ durationSeconds: 1, withAudio: false });
    corrupt = createCorruptVideo();
  }, 60000);

  afterAll(async () => {
    [sample, silent, corrupt].forEach(removeFixture);
    await module.close();
  });

  describe('probe', () => {
    it('should extract duration and stream metadata from a file', async () => {
      const result = await media.probe(sample);

      expect(result.durationSeconds).toBeCloseTo(2, 0);
      expect(result.metadata).toMatchObject({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
        frame_rate: 10,
      });
      expect(result.metadata.format_name).toContain('mp4');
    });

    it('should report no audio codec for a silent video', async () => {
      const result = await media.probe(silent);

      expect(result.metadata.audio_codec).toBeNull();
    });

    it('should reject a corrupt file with MediaProcessingError', async () => {
      await expect(media.probe(corrupt)).rejects.toThrow(MediaProcessingError);
    });
  });

  describe('extractThumbnail', () => {
    it('should produce a JPEG scaled to 1280px width with the aspect ratio kept', async () => {
      const jpeg = await media.extractThumbnail(sample, 0.2);

      expect(jpeg.subarray(0, 2).equals(JPEG_SOI)).toBe(true);
      const path = join(tmpdir(), `thumb-${randomUUID()}.jpg`);
      writeFileSync(path, jpeg);
      try {
        const probed = await media.probe(path);
        expect(probed.metadata.width).toBe(1280);
        expect(probed.metadata.height).toBe(960);
      } finally {
        rmSync(path, { force: true });
      }
    });

    it('should reject a corrupt file with MediaProcessingError', async () => {
      await expect(media.extractThumbnail(corrupt, 0)).rejects.toThrow(
        MediaProcessingError,
      );
    });
  });

  describe('remote input', () => {
    it('should probe and thumbnail a video read over HTTP from MinIO', async () => {
      const key = `test/media/${randomUUID()}.mp4`;
      await storage.putObject(key, readFileSync(sample), 'video/mp4');
      try {
        const url = await storage.presignGetObject(key, {
          expiresIn: 300,
          audience: URL_AUDIENCE.INTERNAL,
        });

        const result = await media.probe(url);
        const jpeg = await media.extractThumbnail(url, 0.2);

        expect(result.metadata.width).toBe(320);
        expect(jpeg.subarray(0, 2).equals(JPEG_SOI)).toBe(true);
      } finally {
        await storage.deleteObject(key);
      }
    });
  });
});

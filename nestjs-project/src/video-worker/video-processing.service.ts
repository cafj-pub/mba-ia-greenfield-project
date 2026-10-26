import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { URL_AUDIENCE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import {
  VIDEO_STATUS,
  WORKER_SOURCE_URL_EXPIRATION_SECONDS,
  videoThumbnailKey,
} from '../videos/videos.constants';
import { MediaService } from './media.service';
import { thumbnailTimestamp } from './thumbnail-time';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaService: MediaService,
  ) {}

  /**
   * Extracts duration/metadata and a thumbnail, then moves
   * `processing → ready`. Idempotent: anything not in `processing` is skipped,
   * and re-processing overwrites the same keys/columns (at-least-once queue).
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      this.logger.warn(`Video ${videoId} no longer exists — skipping`);
      return;
    }
    if (video.status !== VIDEO_STATUS.PROCESSING) {
      this.logger.warn(
        `Video ${videoId} is ${video.status}, not processing — skipping`,
      );
      return;
    }

    // Internal endpoint: the worker runs inside the Docker network
    // (phase-03-videos/TD-04 Revision, validation AMB-1)
    const sourceUrl = await this.storageService.presignGetObject(
      video.source_key,
      {
        expiresIn: WORKER_SOURCE_URL_EXPIRATION_SECONDS,
        audience: URL_AUDIENCE.INTERNAL,
      },
    );

    const { durationSeconds, metadata } =
      await this.mediaService.probe(sourceUrl);
    const thumbnail = await this.mediaService.extractThumbnail(
      sourceUrl,
      thumbnailTimestamp(durationSeconds),
    );
    const thumbnailKey = videoThumbnailKey(video.id);
    await this.storageService.putObject(
      thumbnailKey,
      thumbnail,
      THUMBNAIL_CONTENT_TYPE,
    );

    const result = await this.videoRepository.update(
      { id: video.id, status: VIDEO_STATUS.PROCESSING },
      {
        status: VIDEO_STATUS.READY,
        duration_seconds: durationSeconds,
        metadata,
        thumbnail_key: thumbnailKey,
        processing_error: null,
        processed_at: new Date(),
      },
    );
    if (result.affected !== 1) {
      this.logger.warn(
        `Video ${videoId} left processing while being processed`,
      );
      return;
    }
    this.logger.log(`Video ${videoId} is ready (${durationSeconds ?? '?'}s)`);
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    const result = await this.videoRepository.update(
      { id: videoId, status: VIDEO_STATUS.PROCESSING },
      { status: VIDEO_STATUS.FAILED, processing_error: reason },
    );
    if (result.affected === 1) {
      this.logger.error(`Video ${videoId} failed: ${reason}`);
    }
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { URL_AUDIENCE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  PLAYBACK_URL_EXPIRATION_SECONDS,
  VIDEO_STATUS,
} from './videos.constants';

/**
 * Authorizes by state and hands out short-lived presigned GET URLs; the bytes
 * (including HTTP range requests for seeking) are served by object storage,
 * never by the API (phase-03-videos/TD-06).
 */
@Injectable()
export class VideoDeliveryService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async getStreamUrl(slug: string): Promise<string> {
    const video = await this.loadReadyVideo(slug);
    return this.presign(video.source_key);
  }

  async getDownloadUrl(slug: string): Promise<string> {
    const video = await this.loadReadyVideo(slug);
    return this.presign(
      video.source_key,
      toContentDispositionFileName(video.original_file_name),
    );
  }

  async getThumbnailUrl(slug: string): Promise<string> {
    const video = await this.loadReadyVideo(slug);
    if (!video.thumbnail_key) {
      throw new VideoNotReadyException();
    }
    return this.presign(video.thumbnail_key);
  }

  private async loadReadyVideo(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ slug });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VIDEO_STATUS.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private presign(key: string, downloadFileName?: string): Promise<string> {
    return this.storageService.presignGetObject(key, {
      expiresIn: PLAYBACK_URL_EXPIRATION_SECONDS,
      audience: URL_AUDIENCE.PUBLIC,
      downloadFileName,
    });
  }
}

// The name ends up inside `attachment; filename="..."`: keep printable ASCII
// and drop the characters that would break the quoted string.
export function toContentDispositionFileName(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return safe.trim() || 'video';
}

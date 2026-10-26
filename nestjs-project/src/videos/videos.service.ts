import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  InvalidVideoStatusException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CreateVideoResponseDto,
  UploadSessionResponseDto,
  UploadStatusResponseDto,
} from './dto/upload-session-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  UPLOAD_PART_SIZE,
  UPLOAD_URL_EXPIRATION_SECONDS,
  VIDEO_STATUS,
  videoSourceKey,
} from './videos.constants';
import type { VideoStatus } from './videos.constants';

const SLUG_COLUMN = 'slug';
const MAX_SLUG_ATTEMPTS = 5;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly processingProducer: VideoProcessingProducer,
  ) {}

  /**
   * Pre-registers the video as a draft and opens a multipart upload; the
   * client then PUTs every part straight to storage (phase-03-videos/TD-02).
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const sourceKey = videoSourceKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      sourceKey,
      dto.mime_type,
    );

    let video: Video;
    try {
      video = await this.insertWithUniqueSlug(
        this.videoRepository.create({
          id,
          channel_id: channel.id,
          title: dto.title,
          original_file_name: dto.file_name,
          mime_type: dto.mime_type,
          file_size: dto.file_size,
          part_size: UPLOAD_PART_SIZE,
          part_count: Math.ceil(dto.file_size / UPLOAD_PART_SIZE),
          source_key: sourceKey,
          upload_id: uploadId,
        }),
      );
    } catch (err) {
      // Compensation: never leave an orphan multipart upload in storage
      await this.storageService.abortMultipartUpload(sourceKey, uploadId);
      throw err;
    }

    const partNumbers = Array.from(
      { length: video.part_count },
      (_, index) => index + 1,
    );
    return {
      video: VideoResponseDto.fromEntity(video),
      upload: await this.buildUploadSession(video, uploadId, partNumbers),
    };
  }

  async findOwnedBySlug(
    userId: string,
    slug: string,
  ): Promise<VideoResponseDto> {
    return VideoResponseDto.fromEntity(await this.loadOwnedVideo(userId, slug));
  }

  /**
   * Resume support: lists the parts already in storage and re-issues URLs
   * only for the missing ones (phase-03-videos/TD-02).
   */
  async getUploadStatus(
    userId: string,
    slug: string,
  ): Promise<UploadStatusResponseDto> {
    const video = await this.loadOwnedVideo(userId, slug);
    if (video.status !== VIDEO_STATUS.DRAFT || !video.upload_id) {
      throw new InvalidVideoStatusException();
    }

    const uploaded = await this.storageService.listParts(
      video.source_key,
      video.upload_id,
    );
    const uploadedNumbers = new Set(uploaded.map((part) => part.partNumber));
    const missing = Array.from(
      { length: video.part_count },
      (_, index) => index + 1,
    ).filter((partNumber) => !uploadedNumbers.has(partNumber));

    return {
      ...(await this.buildUploadSession(video, video.upload_id, missing)),
      uploaded_parts: uploaded.map((part) => ({
        part_number: part.partNumber,
        size: part.size,
      })),
    };
  }

  /**
   * Assembles the uploaded parts, flips `draft → processing` and enqueues
   * `process-video` (phase-03-videos/TD-02, TD-07).
   */
  async completeUpload(
    userId: string,
    slug: string,
  ): Promise<VideoResponseDto> {
    const video = await this.loadOwnedVideo(userId, slug);
    if (video.status !== VIDEO_STATUS.DRAFT) {
      throw new InvalidVideoStatusException();
    }

    // upload_id is already null when a previous call assembled the object
    // but failed before the status change — skip straight to enqueueing.
    if (video.upload_id) {
      await this.assembleUpload(video, video.upload_id);
    }

    const moved = await this.transitionStatus(
      video.id,
      VIDEO_STATUS.DRAFT,
      VIDEO_STATUS.PROCESSING,
    );
    if (!moved) {
      throw new InvalidVideoStatusException();
    }

    try {
      await this.processingProducer.enqueue(video.id);
    } catch (err) {
      // Compensation: a processing video without a job would never finish
      await this.transitionStatus(
        video.id,
        VIDEO_STATUS.PROCESSING,
        VIDEO_STATUS.DRAFT,
      );
      throw err;
    }

    return VideoResponseDto.fromEntity(
      await this.videoRepository.findOneByOrFail({ id: video.id }),
    );
  }

  private async assembleUpload(video: Video, uploadId: string): Promise<void> {
    const parts = await this.storageService.listParts(
      video.source_key,
      uploadId,
    );
    const uploadedNumbers = new Set(parts.map((part) => part.partNumber));
    for (let partNumber = 1; partNumber <= video.part_count; partNumber++) {
      if (!uploadedNumbers.has(partNumber)) {
        throw new UploadIncompleteException();
      }
    }

    const uploadedSize = parts.reduce((total, part) => total + part.size, 0);
    if (uploadedSize !== video.file_size) {
      await this.storageService.abortMultipartUpload(
        video.source_key,
        uploadId,
      );
      await this.transitionStatus(
        video.id,
        VIDEO_STATUS.DRAFT,
        VIDEO_STATUS.FAILED,
        {
          upload_id: null,
          processing_error: `Uploaded ${uploadedSize} bytes but ${video.file_size} were declared`,
        },
      );
      throw new UploadSizeMismatchException();
    }

    await this.storageService.completeMultipartUpload(
      video.source_key,
      uploadId,
      parts,
    );
    await this.videoRepository.update({ id: video.id }, { upload_id: null });
  }

  // Every status change is a conditional UPDATE (plan → Data Model → Status
  // transitions); returns false when the video was not in `from`.
  private async transitionStatus(
    id: string,
    from: VideoStatus,
    to: VideoStatus,
    changes: Partial<Pick<Video, 'upload_id' | 'processing_error'>> = {},
  ): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: from },
      { status: to, ...changes },
    );
    return result.affected === 1;
  }

  // Unknown slug and someone else's video are indistinguishable on purpose
  // (phase-03-videos/TD-06 Revision, validation AMB-2).
  private async loadOwnedVideo(userId: string, slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async buildUploadSession(
    video: Video,
    uploadId: string,
    partNumbers: number[],
  ): Promise<UploadSessionResponseDto> {
    const expiresAt = new Date(
      Date.now() + UPLOAD_URL_EXPIRATION_SECONDS * 1000,
    );
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.source_key,
          uploadId,
          partNumber,
          UPLOAD_URL_EXPIRATION_SECONDS,
        ),
      })),
    );
    return {
      part_size: video.part_size,
      part_count: video.part_count,
      expires_at: expiresAt,
      parts,
    };
  }

  // Same pre-check + unique-violation retry as ChannelsService nicknames
  // (phase-03-videos/TD-05); the unique index is the final guarantee.
  private async insertWithUniqueSlug(video: Video): Promise<Video> {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = generateVideoSlug();
      if (await this.videoRepository.exists({ where: { slug } })) {
        continue;
      }
      try {
        return await this.videoRepository.save({ ...video, slug });
      } catch (err) {
        if (!isPgUniqueViolationOnColumn(err, SLUG_COLUMN)) {
          throw err;
        }
      }
    }
    throw new Error('Video slug conflict could not be resolved');
  }
}

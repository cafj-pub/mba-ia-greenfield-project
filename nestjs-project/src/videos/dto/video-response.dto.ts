import { ApiProperty } from '@nestjs/swagger';
import type { Video } from '../entities/video.entity';
import { VIDEO_STATUS } from '../videos.constants';
import type { VideoStatus } from '../videos.constants';

export class VideoMetadataDto {
  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format_name: string;

  @ApiProperty({ type: Number, nullable: true, example: 2500000 })
  bit_rate: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 104857600 })
  size: number | null;

  @ApiProperty({ example: 1920 })
  width: number;

  @ApiProperty({ example: 1080 })
  height: number;

  @ApiProperty({ example: 'h264' })
  video_codec: string;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 30 })
  frame_rate: number | null;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', minLength: 11, maxLength: 11 })
  slug: string;

  @ApiProperty({ example: 'My first video' })
  title: string;

  @ApiProperty({ enum: Object.values(VIDEO_STATUS), example: 'draft' })
  status: VideoStatus;

  @ApiProperty({ example: 'holiday.mp4' })
  original_file_name: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 104857600 })
  file_size: number;

  @ApiProperty({ type: Number, nullable: true, example: 63.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ type: String, nullable: true })
  processing_error: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processed_at: Date | null;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;

  @ApiProperty({ format: 'date-time' })
  updated_at: Date;

  static fromEntity(video: Video): VideoResponseDto {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      original_file_name: video.original_file_name,
      mime_type: video.mime_type,
      file_size: video.file_size,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      processing_error: video.processing_error,
      processed_at: video.processed_at,
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VIDEO_STATUS, VIDEO_SLUG_LENGTH } from '../videos.constants';
import type { VideoStatus } from '../videos.constants';

// pg returns bigint/numeric as strings; every value stored here fits in a JS number
const numberTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

export interface VideoMetadata {
  format_name: string;
  bit_rate: number | null;
  size: number | null;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  frame_rate: number | null;
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: VIDEO_SLUG_LENGTH, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({
    type: 'enum',
    enum: Object.values(VIDEO_STATUS),
    enumName: 'video_status',
    default: VIDEO_STATUS.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_file_name: string;

  @Column({ type: 'varchar', length: 100 })
  mime_type: string;

  @Column({ type: 'bigint', transformer: numberTransformer })
  file_size: number;

  @Column({ type: 'integer' })
  part_size: number;

  @Column({ type: 'integer' })
  part_count: number;

  @Column({ type: 'varchar', length: 255 })
  source_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: numberTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}

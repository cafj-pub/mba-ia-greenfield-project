import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Presigned S3 UploadPart URL (HTTP PUT)' })
  url: string;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 67108864 })
  size: number;
}

export class UploadSessionResponseDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 2 })
  part_count: number;

  @ApiProperty({ format: 'date-time' })
  expires_at: Date;

  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];
}

export class UploadStatusResponseDto extends UploadSessionResponseDto {
  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}

export class CreateVideoResponseDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadSessionResponseDto })
  upload: UploadSessionResponseDto;
}

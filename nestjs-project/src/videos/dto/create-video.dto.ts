import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_VIDEO_FILE_SIZE,
} from '../videos.constants';

export class CreateVideoDto {
  /** Video title shown to viewers. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  /** Original file name, used as the download file name. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  /** File size in bytes (max 10 GiB). */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_FILE_SIZE)
  file_size: number;

  /** MIME type of the file. */
  @IsIn(ALLOWED_VIDEO_MIME_TYPES)
  mime_type: string;
}

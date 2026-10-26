import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CreateVideoResponseDto,
  UploadStatusResponseDto,
} from './dto/upload-session-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoDeliveryService } from './video-delivery.service';
import { VideosService } from './videos.service';

interface RedirectTarget {
  url: string;
}

const PRESIGNED_LOCATION_HEADER = {
  Location: {
    description: 'Presigned object-storage URL, valid for 15 minutes',
    schema: { type: 'string', format: 'uri' },
  },
};

// Upload resume and player URL refresh must not hit the global auth
// throttler (phase-03-videos/TD-06 Revision, validation ICC-2).
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly videoDeliveryService: VideoDeliveryService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft in the caller's channel and returns one presigned URL per part. The client uploads each part with HTTP PUT directly to object storage — the file never passes through the API.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (size above 10 GiB, MIME type, title)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Caller has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':slug')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get one of my videos',
    description:
      'Returns the video record — status (draft → processing → ready | failed), duration and metadata — to its owner. Other users get 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video record',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug or video owned by another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.findOwnedBySlug(user.sub, slug);
  }

  @Get(':slug/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Resume an upload',
    description:
      'Lists the parts already stored and returns fresh presigned URLs only for the missing parts.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload progress and URLs for the missing parts',
    type: UploadStatusResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug or video owned by another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer awaiting upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<UploadStatusResponseDto> {
    return this.videosService.getUploadStatus(user.sub, slug);
  }

  @Post(':slug/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete an upload',
    description:
      'Checks that every part is stored and that their total size matches the declared size, assembles the file and queues it for processing. The video moves to `processing`; duration, metadata and thumbnail are filled in asynchronously by the video worker.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload assembled and queued for processing',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug or video owned by another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'Video is not awaiting upload (INVALID_VIDEO_STATUS) or parts are missing (UPLOAD_INCOMPLETE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'Uploaded size does not match the declared size — the video is marked failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(user.sub, slug);
  }

  @Public()
  @Get(':slug/stream')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived URL of the video file in object storage. Storage answers HTTP Range requests with 206 Partial Content, so players can start and seek without downloading the whole file.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned video URL',
    headers: PRESIGNED_LOCATION_HEADER,
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('slug') slug: string): Promise<RedirectTarget> {
    return { url: await this.videoDeliveryService.getStreamUrl(slug) };
  }

  @Public()
  @Get(':slug/download')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived URL that serves the original file with `Content-Disposition: attachment`.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
    headers: PRESIGNED_LOCATION_HEADER,
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('slug') slug: string): Promise<RedirectTarget> {
    return { url: await this.videoDeliveryService.getDownloadUrl(slug) };
  }

  @Public()
  @Get(':slug/thumbnail')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Get the video thumbnail',
    description:
      'Redirects to a short-lived URL of the JPEG thumbnail generated by the video worker.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned thumbnail URL',
    headers: PRESIGNED_LOCATION_HEADER,
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(@Param('slug') slug: string): Promise<RedirectTarget> {
    return { url: await this.videoDeliveryService.getThumbnailUrl(slug) };
  }
}

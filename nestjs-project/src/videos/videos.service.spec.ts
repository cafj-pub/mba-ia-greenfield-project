import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidVideoStatusException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import { MAX_VIDEO_FILE_SIZE, UPLOAD_PART_SIZE } from './videos.constants';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID };

function uniqueViolation(column: string): QueryFailedError {
  return new QueryFailedError('INSERT', [], {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  } as unknown as Error);
}

function buildDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    title: 'My video',
    file_name: 'clip.mp4',
    file_size: 1024,
    mime_type: 'video/mp4',
    ...overrides,
  };
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    exists: jest.Mock;
    findOne: jest.Mock;
    findOneByOrFail: jest.Mock;
    update: jest.Mock;
    save: jest.Mock<Promise<Video>, [Video]>;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    listParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
  };
  let processingProducer: { enqueue: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((v: Partial<Video>) => ({ ...v })),
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn().mockResolvedValue(null),
      findOneByOrFail: jest.fn((where: { id: string }) =>
        Promise.resolve({ ...where, status: 'processing' }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn<Promise<Video>, [Video]>((v) =>
        Promise.resolve({ ...v, status: 'draft' }),
      ),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue(CHANNEL),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      listParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignUploadPart: jest.fn(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
      ),
    };

    processingProducer = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingProducer, useValue: processingProducer },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    it.each([
      ['a single byte', 1, 1],
      ['exactly one part', UPLOAD_PART_SIZE, 1],
      ['one byte over a part', UPLOAD_PART_SIZE + 1, 2],
      ['the 10 GiB maximum', MAX_VIDEO_FILE_SIZE, 160],
    ])(
      'should split %s into the right number of parts',
      async (_l, size, parts) => {
        const result = await service.createDraft(
          USER_ID,
          buildDto({ file_size: size }),
        );

        expect(result.upload.part_count).toBe(parts);
        expect(result.upload.parts).toHaveLength(parts);
        expect(result.upload.parts.map((p) => p.part_number)).toEqual(
          Array.from({ length: parts }, (_, i) => i + 1),
        );
      },
    );

    it('should persist the draft in the caller channel with the storage key and upload id', async () => {
      const result = await service.createDraft(USER_ID, buildDto());

      const saved = videoRepository.save.mock.calls[0][0];
      expect(saved.channel_id).toBe(CHANNEL.id);
      expect(saved.source_key).toBe(`videos/${saved.id}/source`);
      expect(saved.upload_id).toBe('upload-1');
      expect(saved.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        saved.source_key,
        'video/mp4',
      );
      expect(result.video.status).toBe('draft');
    });

    it('should regenerate the slug when the pre-check finds it taken', async () => {
      videoRepository.exists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await service.createDraft(USER_ID, buildDto());

      expect(videoRepository.exists).toHaveBeenCalledTimes(2);
      expect(videoRepository.save).toHaveBeenCalledTimes(1);
    });

    it('should retry with a new slug on a concurrent unique violation', async () => {
      videoRepository.save.mockRejectedValueOnce(uniqueViolation('slug'));

      await service.createDraft(USER_ID, buildDto());

      const [first, second] = videoRepository.save.mock.calls.map(
        ([video]) => video.slug,
      );
      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);
    });

    it('should abort the multipart upload and rethrow when the insert fails', async () => {
      const dbError = new Error('connection lost');
      videoRepository.save.mockRejectedValueOnce(dbError);

      await expect(service.createDraft(USER_ID, buildDto())).rejects.toBe(
        dbError,
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        'upload-1',
      );
    });

    it('should give up after repeated slug collisions and abort the upload', async () => {
      videoRepository.exists.mockResolvedValue(true);

      await expect(service.createDraft(USER_ID, buildDto())).rejects.toThrow(
        'Video slug conflict could not be resolved',
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalled();
    });

    it('should throw ChannelNotFoundException without touching storage when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.createDraft(USER_ID, buildDto())).rejects.toThrow(
        ChannelNotFoundException,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('getUploadStatus', () => {
    const draft = {
      id: 'video-1',
      slug: 'abcdefghijk',
      status: 'draft',
      part_size: UPLOAD_PART_SIZE,
      part_count: 4,
      source_key: 'videos/video-1/source',
      upload_id: 'upload-1',
    };

    it('should report uploaded parts and return URLs only for the missing ones', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"a"', size: UPLOAD_PART_SIZE },
        { partNumber: 3, etag: '"c"', size: UPLOAD_PART_SIZE },
      ]);

      const status = await service.getUploadStatus(USER_ID, draft.slug);

      expect(status.uploaded_parts).toEqual([
        { part_number: 1, size: UPLOAD_PART_SIZE },
        { part_number: 3, size: UPLOAD_PART_SIZE },
      ]);
      expect(status.parts.map((p) => p.part_number)).toEqual([2, 4]);
      expect(status.part_count).toBe(4);
    });

    it('should scope the lookup to the caller and throw VideoNotFoundException otherwise', async () => {
      await expect(
        service.getUploadStatus(USER_ID, 'unknownslug'),
      ).rejects.toThrow(VideoNotFoundException);
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { slug: 'unknownslug', channel: { user_id: USER_ID } },
      });
    });

    it.each([
      ['processing', { status: 'processing' }],
      ['an already assembled draft', { upload_id: null }],
    ])('should throw InvalidVideoStatusException for %s', async (_l, patch) => {
      videoRepository.findOne.mockResolvedValue({ ...draft, ...patch });

      await expect(
        service.getUploadStatus(USER_ID, draft.slug),
      ).rejects.toThrow(InvalidVideoStatusException);
      expect(storageService.listParts).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const PART = 100;
    const draft = {
      id: 'video-2',
      slug: 'completeme1',
      status: 'draft',
      file_size: PART * 2 + 50,
      part_count: 3,
      source_key: 'videos/video-2/source',
      upload_id: 'upload-2',
    };
    const allParts = [
      { partNumber: 1, etag: '"1"', size: PART },
      { partNumber: 2, etag: '"2"', size: PART },
      { partNumber: 3, etag: '"3"', size: 50 },
    ];

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue({ ...draft });
      storageService.listParts.mockResolvedValue(allParts);
    });

    it('should assemble the parts, move draft → processing and enqueue the job', async () => {
      const result = await service.completeUpload(USER_ID, draft.slug);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        draft.source_key,
        draft.upload_id,
        allParts,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: draft.id },
        { upload_id: null },
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: draft.id, status: 'draft' },
        { status: 'processing' },
      );
      expect(processingProducer.enqueue).toHaveBeenCalledWith(draft.id);
      expect(result.status).toBe('processing');
    });

    it('should throw UploadIncompleteException when a part is missing', async () => {
      storageService.listParts.mockResolvedValue([allParts[0], allParts[2]]);

      await expect(service.completeUpload(USER_ID, draft.slug)).rejects.toThrow(
        UploadIncompleteException,
      );
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should abort, mark the video failed and throw on size mismatch', async () => {
      storageService.listParts.mockResolvedValue([
        allParts[0],
        allParts[1],
        { partNumber: 3, etag: '"3"', size: 49 },
      ]);

      await expect(service.completeUpload(USER_ID, draft.slug)).rejects.toThrow(
        UploadSizeMismatchException,
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        draft.source_key,
        draft.upload_id,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: draft.id, status: 'draft' },
        {
          status: 'failed',
          upload_id: null,
          processing_error: 'Uploaded 249 bytes but 250 were declared',
        },
      );
      expect(processingProducer.enqueue).not.toHaveBeenCalled();
    });

    it('should skip assembly when a previous call already assembled the object', async () => {
      videoRepository.findOne.mockResolvedValue({ ...draft, upload_id: null });

      await service.completeUpload(USER_ID, draft.slug);

      expect(storageService.listParts).not.toHaveBeenCalled();
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(processingProducer.enqueue).toHaveBeenCalledWith(draft.id);
    });

    it('should revert processing → draft and rethrow when enqueueing fails', async () => {
      const redisDown = new Error('Redis unavailable');
      processingProducer.enqueue.mockRejectedValue(redisDown);

      await expect(service.completeUpload(USER_ID, draft.slug)).rejects.toBe(
        redisDown,
      );
      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: draft.id, status: 'processing' },
        { status: 'draft' },
      );
    });

    it('should throw InvalidVideoStatusException when the video is not a draft', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...draft,
        status: 'processing',
      });

      await expect(service.completeUpload(USER_ID, draft.slug)).rejects.toThrow(
        InvalidVideoStatusException,
      );
      expect(storageService.listParts).not.toHaveBeenCalled();
    });

    it('should throw InvalidVideoStatusException when a concurrent call already moved it', async () => {
      videoRepository.update.mockImplementation(
        (criteria: { status?: string }) =>
          Promise.resolve({ affected: criteria.status === 'draft' ? 0 : 1 }),
      );

      await expect(service.completeUpload(USER_ID, draft.slug)).rejects.toThrow(
        InvalidVideoStatusException,
      );
      expect(processingProducer.enqueue).not.toHaveBeenCalled();
    });
  });
});

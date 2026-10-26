import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  toContentDispositionFileName,
  VideoDeliveryService,
} from './video-delivery.service';

const READY_VIDEO = {
  id: 'video-1',
  slug: 'readyvideo1',
  status: 'ready',
  original_file_name: 'holiday.mp4',
  source_key: 'videos/video-1/source',
  thumbnail_key: 'videos/video-1/thumbnail.jpg',
};

describe('VideoDeliveryService', () => {
  let service: VideoDeliveryService;
  let videoRepository: { findOneBy: jest.Mock };
  let storageService: { presignGetObject: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn().mockResolvedValue({ ...READY_VIDEO }),
    };
    storageService = {
      presignGetObject: jest.fn().mockResolvedValue('https://storage/signed'),
    };
    const module = await Test.createTestingModule({
      providers: [
        VideoDeliveryService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();
    service = module.get(VideoDeliveryService);
  });

  it('should sign a 15-minute public URL of the source for streaming', async () => {
    await expect(service.getStreamUrl(READY_VIDEO.slug)).resolves.toBe(
      'https://storage/signed',
    );
    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      READY_VIDEO.source_key,
      { expiresIn: 900, audience: 'public', downloadFileName: undefined },
    );
  });

  it('should attach the original file name for downloads', async () => {
    await service.getDownloadUrl(READY_VIDEO.slug);

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      READY_VIDEO.source_key,
      expect.objectContaining({ downloadFileName: 'holiday.mp4' }),
    );
  });

  it('should sign the thumbnail key', async () => {
    await service.getThumbnailUrl(READY_VIDEO.slug);

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      READY_VIDEO.thumbnail_key,
      expect.objectContaining({ audience: 'public' }),
    );
  });

  it('should throw VideoNotFoundException for an unknown slug', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(service.getStreamUrl('missingslug')).rejects.toThrow(
      VideoNotFoundException,
    );
  });

  it.each(['draft', 'processing', 'failed'])(
    'should throw VideoNotReadyException for a %s video',
    async (status) => {
      videoRepository.findOneBy.mockResolvedValue({ ...READY_VIDEO, status });

      await expect(service.getDownloadUrl(READY_VIDEO.slug)).rejects.toThrow(
        VideoNotReadyException,
      );
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    },
  );

  it('should throw VideoNotReadyException when a ready video has no thumbnail', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      ...READY_VIDEO,
      thumbnail_key: null,
    });

    await expect(service.getThumbnailUrl(READY_VIDEO.slug)).rejects.toThrow(
      VideoNotReadyException,
    );
  });
});

describe('toContentDispositionFileName', () => {
  it.each([
    ['holiday.mp4', 'holiday.mp4'],
    ['my "best" clip.mp4', 'my _best_ clip.mp4'],
    ['férias 2026.mp4', 'f_rias 2026.mp4'],
    ['back\\slash.mov', 'back_slash.mov'],
    ['   ', 'video'],
  ])('should turn %p into %p', (input, expected) => {
    expect(toContentDispositionFileName(input)).toBe(expected);
  });
});

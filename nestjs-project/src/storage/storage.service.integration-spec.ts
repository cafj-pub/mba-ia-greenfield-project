import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { requestPresignedUrl } from '../test/s3';
import { URL_AUDIENCE } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;
const EXPIRES_IN = 300;

describe('StorageService (integration — MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await module.close();
  });

  function newKey(): string {
    const key = `test/storage/${randomUUID()}`;
    createdKeys.push(key);
    return key;
  }

  async function uploadPart(url: string, body: Buffer): Promise<number> {
    const res = await requestPresignedUrl(url, { method: 'PUT', body });
    return res.status;
  }

  describe('multipart upload through presigned part URLs', () => {
    it('should assemble an object whose size is the sum of its parts', async () => {
      const key = newKey();
      const part1 = randomBytes(5 * MIB); // non-last parts must be >= 5 MiB
      const part2 = randomBytes(1024);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const url1 = await storage.presignUploadPart(
        key,
        uploadId,
        1,
        EXPIRES_IN,
      );
      const url2 = await storage.presignUploadPart(
        key,
        uploadId,
        2,
        EXPIRES_IN,
      );
      expect(await uploadPart(url1, part1)).toBe(200);
      expect(await uploadPart(url2, part2)).toBe(200);

      const parts = await storage.listParts(key, uploadId);
      expect(parts.map((p) => [p.partNumber, p.size])).toEqual([
        [1, part1.length],
        [2, part2.length],
      ]);

      await storage.completeMultipartUpload(key, uploadId, parts);

      expect(await storage.getObjectSize(key)).toBe(
        part1.length + part2.length,
      );
    });

    it('should list no parts before any upload and drop the upload on abort', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      expect(await storage.listParts(key, uploadId)).toEqual([]);

      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listParts(key, uploadId)).rejects.toThrow();
      expect(await storage.getObjectSize(key)).toBeNull();
    });
  });

  describe('presigned GET URLs', () => {
    let key: string;
    const content = randomBytes(4096);

    beforeAll(async () => {
      key = newKey();
      await storage.putObject(key, content, 'video/mp4');
    });

    it('should sign public URLs with S3_PUBLIC_ENDPOINT and internal URLs with S3_ENDPOINT', async () => {
      const publicUrl = await storage.presignGetObject(key, {
        expiresIn: EXPIRES_IN,
        audience: URL_AUDIENCE.PUBLIC,
      });
      const internalUrl = await storage.presignGetObject(key, {
        expiresIn: EXPIRES_IN,
        audience: URL_AUDIENCE.INTERNAL,
      });

      expect(publicUrl.startsWith(process.env.S3_PUBLIC_ENDPOINT!)).toBe(true);
      expect(internalUrl.startsWith(process.env.S3_ENDPOINT!)).toBe(true);
    });

    it('should serve a byte range with 206 Partial Content', async () => {
      const url = await storage.presignGetObject(key, {
        expiresIn: EXPIRES_IN,
        audience: URL_AUDIENCE.PUBLIC,
      });

      const res = await requestPresignedUrl(url, {
        headers: { range: 'bytes=0-99' },
      });

      expect(res.status).toBe(206);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-range']).toBe(`bytes 0-99/${content.length}`);
      expect(res.body.equals(content.subarray(0, 100))).toBe(true);
    });

    it('should return Content-Disposition attachment for download URLs', async () => {
      const url = await storage.presignGetObject(key, {
        expiresIn: EXPIRES_IN,
        audience: URL_AUDIENCE.PUBLIC,
        downloadFileName: 'my clip.mp4',
      });

      const res = await requestPresignedUrl(url);

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="my clip.mp4"',
      );
    });

    it('should be readable by a server-side client through the internal URL', async () => {
      const url = await storage.presignGetObject(key, {
        expiresIn: EXPIRES_IN,
        audience: URL_AUDIENCE.INTERNAL,
      });

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(content)).toBe(true);
    });
  });

  it('should return null size for a missing object', async () => {
    expect(await storage.getObjectSize(`test/storage/${randomUUID()}`)).toBe(
      null,
    );
  });
});

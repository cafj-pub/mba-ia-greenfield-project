---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    source: "https://docs.nestjs.com/techniques/queues + installed type definitions (11.0.5)"
    fetched_at: "2026-10-17T19:10:00+01:00"
  bullmq:
    version: "^5.81.5"
    source: "https://docs.bullmq.io (going-to-production, retrying-failing-jobs, jobs/job-ids) + installed type definitions (5.81.5)"
    fetched_at: "2026-10-17T21:05:00+01:00"
  "@aws-sdk/client-s3":
    version: "^3.1152.0"
    source: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html + installed type definitions (3.1152.0)"
    fetched_at: "2026-10-17T21:05:00+01:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1152.0"
    source: "installed type definitions (3.1152.0) — getSignedUrl.d.ts, @smithy/types signature.d.ts"
    fetched_at: "2026-10-17T21:10:00+01:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-19T20:48:36+01:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this phase (`phase-03-videos/TD-01`, `TD-03`). **Source note:** the context7 MCP server is not configured in this repository's `.mcp.json` (only `postgres`), so each entry was pulled from the official documentation site and cross-checked against the type definitions of the exact versions resolved by npm inside the `nestjs-api` container (probe install in `/tmp`, project untouched). Re-check when the TD's lib set changes.

Version notes:

- `@nestjs/bullmq@12.0.0` and `bullmq@6.x` are the latest majors, but `bullmq@6` turned the Redis client into an optional peer and added non-Redis backends; the NestJS 11 docs describe the 5.x line. Pinned: `@nestjs/bullmq@^11.0.5` (peer: Nest 10/11) + `bullmq@^5.81.5` (bundles `ioredis@5`).
- FFmpeg is **not** an npm dependency: `fluent-ffmpeg` was archived/deprecated in May 2025 (`TD-04`). The worker image installs Debian's `ffmpeg` package (provides `ffmpeg` and `ffprobe`), invoked via `node:child_process` `spawn`.

## @nestjs/bullmq + bullmq

### Root connection and queue registration

```ts
// AppModule / WorkerModule — global infra
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },   // Compose service name, never localhost
    prefix: cfg.prefix,                                // key prefix, default 'bull'
  }),
}),
BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
```

`BullModule.forRoot(options)` / `forRootAsync(asyncOptions)` — options: `connection`, `prefix`, `defaultJobOptions`, `extraOptions`. `registerQueue({ name })` — `name` is the injection token (`@InjectQueue(name)`) and links consumers.

### Producer

```ts
constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}

await this.queue.add(PROCESS_VIDEO_JOB, { videoId }, {
  jobId: videoId,                                   // dedup: same id is ignored while retained
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },    // 2^(attempt-1) * delay → 5s, 10s
  removeOnComplete: true,
  removeOnFail: 100,
});
```

- Custom `jobId` must not contain `:` and must not be all digits (a UUID is valid).
- Adding a job whose id already exists (and was not removed) is a no-op.
- Exponential backoff delay = `2 ^ (attempts - 1) * delay` ms.

### Consumer (`WorkerHost`)

```ts
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<ProcessVideoJobData>): Promise<void> { ... }  // throw → retry

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    // final attempt when job.attemptsMade >= (job.opts.attempts ?? 1)
  }
}
```

- `@Processor(name, workerOptions?)` — `NestWorkerOptions` includes `concurrency`.
- Branch on `job.name` inside `process()` (no per-name handler decorators in BullMQ).
- `Job.attemptsMade` (number of finished attempts) and `job.opts.attempts` determine the final failure.
- `UnrecoverableError` (exported by `bullmq`) moves a job straight to failed without further retries.

### Production settings (docs.bullmq.io → Going to production)

- Workers using ioredis need `maxRetriesPerRequest: null` (BullMQ sets/warns about it for workers).
- Redis: enable AOF persistence (`appendonly yes`, fsync every second is enough) and `maxmemory-policy noeviction` — "the only setting that guarantees the correct behavior of the queues".
- Graceful shutdown: close the worker on `SIGTERM`/`SIGINT` (`app.enableShutdownHooks()` in the Nest context closes `@Processor` workers).
- Keep a handful of completed jobs and more failed jobs (`removeOnComplete` / `removeOnFail`).

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

### Client (MinIO-compatible)

```ts
new S3Client({
  endpoint: cfg.endpoint,            // internal: http://minio:9000 | public signer: http://localhost:9000
  region: cfg.region,                // MinIO accepts any; 'us-east-1'
  forcePathStyle: true,              // required by MinIO (bucket in path, not subdomain)
  credentials: { accessKeyId, secretAccessKey },
});
```

Two clients share credentials: the **internal** client performs server-side calls and signs worker input URLs; the **public** client only signs URLs returned to HTTP clients (`TD-03`, `TD-04` Revision).

### Multipart upload (S3 limits — qfacts)

| Item | Limit |
|------|-------|
| Single PUT | ≤ 5 GiB (→ 10GB requires multipart) |
| Part size | 5 MiB – 5 GiB; last part may be smaller |
| Parts per upload | 1 – 10,000 |
| `ListParts` page | ≤ 1,000 parts |

Commands: `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` (presigned); `ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker? })` → `Parts[{ PartNumber, ETag, Size }]`, `IsTruncated`, `NextPartNumberMarker`; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`; `AbortMultipartUploadCommand`; `HeadObjectCommand` → `ContentLength`; `PutObjectCommand` (thumbnail); `DeleteObjectCommand`.

### Presigned URLs

```ts
getSignedUrl(client, command, { expiresIn: seconds })   // Promise<string>
```

- Signature (`getSignedUrl.d.ts`): `(client, command, options?: RequestPresigningArguments) => Promise<string>`.
- `RequestPresigningArguments` (`@smithy/types`): `expiresIn?` (seconds; default 900, SigV4 max 604800), `signableHeaders?`, `unsignableHeaders?`, `unhoistableHeaders?`.
- SigV4 signs the `host` header: a URL signed for `localhost:9000` must be requested with `Host: localhost:9000`. Tests running inside the container reach MinIO at `minio:9000` while sending the signed `Host` (helper `src/test/s3.ts`).
- Download disposition: `GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="..."' })` — S3/MinIO return that `Content-Disposition` on the presigned GET.
- S3/MinIO serve `Range: bytes=a-b` on presigned GET with `206 Partial Content` + `Accept-Ranges: bytes` (`TD-06`).

### MinIO notes

- Images: `minio/minio` / `minio/mc` are no longer pullable from Docker Hub and `quay.io/minio/*` requires auth (checked 2026-10-19). Compose uses `cgr.dev/chainguard/minio` (MinIO RELEASE.2026-09-22, `server /data --console-address :9001`; has `bash` but no `curl`/`grep` → healthcheck via `/dev/tcp` on `/minio/health/live`, which needs a `Host` header) and `cgr.dev/chainguard/minio-client` (no shell → alias via env `MC_HOST_local=http://user:pass@minio:9000`, command `mb --ignore-existing local/$S3_BUCKET`).
- CORS: MinIO allows all origins by default (`MINIO_API_CORS_ALLOW_ORIGIN=*`), so browser part uploads work without bucket CORS config.

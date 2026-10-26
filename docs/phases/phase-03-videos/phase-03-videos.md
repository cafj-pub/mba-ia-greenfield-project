---
kind: phase
name: phase-03-videos
affected_subprojects: [nestjs-project]
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-24T22:51:19+01:00"
  docs/phases/phase-03-videos/validation.md: "2026-10-24T22:51:19+01:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-24T22:51:19+01:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-19T20:48:36+01:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file video ingestion without loading the API: a video is pre-registered as a draft when the upload starts, bytes go straight from the client to S3-compatible storage through presigned multipart URLs (up to 10GB, resumable), a queue hands the uploaded video to a separate FFmpeg worker that extracts duration/metadata and a thumbnail, and every video gets a short unique slug from which it can be streamed (HTTP range) and downloaded.

Pre-SI note: the baseline suite on a fresh environment was not fully green (`migrations.integration-spec.ts` fails because it drops tables but not enum types; `npm test` never exits because of a native open handle). SI-03.1 fixes both because this phase extends the migration test and the Definition of Done requires the full suite to pass.

---

## Step Implementations

### SI-03.1 — Test-suite Baseline Stabilisation

**Description:** Make the inherited unit/integration suite deterministic on a freshly migrated database and make `npm test` terminate, so every later SI can be verified against a green baseline.

**Technical actions:**

- `src/database/migrations.integration-spec.ts` — in `beforeAll`, drop managed tables **and** the PostgreSQL enum types created by migrations (`verification_tokens_type_enum`, later `video_status`) with `DROP TYPE IF EXISTS ... CASCADE`; run the drop statements sequentially (not `Promise.all` on a single connection)
- `package.json` jest config — add `"forceExit": true` with the reason recorded in `nestjs-project/CLAUDE.md` → "Jest Configuration": the `@css-inline/css-inline` native addon loaded by the mailer's `HandlebarsAdapter` leaves a `CustomGC` handle that cannot be closed from test code (`--detectOpenHandles` evidence)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/database/migrations.integration-spec.ts` | Integration | Migrations apply from scratch on a DB that was previously migrated via `npm run migration:run` |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose exec nestjs-api npm test -- --runInBand` reports 0 failures and exits on its own
- `npm run test:e2e` still passes (52/52)

---

### SI-03.2 — Dependencies, Storage/Queue Configuration and Compose Infrastructure

**Description:** Install the phase libraries, add `storage` and `queue` config namespaces, extend env validation, install FFmpeg in the dev image and add Redis, MinIO and the bucket-init job to Compose (per `phase-03-videos/TD-01`, `TD-03`).

**Technical actions:**

- Install in nestjs-project: `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`, `@aws-sdk/client-s3@^3.1152.0`, `@aws-sdk/s3-request-presigner@^3.1152.0` (versions per `library-refs.md`)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (default `'http://minio:9000'`), `S3_PUBLIC_ENDPOINT` (default `'http://localhost:9000'`), `S3_REGION` (default `'us-east-1'`), `S3_ACCESS_KEY` (required), `S3_SECRET_KEY` (required), `S3_BUCKET` (default `'streamtube-videos'`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`), `QUEUE_PREFIX` (default `'bull'`)
- Update `src/config/env.validation.ts` (new keys, `S3_ACCESS_KEY`/`S3_SECRET_KEY` required, URIs validated) and `.env.example`; load both namespaces in `AppModule`'s `ConfigModule.forRoot`
- `Dockerfile.dev` — `apt install -y ffmpeg` (provides `ffmpeg` + `ffprobe`, per `TD-04`)
- `compose.yaml` — add `redis` (`redis:7-alpine`, `--appendonly yes --maxmemory-policy noeviction`, `redis-cli ping` healthcheck, named volume), `minio` (`minio/minio`, `server /data --console-address :9001`, ports `9000`/`9001`, root user/password from `S3_ACCESS_KEY`/`S3_SECRET_KEY`, named volume) and `minio-init` (`minio/mc`, waits for MinIO, `mc mb --ignore-existing local/$S3_BUCKET`); `nestjs-api` depends on `redis` (healthy) and `minio-init` (completed successfully)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Unit (existing file) | Missing `S3_ACCESS_KEY` / `S3_SECRET_KEY` rejected; defaults applied for `REDIS_HOST`, `S3_BUCKET`, `QUEUE_PREFIX` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up -d` brings up `db`, `mailpit`, `redis`, `minio`, `nestjs-api`; `minio-init` exits 0 and bucket `streamtube-videos` exists
- `docker compose exec redis redis-cli ping` returns `PONG`; `docker compose exec nestjs-api ffprobe -version` succeeds
- App bootstrap fails Joi validation when `S3_ACCESS_KEY` is missing

---

### SI-03.3 — Video Entity, Migration and VideosModule

**Description:** Create the `Video` entity linked to `Channel` (many-to-one), the `video_status` enum, the migration creating `videos`, and register the entity in a new `VideosModule` (per `TD-05`, `TD-07`).

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` per `### Data Model → Video` (bigint/numeric columns with a number transformer); add `@OneToMany(() => Video, (video) => video.channel)` `videos` to `Channel`
- Create `src/videos/videos.constants.ts` — `VIDEO_STATUS` values, size/part/expiry constants from `TD-02`/`TD-06`, allowed MIME types, queue/job names
- Generate `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` and review SQL (enum, FK `ON DELETE CASCADE`, unique slug, channel index)
- Create `src/videos/videos.module.ts` with `TypeOrmModule.forFeature([Video])`; register in `AppModule`
- Extend `src/test/create-test-data-source.ts` `cleanAllTables` (delete `videos` before `channels`); add `Video` + new migration to `migrations.integration-spec.ts`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Defaults (`status = draft`), unique `slug`, enum rejects unknown status, FK to channel + cascade on channel delete, `file_size` round-trips as number > 2^31 |
| `src/database/migrations.integration-spec.ts` | Integration | 3 migrations apply; revert of the last removes `videos` and `video_status` |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `npm run migration:run` creates `videos` with all columns/constraints in `### Data Model`
- Duplicate slug insert fails; a 10,737,418,240-byte `file_size` is stored and read back as the same number

---

### SI-03.4 — Storage Module (S3/MinIO Client)

**Description:** Provide a `StorageService` shared by API and worker that wraps the S3 operations required by `TD-02`, `TD-03`, `TD-06`, with an internal client (server-side calls, worker input URLs) and a public client (client-facing presigned URLs).

**Technical actions:**

- Create `src/storage/storage.module.ts` + `src/storage/storage.service.ts` — two `S3Client`s (`forcePathStyle: true`), methods: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, expiresIn)`, `listParts(key, uploadId)` (follows `IsTruncated`/`NextPartNumberMarker`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `headObject(key)`, `putObject(key, body, contentType)`, `deleteObject(key)`, `presignGetObject(key, { expiresIn, audience: 'public' | 'internal', downloadFileName? })`
- Create `src/test/s3.ts` — helper that performs an HTTP request to a presigned public URL from inside the container (connects to `S3_ENDPOINT`, keeps the signed `Host` header) — per `TD-03` Revision / testing guide

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration (MinIO) | Multipart create → presigned part PUT → listParts → complete → headObject size; abort; presigned public GET with `Range` returns 206; download URL returns `Content-Disposition: attachment`; internal URL host is the internal endpoint |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with `storageConfig` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Presigned URLs returned for clients start with `S3_PUBLIC_ENDPOINT`; worker URLs start with `S3_ENDPOINT`
- A multipart upload done only through presigned part URLs produces an object of the expected size

---

### SI-03.5 — Video Domain Exceptions, Slug Generator and Channel Lookup

**Description:** Add the video error codes from `### Error Catalog`, the slug generator from `TD-05`, and a `ChannelsService.findByUserId` used to resolve the owner channel.

**Technical actions:**

- Add to `src/common/exceptions/domain.exception.ts`: `VideoNotFoundException`, `InvalidVideoStatusException`, `UploadIncompleteException`, `UploadSizeMismatchException`, `VideoNotReadyException`, `ChannelNotFoundException`
- Create `src/videos/slug.util.ts` — `generateVideoSlug(): string` = `randomBytes(8).toString('base64url')` (11 chars `[A-Za-z0-9_-]`)
- Add `ChannelsService.findByUserId(userId): Promise<Channel | null>`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/slug.util.spec.ts` | Unit | 11 chars, base64url alphabet only, distinct values across calls |
| `src/channels/channels.service.integration-spec.ts` | Integration (existing) | `findByUserId` returns the user's channel / `null` |
| `src/common/filters/domain-exception.filter.spec.ts` | Unit (existing) | New exceptions map to the catalog status/code |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- Each new exception produces `{ statusCode, error, message }` exactly as in `### Error Catalog`

---

### SI-03.6 — Create Video Draft and Initiate Multipart Upload (`POST /videos`)

**Description:** Pre-register the video as `draft` when the upload starts and return presigned part URLs so the client uploads straight to storage (`TD-02`, `TD-05`, `TD-07`).

**Technical actions:**

- Create `src/videos/dto/create-video.dto.ts` per `#### Validation Rules`; response DTOs `src/videos/dto/video-response.dto.ts`, `src/videos/dto/upload-session-response.dto.ts`
- Create `src/videos/videos.service.ts` — `createDraft(userId, dto)`: resolve channel (`ChannelNotFoundException` if none); `id = randomUUID()`, `source_key = videos/{id}/source`, `part_count = ceil(file_size / PART_SIZE)`; `createMultipartUpload`; insert row with slug (pre-check + unique-violation retry, max 5 attempts, as `ChannelsService`); on insert failure abort the multipart upload (compensation) and rethrow; presign every part (`expiresIn = 3600`)
- Create `src/videos/videos.controller.ts` — `@ApiTags('videos') @Controller('videos') @SkipThrottle()`; `POST /videos` (authenticated, `@ApiBearerAuth('access-token')`, OpenAPI per rules)
- Wire `StorageModule`, `ChannelsModule` into `VideosModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Part count math (exact multiple, remainder, 10 GiB → 160); slug retry on collision; abort compensation when insert fails; channel missing → exception |
| `src/videos/videos.service.integration-spec.ts` | Integration (DB + MinIO) | Draft row persisted with `upload_id`, `source_key`; multipart exists in MinIO; part URLs count = `part_count` |
| `test/videos.e2e-spec.ts` | E2E | 201 shape; 400 `VALIDATION_ERROR` (size > 10 GiB, MIME not allowed, missing title); 401 without token |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` with a valid body returns 201 with `video.status = "draft"`, an 11-char `video.slug` and `upload.parts.length = upload.part_count`
- The API process never receives video bytes (only JSON)
- `file_size = 10737418240` accepted; `10737418241` rejected with 400

---

### SI-03.7 — Owner Video Details and Upload Resume (`GET /videos/:slug`, `GET /videos/:slug/upload`)

**Description:** Let the owner observe the status cycle and resume an interrupted upload by listing uploaded parts and re-issuing URLs for missing ones (`TD-02`, `TD-06` Revision AMB-2).

**Technical actions:**

- `VideosService.findOwnedBySlug(userId, slug)` — joins channel; non-owner or unknown → `VideoNotFoundException`
- `VideosService.getUploadSession(userId, slug)` — requires `status = draft` and `upload_id` present (`InvalidVideoStatusException` otherwise); `listParts` → `uploaded_parts`; presign URLs only for missing part numbers
- Controller: `GET /videos/:slug`, `GET /videos/:slug/upload` (authenticated)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.integration-spec.ts` | Integration | After uploading part 1 of 2 via presigned URL, session lists part 1 as uploaded and returns a URL only for part 2 |
| `test/videos.e2e-spec.ts` | E2E | 200 owner; 404 for another user's video and for unknown slug; 409 resume on a non-draft video; 401 without token |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Another authenticated user receives `404 VIDEO_NOT_FOUND` for an existing video
- Resume never returns URLs for parts already present in storage

---

### SI-03.8 — Processing Queue Producer and Upload Completion (`POST /videos/:slug/upload/complete`)

**Description:** Register the BullMQ connection/queue, add the producer, and complete the multipart upload: verify parts and size, flip `draft → processing` and enqueue `process-video` (`TD-01`, `TD-02`, `TD-07`; `### Events/Messages`).

**Technical actions:**

- `AppModule`: `BullModule.forRootAsync` with `queueConfig` (`connection: { host, port }`, `prefix`)
- `VideosModule`: `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; create `src/videos/video-processing.producer.ts` — `enqueue(videoId)` with job options from `### Events/Messages`
- `VideosService.completeUpload(userId, slug)`:
  - owner + `status = draft` required
  - when `upload_id` is set: `listParts`; any part number in `1..part_count` missing → `UploadIncompleteException`; sum of part sizes ≠ `file_size` → abort multipart, conditional update `draft → failed` with `processing_error`, throw `UploadSizeMismatchException`; else `completeMultipartUpload` and clear `upload_id`
  - when `upload_id` is already null (a previous call assembled the object) → skip assembly
  - conditional update `draft → processing` (`WHERE status = 'draft'`); enqueue; if enqueue throws → revert `processing → draft` (compensation) and rethrow
- Controller: `POST /videos/:slug/upload/complete` → `202 Accepted` with the video

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-processing.producer.integration-spec.ts` | Integration (Redis, dedicated `QUEUE_PREFIX`) | Job `process-video` enqueued with `{ videoId }`, `jobId = videoId`, `attempts = 3`, exponential backoff 5000; second enqueue for same id is deduplicated |
| `src/videos/videos.service.spec.ts` | Unit | Missing part → incomplete; size mismatch → failed + abort; enqueue failure → status reverted; already-assembled path skips `completeMultipartUpload` |
| `src/videos/videos.service.integration-spec.ts` | Integration | Full complete against MinIO: object assembled, `upload_id` null, status `processing` in DB |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `BullModule.registerQueue` |
| `test/videos.e2e-spec.ts` | E2E | 202 + `status = processing`; 409 `UPLOAD_INCOMPLETE` with no parts; 422 `UPLOAD_SIZE_MISMATCH`; 409 `INVALID_VIDEO_STATUS` on a second complete after processing |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- After complete, `videos.status = 'processing'` and a `process-video` job exists for the video
- Status in DB reflects `draft → processing` or `draft → failed` per `### Data Model → Status transitions`

---

### SI-03.9 — Media Inspection Service (ffprobe / ffmpeg)

**Description:** Wrap FFmpeg CLI calls behind a `MediaService` used by the worker: metadata extraction and thumbnail generation, reading the input over HTTP (`TD-04`).

**Technical actions:**

- Create `src/video-worker/media.service.ts` — `probe(input)`: `spawn('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', input])` → parsed `{ durationSeconds, metadata }`; `extractThumbnail(input, atSeconds)`: `spawn('ffmpeg', ['-ss', t, '-i', input, '-frames:v','1','-vf','scale=1280:-2','-f','image2','-c:v','mjpeg','pipe:1'])` → JPEG `Buffer`; non-zero exit → `MediaProcessingError` carrying stderr tail
- Create `src/video-worker/probe-parser.ts` — pure `parseProbeOutput(json)` → `VideoMetadata` (`### Data Model → metadata`); no video stream → `MediaProcessingError('No video stream found')`
- Create `src/video-worker/thumbnail-time.ts` — `thumbnailTimestamp(duration)` = 10% of duration, 0 when unknown
- Create `src/test/media-fixtures.ts` — generates a short MP4 (`ffmpeg -f lavfi testsrc + sine`) in `os.tmpdir()` for tests

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/video-worker/probe-parser.spec.ts` | Unit | Duration/size/bitrate parsing, video + audio codecs, audio-less file, no video stream error |
| `src/video-worker/thumbnail-time.spec.ts` | Unit | 10% rule and 0 fallback |
| `src/video-worker/media.service.integration-spec.ts` | Integration (real ffmpeg) | Probe of generated MP4 returns duration ≈ fixture length + 320x240; thumbnail is a valid JPEG (SOI `FFD8`) ≤ 1280 wide; corrupt input rejects with `MediaProcessingError` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Metadata and thumbnail are produced from a URL/path input without writing the source video to local disk

---

### SI-03.10 — Video Worker (Processor, Processing Service, Entrypoint and Compose Service)

**Description:** Build the worker that consumes `process-video`, updates DB and storage, retries transient failures and marks `failed` after the last attempt; run it as its own Compose container (`TD-01`, `TD-04`, `TD-07`).

**Technical actions:**

- Create `src/video-worker/video-processing.service.ts` — `process(videoId)`: load video (missing or `status ≠ processing` → log and return, idempotent); presign **internal** GET (`TD-04` Revision); `probe`; thumbnail at `thumbnailTimestamp`; `putObject(videos/{id}/thumbnail.jpg, image/jpeg)`; conditional update `processing → ready` with `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at`; `markFailed(videoId, message)` conditional `processing → failed`
- Create `src/video-worker/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })` extends `WorkerHost`; `process(job)` delegates (errors propagate → retry); `@OnWorkerEvent('failed')` calls `markFailed` when `job.attemptsMade >= job.opts.attempts` or error is `UnrecoverableError` (catch-and-log allowed here per `nestjs-services.md` background-task rule)
- Create `src/video-worker/video-worker.module.ts` (Config + TypeORM + `BullModule.forRootAsync` + `registerQueue` + `StorageModule` + `TypeOrmModule.forFeature([Video])`) and `src/worker.ts` (`NestFactory.createApplicationContext`, `enableShutdownHooks()`)
- `package.json` script `start:worker`; `compose.yaml` service `video-worker` (same image, `command: npm run start:worker`, depends on `db`/`redis` healthy and `minio-init` completed, `restart: unless-stopped`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/video-worker/video-processing.service.integration-spec.ts` | Integration (DB + MinIO + ffmpeg) | Uploaded fixture → `ready` with duration, metadata, thumbnail object in MinIO; non-`processing` video untouched; corrupt source throws; `markFailed` sets `failed` + `processing_error` |
| `src/video-worker/video-processing.processor.spec.ts` | Unit | Delegates to service; `failed` event marks failed only on final attempt or `UnrecoverableError` |
| `src/video-worker/video-worker.module.spec.ts` | Unit | Worker module compiles (DI wiring) |

**Dependencies:** SI-03.8, SI-03.9

**Acceptance criteria:**

- `docker compose ps` shows `video-worker` running; its logs show it connected to the `video-processing` queue
- A completed upload reaches `ready` without any API involvement

---

### SI-03.11 — Streaming, Download and Thumbnail Delivery

**Description:** Public endpoints that authorize by state and redirect to short-lived presigned GET URLs; storage serves range requests (`TD-06`).

**Technical actions:**

- Create `src/videos/video-delivery.service.ts` — `getStreamUrl(slug)`, `getDownloadUrl(slug)` (`Content-Disposition: attachment; filename="<sanitized original_file_name>"`), `getThumbnailUrl(slug)`; unknown slug → `VideoNotFoundException`; `status ≠ ready` (or no thumbnail) → `VideoNotReadyException`; public audience, `expiresIn = 900`
- Controller: `@Public()` `GET /videos/:slug/stream`, `/download`, `/thumbnail` → `302` with `Location` (no body)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-delivery.service.spec.ts` | Unit | Not found / not ready branches; filename sanitization in disposition |
| `test/videos.e2e-spec.ts` | E2E | 302 + `Location` on ready video for anonymous caller; following `Location` with `Range: bytes=0-99` returns 206 and 100 bytes; download response carries `Content-Disposition: attachment`; 409 on processing video; 404 unknown slug |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- Playback starts from a byte range without downloading the full file (206 from storage)
- No video bytes pass through the API process

---

### SI-03.12 — Full-flow E2E Through the Compose Worker, OpenAPI Export and `api.http`

**Description:** Prove the whole pipeline with real infrastructure (API → MinIO → Redis → `video-worker` → DB) and publish the contract.

**Technical actions:**

- `test/videos-flow.e2e-spec.ts` — register/confirm/login; `POST /videos` with a generated MP4; upload parts via presigned URLs (`src/test/s3.ts`); complete; poll `GET /videos/:slug` until `ready` (timeout 60s); assert duration > 0, metadata width/height, thumbnail 302 → JPEG; stream 206; download disposition. Failure path: upload random bytes declared as `video/mp4` → eventually `failed` with `processing_error`
- Run `npm run openapi:export` and commit the updated `openapi.json`; add `/videos` requests to `api.http`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos-flow.e2e-spec.ts` | E2E (full infra) | Success path draft → processing → ready; failure path → failed after retries |
| `src/openapi-export.integration-spec.ts` | Integration (existing) | Exported spec contains the `/videos` paths |

**Dependencies:** SI-03.10, SI-03.11

**Acceptance criteria:**

- Two unique slugs are generated for two uploads of the same file
- Status cycle `draft → processing → ready | failed` observable in the `videos` table

---

### SI-03.13 — Documentation: CLAUDE.md and Architecture Diagram

**Description:** Reflect the real state of the code after the phase in the AI-facing docs.

**Technical actions:**

- Root `CLAUDE.md` — Message Queue `TBD` → BullMQ on Redis; videos/storage/worker summary
- `nestjs-project/CLAUDE.md` — new services (`redis`, `minio`, `minio-init`, `video-worker`) with readiness checks; Videos section (endpoints, status cycle, storage keys, worker, env vars, test helpers, `forceExit` note)
- `docs/diagrams/software-arch.mermaid` — queue container `TBD` → `BullMQ (Redis)`

**Tests:** _(empty — documentation only)_

**Dependencies:** SI-03.12

**Acceptance criteria:**

- Every file, command and endpoint cited in the docs exists in the code

---

### SI-03.14 — Lint Baseline Cleanup

**Description:** `npm run lint` already failed on `main` (~150 errors in 11 Phase 02 files, recorded in `progress.md` → SI-03.5). The Definition of Done requires lint to pass, so the pre-existing errors are fixed here, separately from the video feature, without changing ESLint rules (user decision, 2026-10-24).

**Technical actions:**

- Type the `any`-valued mocks, Joi results and supertest bodies in the affected specs (`auth.service.spec.ts`, `auth.service.integration-spec.ts`, `channels.service.spec.ts`, `domain-exception.filter.spec.ts`, `validation-exception.filter.spec.ts`, `env.validation.integration-spec.ts`, `mail.service.integration-spec.ts`, `users.service.integration-spec.ts`, `test/auth.e2e-spec.ts`) and helpers (`src/test/create-test-data-source.ts`)
- `src/channels/channels.service.ts` — replace the `as any` access in `isPgUniqueViolationOnColumn` with a typed driver-error shape
- No behaviour change: assertions stay identical

**Tests:** _(empty — no new behaviour; the existing suites are the regression net and must stay green)_

**Dependencies:** SI-03.12

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint` exits 0 (errors = 0)
- Full unit+integration and E2E suites pass with the same test counts as before the cleanup

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Generated in the service (`randomUUID()`) before insert so the storage key is known |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Owner channel (1 user → 1 channel) |
| slug | varchar(11) | unique, not null | `TD-05` — base64url, 11 chars |
| title | varchar(100) | not null | |
| status | enum `video_status` | not null, default `'draft'`, values `draft`, `processing`, `ready`, `failed` | `TD-07` |
| original_file_name | varchar(255) | not null | Used in download `Content-Disposition` |
| mime_type | varchar(100) | not null | One of the `TD-02` allowed types |
| file_size | bigint | not null | Declared bytes, ≤ 10,737,418,240; number transformer |
| part_size | integer | not null | 67,108,864 (64 MiB) |
| part_count | integer | not null | `ceil(file_size / part_size)` |
| source_key | varchar(255) | not null | `videos/{id}/source` |
| upload_id | varchar(255) | nullable | S3 multipart id; null once assembled |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg` |
| duration_seconds | numeric(10,3) | nullable | From ffprobe `format.duration`; number transformer |
| metadata | jsonb | nullable | See below |
| processing_error | text | nullable | Last failure message |
| processed_at | timestamp | nullable | When `ready` |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one via `channel_id`); Channel → Video (one-to-many `videos`)
**Indexes:** `(slug)` — unique, `(channel_id)`

**metadata (jsonb):** `{ format_name: string, bit_rate: number | null, size: number | null, width: number, height: number, video_codec: string, audio_codec: string | null, frame_rate: number | null }`

**Status transitions (`TD-07` Revision):** `draft → processing` (upload completed), `draft → failed` (size mismatch at completion), `processing → ready`, `processing → failed`. Every transition is a conditional `UPDATE ... WHERE status = <from>`.

**Storage keys (`TD-03`):** bucket `S3_BUCKET` (private), `videos/{id}/source`, `videos/{id}/thumbnail.jpg`.

---

### API Contracts

Common: protected endpoints require `Authorization: Bearer <access_token>`; the controller opts out of the global throttler (`TD-06` Revision ICC-2). Response bodies use `#### VideoResponse`.

#### VideoResponse

- id: string (uuid)
- slug: string (11 chars)
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- original_file_name: string
- mime_type: string
- file_size: number
- duration_seconds: number | null
- metadata: object | null (shape in Data Model)
- processing_error: string | null
- processed_at: string (ISO) | null
- created_at: string (ISO)
- updated_at: string (ISO)

#### POST /videos (SI-03.6)

**Request body:**
- title: string, required — 1..100 chars
- file_name: string, required — 1..255 chars
- file_size: integer, required — 1..10737418240
- mime_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`

**Response 201:**
- video: VideoResponse (`status = "draft"`)
- upload: { part_size: number, part_count: number, expires_at: string (ISO), parts: [{ part_number: number, url: string }] }

**Error responses:**
- 400 VALIDATION_ERROR
- 401: missing/invalid access token
- 404 CHANNEL_NOT_FOUND

#### GET /videos/:slug (SI-03.7)

**Response 200:** VideoResponse

**Error responses:** 401; 404 VIDEO_NOT_FOUND (unknown slug or not the owner)

#### GET /videos/:slug/upload (SI-03.7)

**Response 200:**
- part_size: number, part_count: number, expires_at: string (ISO)
- uploaded_parts: [{ part_number: number, size: number }]
- parts: [{ part_number: number, url: string }] — only missing parts

**Error responses:** 401; 404 VIDEO_NOT_FOUND; 409 INVALID_VIDEO_STATUS (not `draft` / already assembled)

#### POST /videos/:slug/upload/complete (SI-03.8)

**Request body:** none

**Response 202:** VideoResponse (`status = "processing"`)

**Error responses:** 401; 404 VIDEO_NOT_FOUND; 409 INVALID_VIDEO_STATUS; 409 UPLOAD_INCOMPLETE; 422 UPLOAD_SIZE_MISMATCH

#### GET /videos/:slug/stream (SI-03.11)

**Response 302:** `Location` = presigned GET URL (15 min) of the source; storage honors `Range` (206)

**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY

#### GET /videos/:slug/download (SI-03.11)

**Response 302:** `Location` = presigned GET URL (15 min) with `Content-Disposition: attachment; filename="<original_file_name>"`

**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY

#### GET /videos/:slug/thumbnail (SI-03.11)

**Response 302:** `Location` = presigned GET URL (15 min) of `thumbnail.jpg`

**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY

#### Validation Rules — Create Video

| Field | Rule | Error message |
|-------|------|---------------|
| title | string, 1..100 | title must be shorter than or equal to 100 characters |
| file_name | string, 1..255 | file_name must be shorter than or equal to 255 characters |
| file_size | integer, ≥ 1, ≤ 10737418240 | file_size must not be greater than 10737418240 |
| mime_type | in allowed list | mime_type must be one of the following values: … |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| POST /videos | | ✓ | Video belongs to the caller's channel |
| GET /videos/:slug | | ✓ (owner) | Non-owner → 404 (`TD-06` Revision AMB-2) |
| GET /videos/:slug/upload | | ✓ (owner) | |
| POST /videos/:slug/upload/complete | | ✓ (owner) | |
| GET /videos/:slug/stream | ✓ | | Only `ready` (`TD-06`) |
| GET /videos/:slug/download | ✓ | | Only `ready` |
| GET /videos/:slug/thumbnail | ✓ | | Only `ready` |

---

### Error Catalog

Format inherited from `phase-02-auth/TD-07`: `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown slug, or owner-only endpoint called by another user |
| CHANNEL_NOT_FOUND | 404 | Channel not found | Authenticated user without channel calls POST /videos |
| INVALID_VIDEO_STATUS | 409 | Video is not awaiting upload | Resume/complete when status ≠ `draft` (or resume after assembly) |
| UPLOAD_INCOMPLETE | 409 | Upload is missing parts | Complete with any part in `1..part_count` absent from storage |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | Sum of uploaded part sizes ≠ `file_size` (video → `failed`) |
| VIDEO_NOT_READY | 409 | Video is not ready | Stream/download/thumbnail when status ≠ `ready` |

---

### Events/Messages

#### process-video (queue `video-processing`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingProducer` called by `VideosService.completeUpload` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessingProcessor` in the `video-worker` container (per `phase-03-videos/TD-04`)
**Trigger:** upload completion flips the video `draft → processing`
**Job options:** `jobId = videoId` (dedup), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: 100`; Redis key prefix `QUEUE_PREFIX` (`TD-01` Revision AMB-3)
**Outcome:** success → `processing → ready` (duration, metadata, thumbnail); after the final attempt → `processing → failed` with `processing_error` (per `phase-03-videos/TD-07`)
**Delivery semantics:** at-least-once — the consumer is idempotent (skips videos not in `processing`; re-processing overwrites the same keys/columns) (per `phase-03-videos/TD-07`)

---

## Dependency Map

```
SI-03.1 (no deps)
└── SI-03.2
    ├── SI-03.3
    │   └── SI-03.5
    ├── SI-03.4
    └── SI-03.9

SI-03.4 + SI-03.5
└── SI-03.6
    └── SI-03.7
        └── SI-03.8
            ├── SI-03.11
            └── (with SI-03.9) SI-03.10

SI-03.10 + SI-03.11
└── SI-03.12
    └── SI-03.14
        └── SI-03.13
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.14 → SI-03.13 (SI-03.14 was added during implementation, after SI-03.5, so it keeps the next free number)

## Deliverables

- [ ] Baseline suite deterministic on a fresh DB and `npm test` exits on its own
- [ ] Redis (queue), MinIO + bucket init (object storage) and `video-worker` services start with `docker compose up -d`
- [ ] `videos` table + `video_status` enum created by migration; `Video` linked to `Channel`
- [ ] `POST /videos` pre-registers a `draft` and returns presigned multipart URLs (≤ 10 GiB, 64 MiB parts)
- [ ] Upload resume lists uploaded parts and re-issues URLs for missing ones
- [ ] Upload completion verifies parts/size and enqueues `process-video`
- [ ] Worker extracts duration + metadata (ffprobe) and a thumbnail (ffmpeg), sets `ready`; retries then `failed`
- [ ] Unique 11-char slug per video
- [ ] Streaming via 302 → presigned URL with HTTP range (206); download with `Content-Disposition: attachment`
- [ ] OpenAPI spec exported with `/videos` endpoints; `api.http` updated
- [ ] CLAUDE.md (root + nestjs-project) and architecture diagram updated
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Pre-existing lint errors from Phase 02 cleaned up without relaxing ESLint rules
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)

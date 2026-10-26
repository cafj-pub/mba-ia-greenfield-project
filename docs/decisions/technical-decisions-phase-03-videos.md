---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-17
scope_description: "Backend foundation for video upload and processing: queue technology, 10GB direct-to-storage upload protocol, storage key layout, video worker runtime and FFmpeg invocation, unique video URL, streaming/download delivery, and the video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the `videos` module (draft pre-registration, upload orchestration, status, streaming/download endpoints), the S3-compatible storage client, the queue producer, and the video worker entrypoint; `compose.yaml` receives the object storage, queue and worker services.
- `next-frontend/` — no open decision in this document: the challenge scope for Phase 03 is backend-only ("a interface de vídeo não faz parte do escopo desta fase"). Every API contract decided here (TD-02, TD-05, TD-06) is already shaped so a browser client can consume it later without backend changes.

_Given (not reopened here):_ object storage is S3-compatible — MinIO in local Docker, S3 in production (`docs/diagrams/software-arch.mermaid`: `Object Storage — S3 or MinIO`). The decisions below define **how** it is used, not which storage.

_Inherited:_ error envelope `{ statusCode, error, message }` and domain exceptions (`phase-02-auth/TD-07`), global JWT guard with `@Public()` opt-out (`phase-02-auth/TD-02`), class-validator DTOs (`phase-02-auth/TD-06`), `@nestjs/config` `registerAs` namespaces + Joi env validation (`phase-01-configuracao-base/TD-01..03`).

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as `TBD`. Video processing (ffprobe + thumbnail extraction on files up to 10GB) must run outside the API request cycle, survive API restarts, retry on transient failures and be consumed by a separate worker container. This is the main stack decision of the phase.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq`)
- Redis-backed job queue with first-party NestJS integration (`BullModule.forRoot/registerQueue`, `@Processor` + `WorkerHost`). Jobs carry attempts, exponential backoff, deduplication by `jobId`, and completed/failed retention.
- **Pros:** Official NestJS recipe (docs.nestjs.com/techniques/queues). Retry/backoff/idempotency built in — no hand-written ack logic. Consumer can live in a separate process/container sharing the same codebase. Redis is a single lightweight container.
- **Cons:** Adds Redis as new infrastructure. Redis persistence must be configured (AOF) to not lose jobs on restart. `bullmq@6` (recent major) moved the Redis client to an optional peer and added other backends; the NestJS 11 docs target the 5.x line, so the version must be pinned deliberately.

### Option B: RabbitMQ (`@nestjs/microservices` RMQ transport or `amqplib`)
- AMQP broker with durable queues, acks and dead-letter exchanges. Nest's RMQ transport offers `@EventPattern`/`@MessagePattern` handlers.
- **Pros:** True message broker — routing, fan-out, DLX, protocol-level acks. Language-agnostic consumers.
- **Cons:** No built-in delayed retry/backoff — must be built with DLX + TTL queues. Heavier container and operational model. Nest RMQ transport is designed for request/response microservices, not job semantics (attempts, progress, job state), so the job layer would be custom code.

### Option C: pg-boss (PostgreSQL-backed queue)
- Job queue stored in PostgreSQL tables using `SKIP LOCKED`. Retries, backoff and singleton jobs supported.
- **Pros:** No new infrastructure — reuses the existing `db` service. Job enqueue can share the same DB transaction as the video status update (outbox for free).
- **Cons:** No official NestJS integration (community wrappers only). Polling-based, adds write load to the primary DB. Contradicts the architecture diagram, which models the queue as its own container.

**Recommendation:** **Option A (BullMQ on Redis)** — it is the only option with an official NestJS 11 integration, and attempts/backoff/`jobId` dedup cover the retry and idempotency needs of TD-06 without custom broker plumbing; the extra Redis container matches the separate `Message Queue` container already in the architecture diagram. Pin `@nestjs/bullmq@^11.0.x` + `bullmq@^5.x` (the line documented for Nest 11), and run Redis with `appendonly yes` so queued jobs survive restarts.

**Decision:** A (BullMQ on Redis)

**Libraries:** `@nestjs/bullmq@^11.0.x`, `bullmq@^5.x`

**Revisions:**
- 2026-10-17 — Cross-reference corrected: the retry/idempotency needs covered by BullMQ are the ones defined in TD-07 (not TD-06). Rationale: validation IC-1 — prose drift, decision unchanged.
- 2026-10-17 — Queue key prefix is configurable (`QUEUE_PREFIX`, default `bull`); publisher integration tests use a dedicated prefix so the always-running `video-worker` never consumes their jobs, while the e2e full-flow test uses the default prefix and relies on the Compose worker (API → Redis → worker → MinIO → DB). Rationale: validation AMB-3 — test isolation vs. a permanently consuming worker.

---

## TD-02: Large-File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB file must not traverse the API process (memory, event-loop, request timeouts) and the project plan asks for resumability on connection failure (§4 "Pontos de Atenção"). S3 caps a single PUT at 5 GiB, so any 10GB upload into S3/MinIO is necessarily a multipart upload (parts 5 MiB–5 GiB, ≤ 10,000 parts). The handshake lives on both sides (backend issues URLs, a future frontend uploads parts), hence Cross-layer.

**Options:**

### Option A: Streaming multipart/form-data through the API
- Client POSTs the file to the API; the API streams it (busboy/`@aws-sdk/lib-storage`) into storage without buffering.
- **Pros:** Simplest client. API sees every byte (can validate on the fly).
- **Cons:** API bandwidth, sockets and request time scale with the file — a 10GB upload holds a connection for many minutes per user; no resume after a dropped connection; violates the "sem impacto na performance" requirement.

### Option B: Single presigned PUT URL
- API creates the draft and returns one presigned `PutObject` URL; client uploads straight to storage.
- **Pros:** API never touches the bytes. Trivial client.
- **Cons:** Hard 5 GiB limit on S3 single PUT — cannot satisfy 10GB. No resume.

### Option C: Presigned S3 multipart upload (API orchestrates, client uploads parts directly to storage)
- `POST` creates the draft video + `CreateMultipartUpload` and returns one presigned `UploadPart` URL per part (part size fixed server-side). Client PUTs parts directly to storage; a resume endpoint lists already-uploaded parts (`ListParts`) and re-issues URLs for missing ones; a complete endpoint calls `CompleteMultipartUpload` and enqueues processing.
- **Pros:** API only handles small JSON requests — bytes go client → storage. Supports 10GB (and beyond) within S3 limits. Resumable per part. Works identically on MinIO and S3 (same API).
- **Cons:** Three-step client protocol. Browser uploads need CORS on the bucket (MinIO allows any origin by default). Abandoned uploads leave incomplete parts until aborted or expired.

### Option D: tus protocol (tusd server or `@tus/server`)
- Resumable upload protocol via a dedicated tus endpoint/server that writes to S3.
- **Pros:** Standard resumable protocol with mature clients (Uppy, tus-js-client).
- **Cons:** Bytes still flow through a server we run (tusd or the API) — same bandwidth issue as A unless a separate tusd container is added; extra component and protocol on top of S3 multipart, which already gives resumability.

**Recommendation:** **Option C (presigned S3 multipart)** — it is the only option that keeps the 10GB payload entirely out of the API while staying inside S3 limits and giving per-part resume; MinIO implements the same multipart API, so the code path is the production path. Server fixes the part size at **64 MiB** (10 GiB → 160 parts, far under the 10,000 limit and the 1,000-entry `ListParts` page), presigned URLs expire in **1 hour** (re-issued by the resume endpoint), and the complete step lists parts server-side (client does not need to read `ETag` headers). Maximum declared size: **10 GiB (10,737,418,240 bytes)**; after completion the stored object size is verified against the declared size. Allowed MIME types: `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`.

**Decision:** C (Presigned S3 multipart)

---

## TD-03: Object Storage Layout and Access

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** API and worker both read/write storage keys and the keys are persisted in the `videos` table; the bucket must be created by Compose. The layout is a cross-component contract (API + worker + compose + DB). Production would swap MinIO for S3 by configuration only.

**Options:**

### Option A: Single private bucket, per-video key prefix
- One bucket (`streamtube-videos`), keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`. Bucket is private; all reads go through presigned URLs (TD-05).
- **Pros:** One bucket to provision. Everything of a video under one prefix (cleanup = delete prefix). Keys derive from the immutable video UUID, never from user input.
- **Cons:** Different lifecycle/caching policies for thumbnails vs originals require prefix-scoped rules rather than bucket-scoped ones.

### Option B: Separate buckets (`videos` private, `thumbnails` public-read)
- Originals in a private bucket; thumbnails in a public-read bucket served by plain URL.
- **Pros:** Bucket-level policies (public thumbnails, CDN later). Simple thumbnail URLs.
- **Cons:** Two buckets to provision and configure. Public-read bucket exposes thumbnails of draft/processing videos to anyone who guesses the key.

**Recommendation:** **Option A (single private bucket, per-video prefix)** — the phase has no public-listing feature that would benefit from a public thumbnail bucket, and keeping everything private behind presigned URLs avoids leaking assets of unpublished videos; the S3 client is configured with `forcePathStyle: true` (required by MinIO) and two endpoints: an internal one (`http://minio:9000`, Compose service name) for server-side calls and a public one (`http://localhost:9000` in dev) used only to sign URLs handed to clients. The bucket is created idempotently at Compose startup by a one-shot `minio/mc` init service.

**Decision:** A (Single private bucket, per-video prefix)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

**Revisions:**
- 2026-10-17 — Tests exercise the real MinIO service from Compose (no filesystem adapter); the testing guide's storage strategy was updated accordingly. Rationale: validation ICC-1 — multipart, `ListParts` and presigned URLs have no filesystem equivalent.
- 2026-10-19 — Compose images changed to `cgr.dev/chainguard/minio` (server) and `cgr.dev/chainguard/minio-client` (`mc`): `minio/minio` and `minio/mc` are no longer pullable from Docker Hub ("repository does not exist") and `quay.io/minio/*` requires authentication. The init job sets the alias via `MC_HOST_local` (the `mc` image has no shell) and runs `mc mb --ignore-existing`. Rationale: SI-03.2 implementation — same MinIO server/API, only the image source changes.

---

## TD-04: Video Worker Runtime and FFmpeg Invocation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "Serviço de processamento em segundo plano (filas)"

**Context:** The diagram defines a separate `Video Worker (FFmpeg)` container that consumes the queue, reads/saves storage and updates the DB. Decisions: where its code lives, how it runs, and how FFmpeg is driven (the de-facto wrapper `fluent-ffmpeg` was archived and deprecated in May 2025).

**Options:**

### Option A: Same codebase, separate entrypoint + separate container, FFmpeg via `child_process.spawn`
- `nestjs-project/src/worker.ts` boots a Nest application context (`NestFactory.createApplicationContext(WorkerModule)`) with the BullMQ `@Processor`; a `video-worker` Compose service runs it from the same image (with `ffmpeg` installed). `ffprobe -print_format json -show_format -show_streams` extracts metadata; `ffmpeg -ss <t> -i <url> -frames:v 1` produces the thumbnail. Input is a short-lived presigned GET URL (FFmpeg reads over HTTP with range requests — no 10GB download to local disk).
- **Pros:** Reuses entities, config, storage client and DI. Worker scales and crashes independently of the API. No unmaintained wrapper; ffprobe's JSON output is a stable contract.
- **Cons:** Image grows with ffmpeg (~hundreds of MB). Hand-written argument building and process error handling.

### Option B: Processor inside the API process (`@Processor` registered in `AppModule`)
- The API itself consumes jobs.
- **Pros:** Zero extra container.
- **Cons:** CPU-heavy FFmpeg competes with HTTP requests — contradicts "sem impacto na performance" and the separate worker container in the architecture.

### Option C: Separate standalone worker project (own `package.json`, e.g. `video-worker/`)
- A new subproject with its own dependencies and Dockerfile.
- **Pros:** Strong isolation; could be another language.
- **Cons:** Duplicates entity/config/storage code or requires a shared package (monorepo tooling not in place). More surface for a phase that only needs one job type.

**Recommendation:** **Option A** — keeps a single source of truth for the `Video` entity, config and storage client while still running as its own container, exactly as the architecture diagram draws it; spawning `ffprobe`/`ffmpeg` directly avoids depending on the archived `fluent-ffmpeg`. The thumbnail is taken at **10% of the duration** (falls back to 0s when duration is unknown), scaled to **1280px width** (aspect preserved), JPEG. The worker runs one job at a time (`concurrency: 1`) per container; scaling is horizontal (more replicas).

**Decision:** A (Same codebase, separate entrypoint + container, spawn ffprobe/ffmpeg)

**Revisions:**
- 2026-10-17 — The presigned GET URL used as FFmpeg/ffprobe input is signed with the **internal** endpoint (`S3_ENDPOINT`, `http://minio:9000`); the public endpoint signs only URLs returned to HTTP clients. Rationale: validation AMB-1 — a URL signed for `localhost:9000` is unreachable from inside the worker container.

---

## TD-05: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short public identifier used in URLs (`/videos/{slug}`), guaranteed unique (project plan §4: "URL curta e única que nunca conflite"). Frontend routes will embed it, hence Cross-layer.

**Options:**

### Option A: Expose the UUID primary key
- URLs use the `id` uuid.
- **Pros:** Zero extra column; unique by construction.
- **Cons:** 36 chars — not "curta". Couples the public URL to the internal PK.

### Option B: Random 11-char base64url slug (YouTube-like) with unique index + retry
- `crypto.randomBytes(8).toString('base64url')` → 11 chars from `[A-Za-z0-9_-]` (64 bits of entropy); stored in `slug varchar(11) UNIQUE`; on unique violation regenerate and retry (bounded attempts).
- **Pros:** Short, unguessable (not enumerable), no dependency (Node `crypto`). DB constraint is the final guarantee of no conflict.
- **Cons:** Needs a retry path on (astronomically rare) collisions.

### Option C: Hashids/Sqids over a sequential integer
- Encode an auto-increment id into a short string.
- **Pros:** Deterministic, collision-free, very short.
- **Cons:** Requires a sequential column + new dependency; reversible encoding makes IDs enumerable (leaks upload volume and lets anyone walk all videos).

**Recommendation:** **Option B** — short like the plan requires, non-enumerable (important while there is no visibility control until Phase 04), dependency-free, and the `UNIQUE` index makes conflicts impossible at the storage level; retry follows the pre-check/unique-violation pattern already used by `ChannelsService` for nicknames.

**Decision:** B (Random 11-char base64url slug + unique index)

---

## TD-06: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, and users can download the original. The diagram has `Frontend → Object Storage: Streams`, i.e. bytes should not flow through the API. A future `<video>` element and download button depend on the contract, hence Cross-layer.

**Options:**

### Option A: API proxies bytes with HTTP Range support
- `GET /videos/{slug}/stream` reads the `Range` header, calls `GetObject` with `Range`, pipes the body back with `206 Partial Content`.
- **Pros:** Storage stays fully private and unreachable; API controls every byte (auth, metrics).
- **Cons:** Every watched byte passes through the API — the bandwidth problem of upload reappears on playback. Contradicts the diagram.

### Option B: API authorizes and redirects (`302`) to a short-lived presigned GET URL
- `GET /videos/{slug}/stream` and `GET /videos/{slug}/download` validate state and respond `302 Location: <presigned URL>`; storage serves `Range` requests natively (`206 Partial Content`, `Accept-Ranges: bytes`). Download signs `response-content-disposition=attachment; filename="..."`.
- **Pros:** Zero bytes through the API; native range/seek support from S3/MinIO; same mechanism serves the thumbnail. Matches the architecture diagram.
- **Cons:** Presigned URL is a bearer capability until it expires (mitigated with short TTL). Needs a public storage endpoint for signing (TD-03).

### Option C: HLS/DASH adaptive streaming (transcode into segments)
- Worker transcodes into multiple renditions + playlist; player fetches segments.
- **Pros:** Adaptive bitrate; best playback experience on poor networks.
- **Cons:** Transcoding 10GB files is expensive (time, CPU, storage ×N); far beyond the phase capability, which only asks for playback without full download.

**Recommendation:** **Option B (302 to presigned GET URL)** — it delivers seekable playback through native HTTP range support of S3/MinIO without putting video bandwidth on the API, and the same pattern serves download (`Content-Disposition: attachment`) and thumbnail. Presigned GET URLs expire in **15 minutes** (player re-requests the API endpoint to refresh). Stream/download/thumbnail are only served when `status = ready` (otherwise `409 VIDEO_NOT_READY`) and are **public** (`@Public()`), consistent with the platform rule that anonymous users watch freely; the unguessable slug (TD-05) acts as the capability until Phase 04 introduces visibility (public/unlisted).

**Decision:** B (302 to presigned GET URL)

**Revisions:**
- 2026-10-17 — The video record endpoint (`GET /videos/{slug}`: title, status, duration, metadata, upload progress) is **owner-only** in this phase; non-owners and unknown slugs both receive `404 VIDEO_NOT_FOUND` (existence is not revealed). Public video details are deferred to Phase 05 (página de visualização). Rationale: validation AMB-2.
- 2026-10-17 — The videos controller opts out of the inherited global `ThrottlerGuard` with `@SkipThrottle()`; auth limits are unchanged. A video-specific throttle is a separate future task. Rationale: validation ICC-2 — `APP_GUARD` is global, so 10 req/min per IP would break upload resume and player URL refresh.

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is created as a draft before bytes arrive and moves through processing asynchronously. Failures can happen in the upload (never completed, size mismatch) or in the worker (corrupt file, ffmpeg crash, storage outage). The status column is shared by API, worker and future frontend polling.

**Options:**

### Option A: Linear states with automatic retries, terminal `failed`
- `draft` (row + multipart created) → `processing` (upload completed, job enqueued) → `ready` | `failed`. BullMQ job: `attempts: 3`, exponential backoff (5s base), `jobId = videoId` (dedup). Only after the last attempt fails does the worker set `failed` + `processing_error` (message). Size mismatch at completion → `failed` immediately.
- **Pros:** Transient errors (storage hiccup) self-heal; permanent errors become visible in the DB. Idempotent: re-processing the same video overwrites the same keys/columns.
- **Cons:** No user-facing "retry" action in this phase (a `failed` video must be re-uploaded).

### Option B: Same states + manual reprocess endpoint
- Option A plus `POST /videos/{slug}/reprocess` re-enqueuing failed videos.
- **Pros:** Recovers from bugs fixed after the failure without re-upload.
- **Cons:** Extra endpoint, authorization and state rules not requested by the phase capabilities.

### Option C: No retries — first failure is terminal
- **Pros:** Simplest.
- **Cons:** A transient storage/network blip permanently fails a 10GB upload.

**Recommendation:** **Option A** — automatic retries with a terminal `failed` state cover transient and permanent failures with the queue's built-in features, and the four-state enum maps 1:1 to the lifecycle required by the phase (`rascunho → processando → pronto/erro`); a manual reprocess endpoint can be added later without schema change. Status is a PostgreSQL enum `video_status` (`draft`, `processing`, `ready`, `failed`); transitions are guarded in the service (`processing` only from `draft`; `ready`/`failed` only from `processing`). Incomplete multipart uploads left by abandoned drafts are aborted by the storage's stale-upload expiry (MinIO default) — no cleanup job in this phase.

**Decision:** A (Linear states + automatic retries, terminal `failed`)

**Revisions:**
- 2026-10-19 — Allowed transitions made explicit: `draft → processing` (upload completed), `draft → failed` (only for size mismatch detected at completion — the sum of uploaded part sizes differs from the declared size; multipart is aborted and the API answers `422 UPLOAD_SIZE_MISMATCH`), `processing → ready`, `processing → failed`. Rationale: plan-build found that "size mismatch at completion → failed immediately" contradicted "`ready`/`failed` only from `processing`"; the decision (Option A) is unchanged.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ on Redis (`@nestjs/bullmq`) | A (BullMQ on Redis) |
| TD-02 | Cross-layer | Large-File Upload Protocol (up to 10GB) | Presigned S3 multipart | C (Presigned S3 multipart) |
| TD-03 | Backend | Object Storage Layout and Access | Single private bucket, per-video prefix | A (Single private bucket, per-video prefix) |
| TD-04 | Backend | Video Worker Runtime and FFmpeg Invocation | Same codebase, separate entrypoint/container, spawn ffprobe/ffmpeg | A (Same codebase, separate entrypoint + container, spawn ffprobe/ffmpeg) |
| TD-05 | Cross-layer | Unique Video URL Identifier | Random 11-char base64url slug + unique index | B (Random 11-char base64url slug + unique index) |
| TD-06 | Cross-layer | Streaming and Download Delivery | 302 to presigned GET URL | B (302 to presigned GET URL) |
| TD-07 | Backend | Video Status Lifecycle and Failure Handling | Linear states + auto retries, terminal `failed` | A (Linear states + automatic retries, terminal `failed`) |

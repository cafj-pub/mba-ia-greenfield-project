---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-17T14:17:21+01:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-19T20:48:36+01:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-17T14:17:21+01:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-17T14:17:21+01:00"
  docs/phases/phase-02-auth/context.md: "2026-10-17T14:17:21+01:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-17T20:54:35+01:00"
  .claude/skills/testing-guide-nestjs-project/references/external-systems.md: "2026-10-17T20:54:30+01:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ Boundary from neighbors: edição de informações do vídeo, categorias, visibilidade público/unlisted, fluxo rascunho → publicação e painel do canal pertencem à Fase 04; player e página de visualização pertencem à Fase 05.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (API, worker de vídeo e infraestrutura no `compose.yaml`)

**Deferred subprojects:** `next-frontend/` — a interface de vídeo não faz parte do escopo desta fase (backend-only).

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ on Redis) | @nestjs/bullmq@^11.0.x, bullmq@^5.x |
| phase-03-videos/TD-02 | phase | Cross-layer | Large-File Upload Protocol (up to 10GB) | decided | C (Presigned S3 multipart) | — |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Layout and Access | decided | A (Single private bucket, per-video prefix) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Runtime and FFmpeg Invocation | decided | A (Same codebase, separate entrypoint + container, spawn ffprobe/ffmpeg) | — |
| phase-03-videos/TD-05 | phase | Cross-layer | Unique Video URL Identifier | decided | B (Random 11-char base64url slug + unique index) | — |
| phase-03-videos/TD-06 | phase | Cross-layer | Streaming and Download Delivery | decided | B (302 to presigned GET URL) | — |
| phase-03-videos/TD-07 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (Linear states + automatic retries, terminal `failed`) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)
- openapi-docs-nestjs — `docs/decisions/technical-decisions-openapi-docs-nestjs.md` (scope_type: ad-hoc, correlator-confirmed — inherited, see below)

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** It is the only option with an official NestJS 11 integration, and attempts/backoff/`jobId` dedup cover the retry and idempotency needs of TD-06 without custom broker plumbing; the extra Redis container matches the separate `Message Queue` container already in the architecture diagram. Pin `@nestjs/bullmq@^11.0.x` + `bullmq@^5.x` (the line documented for Nest 11), and run Redis with `appendonly yes` so queued jobs survive restarts.

**Libraries:** `@nestjs/bullmq@^11.0.x`, `bullmq@^5.x`

**Revisions:**
- 2026-10-17 — Cross-reference corrected: the retry/idempotency needs covered by BullMQ are the ones defined in TD-07 (not TD-06). Rationale: validation IC-1 — prose drift, decision unchanged.
- 2026-10-17 — Queue key prefix is configurable (`QUEUE_PREFIX`, default `bull`); publisher integration tests use a dedicated prefix so the always-running `video-worker` never consumes their jobs, while the e2e full-flow test uses the default prefix and relies on the Compose worker (API → Redis → worker → MinIO → DB). Rationale: validation AMB-3 — test isolation vs. a permanently consuming worker.

### phase-03-videos/TD-02

**Recommendation:** It is the only option that keeps the 10GB payload entirely out of the API while staying inside S3 limits and giving per-part resume; MinIO implements the same multipart API, so the code path is the production path. Server fixes the part size at **64 MiB** (10 GiB → 160 parts, far under the 10,000 limit and the 1,000-entry `ListParts` page), presigned URLs expire in **1 hour** (re-issued by the resume endpoint), and the complete step lists parts server-side (client does not need to read `ETag` headers). Maximum declared size: **10 GiB (10,737,418,240 bytes)**; after completion the stored object size is verified against the declared size. Allowed MIME types: `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** The phase has no public-listing feature that would benefit from a public thumbnail bucket, and keeping everything private behind presigned URLs avoids leaking assets of unpublished videos; the S3 client is configured with `forcePathStyle: true` (required by MinIO) and two endpoints: an internal one (`http://minio:9000`, Compose service name) for server-side calls and a public one (`http://localhost:9000` in dev) used only to sign URLs handed to clients. The bucket is created idempotently at Compose startup by a one-shot `minio/mc` init service.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

**Revisions:**
- 2026-10-17 — Tests exercise the real MinIO service from Compose (no filesystem adapter); the testing guide's storage strategy was updated accordingly. Rationale: validation ICC-1 — multipart, `ListParts` and presigned URLs have no filesystem equivalent.
- 2026-10-19 — Compose images changed to `cgr.dev/chainguard/minio` (server) and `cgr.dev/chainguard/minio-client` (`mc`): `minio/minio` and `minio/mc` are no longer pullable from Docker Hub ("repository does not exist") and `quay.io/minio/*` requires authentication. The init job sets the alias via `MC_HOST_local` (the `mc` image has no shell) and runs `mc mb --ignore-existing`. Rationale: SI-03.2 implementation — same MinIO server/API, only the image source changes.

### phase-03-videos/TD-04

**Recommendation:** Keeps a single source of truth for the `Video` entity, config and storage client while still running as its own container, exactly as the architecture diagram draws it; spawning `ffprobe`/`ffmpeg` directly avoids depending on the archived `fluent-ffmpeg`. The thumbnail is taken at **10% of the duration** (falls back to 0s when duration is unknown), scaled to **1280px width** (aspect preserved), JPEG. The worker runs one job at a time (`concurrency: 1`) per container; scaling is horizontal (more replicas).

**Libraries:** —

**Revisions:**
- 2026-10-17 — The presigned GET URL used as FFmpeg/ffprobe input is signed with the **internal** endpoint (`S3_ENDPOINT`, `http://minio:9000`); the public endpoint signs only URLs returned to HTTP clients. Rationale: validation AMB-1 — a URL signed for `localhost:9000` is unreachable from inside the worker container.

### phase-03-videos/TD-05

**Recommendation:** Short like the plan requires, non-enumerable (important while there is no visibility control until Phase 04), dependency-free, and the `UNIQUE` index makes conflicts impossible at the storage level; retry follows the pre-check/unique-violation pattern already used by `ChannelsService` for nicknames.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** It delivers seekable playback through native HTTP range support of S3/MinIO without putting video bandwidth on the API, and the same pattern serves download (`Content-Disposition: attachment`) and thumbnail. Presigned GET URLs expire in **15 minutes** (player re-requests the API endpoint to refresh). Stream/download/thumbnail are only served when `status = ready` (otherwise `409 VIDEO_NOT_READY`) and are **public** (`@Public()`), consistent with the platform rule that anonymous users watch freely; the unguessable slug (TD-05) acts as the capability until Phase 04 introduces visibility (public/unlisted).

**Libraries:** —

**Revisions:**
- 2026-10-17 — The video record endpoint (`GET /videos/{slug}`: title, status, duration, metadata, upload progress) is **owner-only** in this phase; non-owners and unknown slugs both receive `404 VIDEO_NOT_FOUND` (existence is not revealed). Public video details are deferred to Phase 05 (página de visualização). Rationale: validation AMB-2.
- 2026-10-17 — The videos controller opts out of the inherited global `ThrottlerGuard` with `@SkipThrottle()`; auth limits are unchanged. A video-specific throttle is a separate future task. Rationale: validation ICC-2 — `APP_GUARD` is global, so 10 req/min per IP would break upload resume and player URL refresh.

### phase-03-videos/TD-07

**Recommendation:** Automatic retries with a terminal `failed` state cover transient and permanent failures with the queue's built-in features, and the four-state enum maps 1:1 to the lifecycle required by the phase (`rascunho → processando → pronto/erro`); a manual reprocess endpoint can be added later without schema change. Status is a PostgreSQL enum `video_status` (`draft`, `processing`, `ready`, `failed`); transitions are guarded in the service (`processing` only from `draft`; `ready`/`failed` only from `processing`). Incomplete multipart uploads left by abandoned drafts are aborted by the storage's stale-upload expiry (MinIO default) — no cleanup job in this phase.

**Libraries:** —

**Revisions:**
- 2026-10-19 — Allowed transitions made explicit: `draft → processing` (upload completed), `draft → failed` (only for size mismatch detected at completion — the sum of uploaded part sizes differs from the declared size; multipart is aborted and the API answers `422 UPLOAD_SIZE_MISMATCH`), `processing → ready`, `processing → failed`. Rationale: plan-build found that "size mismatch at completion → failed immediately" contradicted "`ready`/`failed` only from `processing`"; the decision (Option A) is unchanged.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability.

**Libraries:** —

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport`. The implemented `JwtAuthGuard` is global (`APP_GUARD`) with `@Public()` opt-out.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on. A simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration; the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. In-memory storage is sufficient for a single instance.

**Libraries:** `@nestjs/throttler@^6.x`

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — preserva `class-validator` (phase-02-auth/TD-06); o CLI plugin com `classValidatorShim: true` aproveita os decoradores existentes para inferir schemas.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — UI runtime + `openapi.json` exportado e commitado (`npm run openapi:export`), fundação para codegen do frontend.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts` with `allowUnknown: true, abortEarly: false`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`; the factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes only via generated migrations. _(from phase 01)_
- Every endpoint is protected by the global `JwtAuthGuard`; public routes opt out with `@Public()`; protected routes carry `@ApiBearerAuth('access-token')`. _(from phase 02)_
- Services throw `DomainException` subclasses (`src/common/exceptions/domain.exception.ts`); `DomainExceptionFilter` maps them to `{ statusCode, error, message }`. _(from phase 02)_
- Error responses in OpenAPI reference the shared `ApiErrorEnvelope` via `getSchemaPath`. _(from openapi-docs-nestjs)_
- Unique-handle generation uses pre-check + unique-violation retry (`ChannelsService.createChannel`). _(from phase 02)_
- Integration/e2e suites share the `db` service and run `--runInBand`; tables are cleaned with `DELETE FROM` in `beforeEach` (`cleanAllTables`). _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` UI surfaces handled in frontend slices. |
| "Confirmação de conta via e-mail com link de ativação" (UI) | deferred | phase-02-auth-frontend | UI landing screen de-scoped; BE side unchanged. |
| "Logout" (UI) | deferred | phase-02-auth-frontend | Logout button lives inside authenticated chrome (typically Phase 04). |
| "Recuperação de senha (destination screen)" | deferred | phase-02-auth-frontend | Reset-password destination screen absent from Figma. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, enum values (real DB) |
| Service with branching + DB | Unit (mocked repo) + Integration (DB contract) |
| Service with side-effect dep (storage, queue) | Integration against the real external system |
| Module with configured imports (`BullModule.registerQueue`, `TypeOrmModule.forFeature`) | Unit: compilation test |
| Controller | E2E only (no unit tests) |
| DTO | E2E: one validation wiring test per endpoint |
| Migration | Integration: migration runner apply/revert, restoring DB state in `afterAll` |

Per `testing-guide-nestjs-project` → `references/external-systems.md`: PostgreSQL real (Docker); Message Queue real (Docker) — publisher tests assert the job is enqueued with correct data, consumer tests submit a job and assert the outcome; Object Storage — real MinIO (Docker) — updated by `/plan-resolve` (ICC-1); presigned URLs exercised via `src/test/s3.ts`.

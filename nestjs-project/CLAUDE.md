# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis (queue):** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO (object storage):** `docker compose ps minio` shows `(healthy)`; `docker compose ps -a minio-init` shows `Exited (0)` (bucket created)
- **Video worker:** `docker compose logs video-worker` contains `Video worker consuming the video-processing queue`

`video-worker` is a background consumer, not the API server: it starts with `docker compose up -d` and that is expected.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, web UI `8025`
- `redis` — Redis 7 for BullMQ, port `6379` (AOF on, `maxmemory-policy noeviction`)
- `minio` — S3-compatible object storage, API `9000`, console `9001` (image `cgr.dev/chainguard/minio` — `minio/minio` is no longer on Docker Hub)
- `minio-init` — one-shot `mc mb --ignore-existing` that creates the `S3_BUCKET` bucket, then exits 0
- `video-worker` — same image/code as the API running `npm run start:worker` (`src/worker.ts`); consumes the `video-processing` queue. Not in watch mode: `docker compose restart video-worker` after changing worker code

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify Redis / MinIO / worker
docker compose exec redis redis-cli ping
docker compose ps minio minio-init video-worker

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand` — both npm scripts already pass it (`"test": "jest --runInBand"`, `"test:e2e": "jest --config ./test/jest-e2e.json --runInBand"`), so the plain commands are safe:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Running `npx jest` directly bypasses the scripts — add `--runInBand` yourself.

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

- `forceExit: true` (unit/integration config only) — the `@css-inline/css-inline` native addon, loaded by the mailer's `HandlebarsAdapter`, leaves a `CustomGC` handle (`npx jest --detectOpenHandles`) that test code cannot close; without it `npm test` prints the summary but never exits. Do not use it to hide handles your own tests leave open — close modules, apps and connections in `afterAll`.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos (Phase 03)

Upload, processing and delivery of videos up to 10 GiB. Decisions: `docs/decisions/technical-decisions-phase-03-videos.md`; plan and contracts: `docs/phases/phase-03-videos/phase-03-videos.md`.

**Upload never passes through the API.** `POST /videos` creates the row as `draft` and an S3 multipart upload, and returns one presigned `UploadPart` URL per 64 MiB part; the client `PUT`s each part straight to MinIO/S3, then calls `complete`.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /videos` | owner (Bearer) | Draft + presigned part URLs (`file_size` ≤ 10737418240, MIME `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`) |
| `GET /videos/:slug` | owner | Record with `status`, `duration_seconds`, `metadata` — other users get `404 VIDEO_NOT_FOUND` |
| `GET /videos/:slug/upload` | owner | Resume: parts already stored + fresh URLs for missing parts |
| `POST /videos/:slug/upload/complete` | owner | Verifies parts and total size, assembles, `draft → processing`, enqueues `process-video` (202) |
| `GET /videos/:slug/stream` | public | `302` to a 15-min presigned GET; storage serves `Range` → `206` |
| `GET /videos/:slug/download` | public | `302` to a presigned GET with `Content-Disposition: attachment` |
| `GET /videos/:slug/thumbnail` | public | `302` to the presigned JPEG thumbnail |

Public endpoints answer `409 VIDEO_NOT_READY` unless `status = ready`. `VideosController` has `@SkipThrottle()` — the auth `ThrottlerGuard` is registered as `APP_GUARD` and is therefore global.

**Status cycle** (`video_status` enum, every change is a conditional `UPDATE … WHERE status = <from>`): `draft → processing` (complete), `draft → failed` (uploaded size ≠ declared, `422 UPLOAD_SIZE_MISMATCH`), `processing → ready` (worker), `processing → failed` (worker, after the last attempt).

**Unique URL:** `slug` = 11-char base64url (`src/videos/slug.util.ts`), `UNIQUE` index + retry on collision.

**Code map:**

- `src/videos/` — `VideosController`, `VideosService` (draft/resume/complete), `VideoDeliveryService` (presigned redirects), `VideoProcessingProducer`, `video-processing.job.ts` (job payload + options), `videos.constants.ts`, `entities/video.entity.ts`, `dto/`
- `src/storage/` — `StorageModule` with two `S3Client`s: internal (`S3_ENDPOINT`, server-side calls and worker input URLs) and public (`S3_PUBLIC_ENDPOINT`, only signs URLs returned to clients). Both use `requestChecksumCalculation: 'WHEN_REQUIRED'` — the SDK default embeds a checksum into presigned part URLs that real uploads cannot match
- `src/video-worker/` + `src/worker.ts` — standalone Nest application context (`VideoWorkerModule`): `VideoProcessingProcessor` (`@Processor('video-processing', { concurrency: 1 })`), `VideoProcessingService`, `MediaService` (spawns `ffprobe`/`ffmpeg` on a presigned **internal** URL — no local copy; thumbnail at 10% of duration, 1280px wide)
- `src/common/infra/root-modules.ts` — `databaseRootModule()` / `queueRootModule()` shared by `AppModule` and `VideoWorkerModule`
- Storage keys (bucket `S3_BUCKET`, private): `videos/{id}/source`, `videos/{id}/thumbnail.jpg`

**Queue:** BullMQ on Redis, queue `video-processing`, job `process-video` with `{ videoId }`, `jobId = videoId` (dedup), 3 attempts, exponential backoff 5s → 10s. A file with no video stream throws `UnsupportedMediaError` → `UnrecoverableError` (fails at once). The `failed` event marks the video `failed` only on the final attempt.

**Env vars:** `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (required, also MinIO root credentials), `S3_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`. The worker validates with `workerEnvValidationSchema` (JWT secrets optional).

**Testing videos:**

- Storage and queue are real (MinIO + Redis from Compose); never mock them in integration/e2e tests.
- `src/test/s3.ts` → `requestPresignedUrl()` calls a URL signed for `localhost:9000` from inside the container (connects to `S3_ENDPOINT`, keeps the signed `Host`).
- `src/test/queue.ts` → `testBullRootModule()` uses the `test` prefix so the running `video-worker` never consumes test jobs; obliterate the queue in `afterAll`.
- `src/test/media-fixtures.ts` → generates MP4 fixtures with ffmpeg at test time (nothing binary committed).
- `test/videos-flow.e2e-spec.ts` exercises the full pipeline through the Compose `video-worker` — the stack must be up and the worker running current code.
- Clean up MinIO objects in `afterEach` (abort open uploads, delete assembled sources and thumbnails).

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

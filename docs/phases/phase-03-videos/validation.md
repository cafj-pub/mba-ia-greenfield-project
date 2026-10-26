---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-24T22:51:19+01:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-19T20:48:36+01:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-17T14:17:21+01:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-01 cites retry/idempotency needs of TD-06; retry policy lives in TD-07"
    resolved_by: phase-03-videos/TD-01
  - id: AMB-1
    status: resolved
    summary: "Which S3 endpoint signs the presigned GET URL used as FFmpeg input (TD-04)"
    resolved_by: phase-03-videos/TD-04
  - id: AMB-2
    status: resolved
    summary: "Visibility of the video details/status endpoint is undefined"
    resolved_by: phase-03-videos/TD-06
  - id: AMB-3
    status: resolved
    summary: "Queue test isolation vs. the always-running video-worker container"
    resolved_by: phase-03-videos/TD-01
  - id: ICC-1
    status: resolved
    summary: "Testing guide prescribes local-filesystem storage; TD-03 mandates MinIO"
    resolved_by: phase-03-videos/TD-03
  - id: ICC-2
    status: resolved
    summary: "Inherited ThrottlerGuard is global (APP_GUARD) — /videos gets 10 req/min"
    resolved_by: phase-03-videos/TD-06
  - id: IC-2
    status: resolved
    summary: "TD-07 size-mismatch → failed contradicts 'failed only from processing'"
    resolved_by: phase-03-videos/TD-07
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ TD cross-references now point to the TD that owns each concern (retry/idempotency → TD-07); TD-07 lists the allowed status transitions explicitly.

### Ambiguities

_None._ Worker input URLs are signed with the internal endpoint (TD-04 Revision); the video record endpoint is owner-only with 404 for non-owners (TD-06 Revision); queue test isolation uses a dedicated `QUEUE_PREFIX` for publisher tests and the Compose worker for the e2e full flow (TD-01 Revision).

### Missing Decisions

_None._ Every capability in `## Capability Coverage` maps to ≥1 decided TD. Contract sync (Decisão #29) not applicable — no UI scope; inherited `openapi-docs-nestjs/TD-02` covers the committed `openapi.json`.

### Dependency Gaps

_None._ Phase 02 delivered the global `JwtAuthGuard`, `DomainException` + filter and the 1:1 `User → Channel` relation consumed here.

### Inherited Constraint Conflicts

_None._ Storage test strategy aligned to real MinIO in the testing guide (ICC-1); `/videos` opts out of the global throttler with `@SkipThrottle()` while auth limits stay unchanged (ICC-2).

### Unresolved Open Questions

_None._ All 7 TDs are `decided`.

### UI Coverage Gaps

_None._ No UI scope in this phase (`## UI Inventory` absent).

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-01)_ — Revision appended: cross-reference corrected to TD-07. Decision A unchanged.
- **AMB-1** _(resolved_by phase-03-videos/TD-04)_ — Revision appended: FFmpeg/ffprobe input URL signed with the internal endpoint (`S3_ENDPOINT`, `http://minio:9000`); public endpoint only for client-facing URLs.
- **AMB-2** _(resolved_by phase-03-videos/TD-06)_ — Revision appended: `GET /videos/{slug}` owner-only; non-owners and unknown slugs get `404 VIDEO_NOT_FOUND`. Public details deferred to Phase 05.
- **AMB-3** _(resolved_by phase-03-videos/TD-01)_ — Revision appended: configurable `QUEUE_PREFIX`; publisher integration tests use a dedicated prefix; e2e full flow uses the default prefix and the Compose `video-worker`.
- **ICC-1** _(resolved_by phase-03-videos/TD-03)_ — Revision appended + `testing-guide-nestjs-project/references/external-systems.md` storage strategy changed to "Real MinIO (Docker)" (user choice: MinIO real + atualizar guia).
- **ICC-2** _(resolved_by phase-03-videos/TD-06)_ — Revision appended: videos controller uses `@SkipThrottle()`; video-specific throttle recorded as a future task.
- **IC-2** _(resolved_by phase-03-videos/TD-07)_ — Raised during `/plan-build` re-validation: TD-07 stated both "size mismatch at completion → `failed` immediately" and "`ready`/`failed` only from `processing`". Revision appended listing the allowed transitions (`draft → failed` only for size mismatch). Decision A unchanged.

_Re-validated 2026-10-24 after the SI-03.2 Revision on TD-03 (MinIO image source: `cgr.dev/chainguard/minio` / `minio-client`): same server/API and decision, no new issue — status stays `clean`._

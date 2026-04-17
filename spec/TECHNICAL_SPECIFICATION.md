# Sparient Backend Engine — Technical Specification (Canvas Access HUB)

**Document type:** Technical specification (API contracts, data mapping, workflows).  
**Version:** 1.1  
**Date:** 2026-04-15  

**Sources:** `spec/FUNCTIONAL_SPECIFICATION.md`, `prisma/schema.prisma`, `prisma/seed.ts`, `FILE_STATUSES.md`, existing Express error handling (`src/api/middleware/errorHandler.middleware.ts`, `src/utils/errors.ts`).

---

## 0. Schema alignment and resolved decisions

### 0.1 Where “comments” and “enrollment” appear in the functional spec (context only)

| Concept | Functional spec location | Role |
|--------|---------------------------|------|
| **Comments** | **§3.1.1** (file list row: read-only annotations), **§4.3** (comments not editable via this API), **traceability table** (Review course files) | **Course-scoped file list:** “Review course files” — each row shows a **single comment string** for the file. |
| **Enrollment / total students** | **§3.3.2** (Scanned Courses per-row: “Total students (or enrollment count as available)”) | **Admin — Scanned Courses** tab only; not used on course file review or course home. |

These are **different UI surfaces**: comments are **per file** in the **course** module; enrollment is **per course** in the **admin** module list.

### 0.2 File “comments” — implementation (no separate comments table)

- **Remediation artifact** rows live in **`batch_files`** (`BatchFile`).
- **API field:** `comment` (string, not an array).
- **Rule:** If the **latest `BatchFile`** for that `SourceFile` has `error_message` set, expose it as `comment`; otherwise **`""`** (empty string).
- **Resolution of “latest”:** Define consistently (e.g. `ORDER BY created_at DESC` or tie-break by `batch_id`); document in implementation.

### 0.3 Total students — not in scope

- Do **not** return `total_students` in API responses until enrollment is in scope.
- **OpenAPI / TypeScript models:** may reserve the field **commented out** until implemented, for example:

```typescript
// total_students: number | null  // not in scope — enrollment sync TBD
```

### 0.4 Dashboard metrics — database

- **Admin dashboard** and **course home** aggregates that lack backing columns today (e.g. content summary, “marked resolved”, “files marked reviewed”, institution rollups) require **new columns** (and/or roll-up tables) added via migration — **TODO: schema design** alongside implementation.

### 0.5 Accessibility score — calculation

- **Course-level** `accessibility.score_percent` (and institution-level **account** score where applicable):
  - Let `total_files` = count of `SourceFile` rows for the course (or institution scope).
  - Let `files_remediated` = count of `SourceFile` rows that count as **remediated** (product rule: e.g. `last_outcome` in `completed` / `completed_with_warnings` with a successful `BatchFile` / `remediated_s3_key` present — **finalize** in implementation).
  - **Score:** `score_percent = round(100 * files_remediated / total_files)` when `total_files > 0`, else `0` (or `100` if zero files — **confirm** with product).
- **Band** (`needs_attention` | `fair` | `good` | `strong`) is derived from `score_percent` with thresholds **TBD** (or match UI).

### 0.6 Impact scorecard — `FileIssueCategory.category` → high / medium / low

- **TODO:** Clarify mapping (scheduled follow-up). Until then, implement `impact_scorecard` as **placeholders** or omit from response if not yet defined.

---

## 1. Conventions

### 1.1 Base URL and versioning

- **Base path:** `/api/v1/access-hub` (new surface; existing services use `/api/v1/institutions`, `/api/v1/connectivo`, etc.).
- **Content-Type:** `application/json` for bodies.
- **Identifiers:**
  - **Institution:** UUID `institution_id` (`Institution.id`), path or query.
  - **Canvas course:** string `canvas_course_id` (`Course.canvas_course_id`), unique with `institution_id`.
  - **Canvas file:** string `canvas_file_id` (`SourceFile.canvas_file_id`), unique with `course_id`.
  - **Remediated artifact:** UUID **`batch_file_id`** only (`BatchFile.id` / table `batch_files`) — holds `remediated_s3_key` / `remediated_s3_bucket`, `error_message`, etc. No separate `remediated_file_id` in the API.

### 1.2 Authentication (initial phase)

- **HTTP Basic Authentication** on all `/api/v1/access-hub/**` routes (aligned with functional spec §4.1).
- Credentials validated against a **configured secret** (hash/compare implementation detail). On failure: **401** with standard error envelope (§1.5).
- **`/health`** remains unauthenticated (existing `app.ts` pattern).

### 1.3 Success envelope

```json
{
  "success": true,
  "data": {}
}
```

Lists may use `data` as an array or `{ "items": [], "page": {}, "meta": {} }` where pagination applies.

### 1.4 Error envelope

Aligned with `errorHandler.middleware.ts`:

```json
{
  "success": false,
  "error": {
    "code": "STRING",
    "message": "Human-readable message",
    "details": {}
  }
}
```

- `details` is optional (e.g. Zod `VALIDATION_ERROR` field errors).

### 1.5 HTTP status codes (catalog)

| Code | When |
|------|------|
| **200** | OK (GET, PATCH, successful mutation with body). |
| **201** | Created (optional for async job creation if resource record is created). |
| **202** | Accepted — request valid, work queued (recommended for **file replacement** trigger if async). |
| **400** | Malformed JSON, invalid query/body (`BAD_REQUEST`, `VALIDATION_ERROR`). |
| **401** | Missing/invalid Basic auth (`UNAUTHORIZED`). |
| **403** | Authenticated but not allowed for institution/course (`FORBIDDEN`). |
| **404** | Unknown institution, course, file, or batch file (`NOT_FOUND`). |
| **409** | Conflict (e.g. replacement already in progress, stale `batch_file_id`) (`CONFLICT`). |
| **429** | Rate limit exceeded (if global/per-route limiter returns this; align with Express `rate-limit` behavior). |
| **500** | Unexpected server error (`INTERNAL_ERROR`). |

---

## 2. Remediation settings mapping (`writebackOptIn`)

| UI / functional concept | `Institution.writebackOptIn` | `Course.writebackOptIn` |
|-------------------------|------------------------------|-------------------------|
| **Opt in** — remediate, **do not** auto upload/replace in Canvas | `false` | `false` when overriding |
| **Opt out** — remediate **and** upload/replace when pipeline produces replacement | `true` | `true` when overriding |

**Effective course policy:**

```
effective_writeback = Course.writebackOptIn ?? Institution.writebackOptIn
```

Seed (`prisma/seed.ts`) sets `Institution.writebackOptIn` to `false` at creation.

---

## 3. Derived file pipeline state (for APIs)

Source files do not store a single `status` enum; UI states are **derived** per `FILE_STATUSES.md`. Pseudocode (see §6) reuses these predicates:

- **Needs upload:** `s3_source_modified_at IS NULL OR s3_source_modified_at < discovered_modified_at`
- **Needs batching:** `s3_source_modified_at IS NOT NULL AND (batched_modified_at IS NULL OR batched_modified_at < s3_source_modified_at)`
- **In-flight Connectivo:** `batched_modified_at = s3_source_modified_at AND last_outcome IS NULL` (subject to doc’s “stale outcome” nuance)
- **Terminal:** `last_outcome IS NOT NULL AND batched_modified_at = s3_source_modified_at`

**Canvas replacement column** (functional: pending / replaced / failed) maps from:

- `SourceFile.writeback_state`: `written` | `skipped_stale` | `failed` (nullable if no writeback attempted)
- Plus context from `last_outcome` and whether a remediated artifact exists (`BatchFile.remediated_s3_key` on latest relevant row)

Exact label strings are UI copy; API should expose **stable enums** in addition to display strings, e.g. `canvas_replacement: "pending" | "replaced" | "failed" | "not_applicable"`.

**Status filter** (all / pending / done / failed): implement as filters on the above derived enums, not raw DB enums alone.

---

## 4. API endpoint specifications

### 4.1 Course — Home aggregates

**GET** `/api/v1/access-hub/institutions/{institution_id}/courses/{canvas_course_id}/dashboard`

**Purpose:** §3.2 — course accessibility score, counts, issues by file type, impact scorecard.

**Path parameters**

| Name | Type | Required |
|------|------|----------|
| `institution_id` | UUID | Yes |
| `canvas_course_id` | string | Yes |

**Success 200**

```json
{
  "success": true,
  "data": {
    "canvas_course_id": "string",
    "accessibility": {
      "score_percent": 0,
      "band": "needs_attention | fair | good | strong"
    },
    "counts": {
      "total_files": 0,
      "files_scanned": 0,
      "files_with_open_issues": 0,
      "open_issues": 0,
      "files_remediated": 0,
      "files_replaced_in_canvas": 0
    },
    "issues_by_file_type": [
      {
        "file_type": "pdf | image | word | excel | powerpoint | video | other",
        "issue_count": 0,
        "score_percent": 0
      }
    ],
    "impact_scorecard": {
      "high": 0,
      "medium": 0,
      "low": 0
    }
  }
}
```

**Errors:** 401, 403, 404 (`course` or `institution` not found).

**Notes:** Aggregates come from `Course` → `SourceFile` → latest `BatchFile` / `FileIssueCategory` as applicable. **`accessibility.score_percent`** follows §0.5. Other dashboard fields may depend on **new DB columns** (§0.4).

---

### 4.2 Course — File list (Review course files)

**GET** `/api/v1/access-hub/institutions/{institution_id}/courses/{canvas_course_id}/files`

**Purpose:** §3.1.1.

**Path parameters:** same as §4.1.

**Query parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `q` | string | No | Search across `display_name`, `file_name`. |
| `status` | enum | No | `all` (default), `pending`, `done`, `failed` — maps to derived remediation/replacement state. |
| `hide_replaced_in_canvas` | boolean | No | Default `false`. If `true`, exclude rows where Canvas replacement is `replaced`. |
| `page` | integer | No | 1-based. |
| `page_size` | integer | No | Max e.g. 100. |

**Success 200**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "source_file_id": "uuid",
        "canvas_file_id": "string",
        "display_name": "string",
        "file_name": "string",
        "file_type": "pdf | image | word | excel | powerpoint | video | other",
        "mime_type": "string",
        "last_updated": "2026-04-15T12:00:00.000Z",
        "status": {
          "pipeline": "needs_upload | needs_batching | in_flight | terminal | deleted",
          "last_outcome": "completed | completed_with_warnings | failed | permanently_failed | deleted | null",
          "summary": "string"
        },
        "canvas_replacement": {
          "state": "pending | replaced | failed | not_applicable",
          "writeback_state": "written | skipped_stale | failed | null"
        },
        "comment": ""
      }
    ],
    "page": { "number": 1, "size": 20, "total_items": 0 }
  }
}
```

**Errors:** 400 (invalid query), 401, 403, 404.

**Note:** `comment` — string from **latest `BatchFile.error_message`** for this `SourceFile`, else `""` (§0.2). Same rule for **§4.7** file rows.

---

### 4.3 Course — Remediation settings

**GET** `/api/v1/access-hub/institutions/{institution_id}/courses/{canvas_course_id}/settings`

**Success 200**

```json
{
  "success": true,
  "data": {
    "canvas_course_id": "string",
    "remediation_delivery": {
      "mode": "opt_in | opt_out",
      "effective_writeback_opt_in": true,
      "course_writeback_opt_in": true,
      "institution_writeback_opt_in": false
    }
  }
}
```

Mapping: `mode` is `opt_out` when `effective_writeback_opt_in === true`, else `opt_in`. Expose booleans for transparency (course override vs institution default).

**PATCH** `/api/v1/access-hub/institutions/{institution_id}/courses/{canvas_course_id}/settings`

**Body**

```json
{
  "remediation_delivery": {
    "mode": "opt_in | opt_out"
  }
}
```

**Success 200** — same shape as GET with updated values.

**Errors:** 400, 401, 403, 404, 409 (optional — if concurrent update policy requires).

**Persistence:** update `Course.writebackOptIn` to `true` for `opt_out`, `false` for `opt_in` (per §2).

---

### 4.4 Course — Trigger file replacement

**POST** `/api/v1/access-hub/institutions/{institution_id}/courses/{canvas_course_id}/files/{canvas_file_id}/replace`

**Purpose:** §3.1.3 — trigger replacement with remediated artifact.

**Body**

```json
{
  "batch_file_id": "uuid"
}
```

**Rules:** **`batch_file_id` only** — references `batch_files.id` (`BatchFile`).

**Validation:**

- Resolve `Course` by `(institution_id, canvas_course_id)`.
- Resolve `SourceFile` by `(course_id, canvas_file_id)`.
- Load `BatchFile` by id; ensure `batch_file.source_file_id` matches `SourceFile.id` and `batch_file.canvas_file_id` matches `canvas_file_id`.
- Ensure `remediated_s3_key` is present if replacement is meaningful (else 400).

**Success 202** (recommended — async queue)

```json
{
  "success": true,
  "data": {
    "request_id": "uuid",
    "status": "queued",
    "message": "Replacement workflow accepted; integration may be stubbed in initial phase."
  }
}
```

**Alternate 200** if synchronous stub completes immediately.

**Errors:** 400, 401, 403, 404 (course, file, or batch file), 409 (replacement already queued/completed).

---

### 4.5 Admin — Institutional dashboard

**GET** `/api/v1/access-hub/institutions/{institution_id}/dashboard`

**Purpose:** §3.3.1.

**Query parameters**

| Name | Type | Required |
|------|------|----------|
| `canvas_term_id` | string | No — filter courses where `Course.canvas_term_id` matches |

**Success 200**

```json
{
  "success": true,
  "data": {
    "institution_id": "uuid",
    "account_accessibility": {
      "score_percent": 0,
      "band": "string"
    },
    "total_scanned_courses": 0,
    "impact_scorecard": { "high": 0, "medium": 0, "low": 0 },
    "content_summary": {
      "errors": 0,
      "suggestions": 0,
      "issues_fixed": 0,
      "marked_resolved": 0
    },
    "course_files_summary": {
      "file_issues": 0,
      "total_files": 0,
      "files_remediated": 0,
      "files_marked_reviewed": 0
    }
  }
}
```

**Notes:** `canvas_term_id` filters which `Course` rows participate. Metrics that need persistence (**marked_resolved**, **files_marked_reviewed**, full **content_summary**, etc.) require **new columns** per §0.4.

**Errors:** 401, 403, 404.

---

### 4.6 Admin — Scanned courses list

**GET** `/api/v1/access-hub/institutions/{institution_id}/courses`

**Purpose:** §3.3.2.

**Query parameters**

| Name | Type | Required |
|------|------|----------|
| `canvas_term_id` | string | No |
| `q` | string | No — search course name / code |
| `page`, `page_size` | integer | No |

**Success 200**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "canvas_course_id": "string",
        "course_name": "string",
        "course_code": "string | null",
        "account_name": "string",
        "institution_id": "uuid",
        "initial_scan_at": "2026-04-15T12:00:00.000Z | null",
        "last_scanned_at": "2026-04-15T12:00:00.000Z | null",
        "counts": {
          "errors": 0,
          "suggestions": 0,
          "content_scanned": 0,
          "content_fixed": 0,
          "content_resolved": 0,
          "files_scanned": 0
        }
      }
    ],
    "page": { "number": 1, "size": 20, "total_items": 0 }
  }
}
```

**Derivation hints:**

- `initial_scan_at` / `last_scanned_at`: from `Batch` for that `course_id` (e.g. min/max `created_at` or `completed_at` where `is_initial_sync` / terminal — **define in implementation**).
- **`total_students`:** not in scope — **omit** from JSON responses. Reserved in client models as commented-out property (§0.3).

**Errors:** 400, 401, 403, 404.

---

### 4.7 Admin — Course files (cross-course)

**GET** `/api/v1/access-hub/institutions/{institution_id}/files`

**Purpose:** §3.3.3 — same columns as §4.2 plus course/account context.

**Query parameters:** `canvas_term_id`, `q`, `status`, `hide_replaced_in_canvas`, `page`, `page_size`, optional `canvas_course_id` filter.

**Success 200** — items extend §4.2 item with:

```json
{
  "canvas_course_id": "string",
  "course_name": "string",
  "account_name": "string"
}
```

**Errors:** same as §4.2.

---

### 4.8 Admin — Account remediation settings

**GET** `/api/v1/access-hub/institutions/{institution_id}/settings`

**Success 200**

```json
{
  "success": true,
  "data": {
    "institution_id": "uuid",
    "remediation_delivery": {
      "mode": "opt_in | opt_out",
      "writeback_opt_in": false
    }
  }
}
```

**PATCH** `/api/v1/access-hub/institutions/{institution_id}/settings`

**Body:** `{ "remediation_delivery": { "mode": "opt_in | opt_out" } }`  
**Persistence:** `Institution.writebackOptIn` (§2).

**Success 200** — same as GET.  
**Errors:** 400, 401, 403, 404.

---

## 5. Authorization model

- **Tenant boundary:** Every request is scoped by `institution_id` from the path (or resolved from credentials if future multi-tenant Basic auth maps user → institution). Cross-institution access must return **403** or **404** (choose one policy and document; `ConnectivoApiKey` comment in schema suggests **reject cross-institution** for scoped keys).
- **Course scope:** Course endpoints must verify `Course.institution_id === institution_id` from path.

---

## 6. Data flow and core logic (pseudocode)

### 6.1 Resolve course

```
function getCourse(institutionId, canvasCourseId):
  course = DB.find Course where institution_id = institutionId AND canvas_course_id = canvasCourseId
  if not course: raise NOT_FOUND
  return course
```

### 6.2 Effective writeback flag

```
function effectiveWritebackOptIn(course):
  inst = DB.find Institution by course.institution_id
  if course.writeback_opt_in is not NULL:
    return course.writeback_opt_in
  return inst.writeback_opt_in
```

### 6.3 Derived pipeline label (single file)

```
function pipelineLabel(sourceFile):
  if sourceFile.last_outcome == deleted:
    return "deleted"
  if needsUpload(sourceFile):
    return "needs_upload"
  if needsBatching(sourceFile):
    return "needs_batching"
  if inFlightConnectivo(sourceFile):
    return "in_flight"
  if terminal(sourceFile):
    return "terminal"
  return "unknown"  // should be rare; log
```

Where `needsUpload`, `needsBatching`, `inFlightConnectivo`, `terminal` follow predicates in `FILE_STATUSES.md`.

### 6.4 Canvas replacement state (API enum)

```
function canvasReplacementState(sourceFile, latestBatchFile):
  if no remediated artifact expected (policy opt_in and no writeback):
    return NOT_APPLICABLE
  if sourceFile.writeback_state == written:
    return REPLACED
  if sourceFile.writeback_state == failed:
    return FAILED
  if remediated exists but writeback not written:
    return PENDING
  ...
```

(Final branching requires product rules for `skipped_stale` and in-progress uploads.)

### 6.5 Trigger replacement (async)

```
function postReplace(institutionId, canvasCourseId, canvasFileId, batchFileId):
  course = getCourse(institutionId, canvasCourseId)
  sourceFile = DB.find SourceFile where course_id = course.id AND canvas_file_id = canvasFileId
  if not sourceFile: NOT_FOUND
  bf = DB.find BatchFile by id batchFileId
  if bf.source_file_id != sourceFile.id: BAD_REQUEST or NOT_FOUND
  if bf.remediated_s3_key is null: BAD_REQUEST
  enqueue Upload/Writeback job { sourceFileId, batchFileId, ... }  // may be stub
  return 202 { request_id, status: "queued" }
```

### 6.6 Institution dashboard rollups

```
function institutionDashboard(institutionId, canvasTermId?):
  courses = DB.find all Course where institution_id = institutionId
  if canvasTermId:
    courses = filter courses where canvas_term_id == canvasTermId OR policy for null term
  aggregate source_files and batches for those courses
  account_score_percent = 100 * sum(files_remediated across courses) / sum(total_files)  // or §0.5 per institution scope; align with product
  read content_summary / marked_resolved from NEW columns when migrated (§0.4)
  return JSON
```

### 6.7 Course accessibility score (percent)

```
function courseAccessibilityScorePercent(courseId):
  total_files = COUNT SourceFile WHERE course_id = courseId
  if total_files == 0:
    return 0  // or 100 per product — confirm
  remediated = COUNT SourceFile WHERE course_id = courseId AND <remediated predicate>
  return round(100 * remediated / total_files)
```

`<remediated predicate>` must match `counts.files_remediated` in §4.1 (same definition everywhere).

### 6.8 File row comment string

```
function fileCommentString(sourceFileId):
  bf = latest BatchFile for sourceFileId  // ORDER BY created_at DESC LIMIT 1
  if bf.error_message is not null and bf.error_message != "":
    return bf.error_message
  return ""
```

---

## 7. Security and scalability

### 7.1 Authentication

- **HTTP Basic** per functional spec; store **hashed** credentials or secure compare in config (`seed.ts` pattern uses hashing for API keys — mirror for Basic password).
- **TLS** in production; Basic over plaintext is unacceptable outside dev.

### 7.2 Authorization

- Enforce **institution scoping** on every query (`WHERE institution_id = :id` via joins on `Course` / `Institution`).
- Optional future: map Basic user to `institution_id` or role (admin vs instructor) — **not in current schema**; add before exposing mixed-role tenants.

### 7.3 Caching

- **Read-heavy aggregates** (dashboard, home): optional **short TTL** cache (e.g. 30–120s) keyed by `institution_id` + `canvas_course_id` + `canvas_term_id` + query hash; **invalidate** on batch completion webhooks or job completion.
- **ETag** / **If-None-Match** for large list endpoints if clients support it.

### 7.4 Performance targets (suggested; not SLA)

| Endpoint class | Target (p95) | Notes |
|----------------|--------------|-------|
| Single course settings GET/PATCH | < 200 ms | Indexed by UUID / unique composite |
| File list (paginated) | < 500 ms | Index `course_id`, avoid N+1 on batch files |
| Dashboard aggregates | < 1 s | Precomputed rollups or materialized views if needed |

### 7.5 Rate limiting

- Existing app: **100 req/min/IP** global (`src/app.ts`). Tighten `/access-hub` if UI is chatty; return **429** with `Retry-After` when possible.

### 7.6 Observability

- Structured logs with `institution_id`, `canvas_course_id`, request id; no secrets or full Basic headers.

---

## 8. Traceability

| Functional section | API sections |
|--------------------|--------------|
| §3.1.1 | §4.2, §4.7 |
| §3.1.2 | §4.3 |
| §3.1.3 | §4.4 |
| §3.2 | §4.1 |
| §3.3.1 | §4.5 |
| §3.3.2 | §4.6 |
| §3.3.3 | §4.7 |
| §3.3.4 | §4.8 |

---

## 9. Revision history

| Version | Date | Summary |
|---------|------|---------|
| 1.0 | 2026-04-15 | Initial technical specification from functional spec + Prisma schema + FILE_STATUSES. |
| 1.1 | 2026-04-15 | Comments from `BatchFile.error_message`; `batch_file_id` only for replace; score from remediated vs total files; dashboard metrics need new DB columns; enrollment out of scope; impact tier mapping TODO; functional-spec cross-ref for comments vs enrollment. |

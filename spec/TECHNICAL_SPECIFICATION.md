# Sparient Backend Engine — Technical Specification (Canvas Access Hub)

**Document type:** Technical specification (API contracts, data mapping, workflows).  
**Version:** 1.3  
**Date:** 2026-04-20  

**Sources:** `spec/FUNCTIONAL_SPECIFICATION.md`, `prisma/schema.prisma`, `prisma/seed.ts`, `FILE_STATUSES.md`, existing Express error handling (`src/api/middleware/errorHandler.middleware.ts`, `src/utils/errors.ts`).

---

## 0. Schema alignment and resolved decisions

### 0.1 Out of scope for Access Hub API payloads

- **Per-file review comments** — do **not** expose a separate `comment` field derived from `BatchFile.error_message` or other annotation strings for the Review table. Use **`status.summary`** (and related fields) for human-readable accessibility text per functional §3.1.1.
- **Enrollment / total students** — do **not** include enrollment or headcount on **Scanned courses** or any other endpoint.

### 0.2 Dashboard metrics (aligned with functional §3.2 / §3.3.1)

- **No accessibility scores:** do **not** return `score_percent`, bands, letter grades, impact scorecards, or per-type scores. Aggregates are **counts** and **category/issue breakdowns** only.
- **Course home** (`§4.1`): issue totals (**total reported**, **resolved**, **still open**), file-pipeline counts (**total files**, **scanned**, **with issues**, **awaiting review**, **fixed by Access Hub**, **replaced in Canvas** — exact JSON keys are implementation choices but must cover these concepts), **high-impact files** (identity + open issue count), **issues by file type** (`file_type`, **files** with issues, **issues** count), and **`issue_categories`** (see §0.3). **Current policy** text/mode still comes from **§4.3** (settings), not from the dashboard response alone.
- **Admin dashboard** (`§4.5`): same **counts-and-pipeline** spirit as course home at institution scope (see functional §3.3.1); **no** account percentage or score matrix. Include institution-level **`issue_categories`** rollup where the admin UI shows it.

### 0.3 `FileIssueCategory` on dashboards — listed by category

- Table **`file_issue_categories`** (`FileIssueCategory`): `category` (string), `found`, `fixed`, `remaining` (integers), tied to a **`BatchFile`**.
- **Dashboard list:** Return an array, e.g. `issue_categories`, where each element is `{ "category": "string", "found": 0, "fixed": 0, "remaining": 0 }`.
- **Aggregation rule (course or institution scope):** For each `SourceFile` in scope, take the **latest** `BatchFile` that represents the current remediation snapshot (define consistently: e.g. latest terminal `BatchFile` by `created_at`, or latest with `FileIssueCategory` rows — **finalize in implementation**). Sum `found`, `fixed`, and `remaining` **per `category` value** across those rows. Sort the list by a stable rule (e.g. category name, or remaining descending).
- **Granularity:** Individual scanner violations are **not** modeled row-by-row in schema today; the **listed** issues on the dashboard are **category rows** with the three counts. Finer-grained lines require future schema or vendor payloads.

### 0.4 Other persistence gaps

- Some rollups (e.g. **awaiting review** if driven by `SourceFile.review_acknowledged` and pipeline state) may combine existing columns with derived rules; additional columns or materialized views remain optional — design alongside implementation.

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

**Status filter** (e.g. all / in progress / complete / failed): implement as filters on the above derived enums, not raw DB enums alone (exact enum labels match functional §3.1.1).

---

## 4. API endpoint specifications

### 4.1 Course — Home aggregates

**GET** `/api/v1/access-hub/institutions/{institution_id}/courses/{canvas_course_id}/dashboard`

**Purpose:** §3.2 — issue totals, file-pipeline counts, high-impact files, issues by file type, **`issue_categories`** list (§0.3). **No** scores or score matrices.

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
    "issues": {
      "total_reported": 0,
      "resolved": 0,
      "still_open": 0
    },
    "counts": {
      "total_files": 0,
      "files_scanned": 0,
      "files_with_issues": 0,
      "awaiting_review": 0,
      "fixed_by_access_hub": 0,
      "files_replaced_in_canvas": 0
    },
    "high_impact_files": [
      {
        "source_file_id": "uuid",
        "canvas_file_id": "string",
        "display_name": "string",
        "open_issues": 0
      }
    ],
    "issues_by_file_type": [
      {
        "file_type": "string",
        "files": 0,
        "issues": 0
      }
    ],
    "issue_categories": [
      {
        "category": "string",
        "found": 0,
        "fixed": 0,
        "remaining": 0
      }
    ]
  }
}
```

**Errors:** 401, 403, 404 (`course` or `institution` not found).

**Notes:** Derive counts from `Course` → `SourceFile` → latest relevant `BatchFile` / `FileIssueCategory` per §0.2–§0.3. **`high_impact_files`** is typically ordered by `open_issues` descending; membership rule (e.g. open_issues > 0) is product-owned. Policy copy for Home still comes from **§4.3** GET settings.

---

### 4.2 Course — File list (Review course files)

**GET** `/api/v1/access-hub/institutions/{institution_id}/courses/{canvas_course_id}/files`

**Purpose:** §3.1.1.

**Path parameters:** same as §4.1.

**Query parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `q` | string | No | Search across `display_name`, `file_name`. |
| `status` | enum | No | `all` (default), `in_progress`, `complete`, `failed` — maps to derived remediation/replacement state. |
| `hide_replaced_in_canvas` | boolean | No | Default `false`. If `true`, exclude rows where Canvas replacement is `replaced`. |
| `sort` | string | No | e.g. `open_issues_desc` — matches Review sort controls. |
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
        "open_issues": 0,
        "review_acknowledged": false,
        "status": {
          "pipeline": "needs_upload | needs_batching | in_flight | terminal | deleted",
          "last_outcome": "completed | completed_with_warnings | failed | permanently_failed | deleted | null",
          "summary": "string"
        },
        "canvas_replacement": {
          "state": "pending | replaced | failed | not_applicable",
          "writeback_state": "written | skipped_stale | failed | null"
        }
      }
    ],
    "page": { "number": 1, "size": 20, "total_items": 0 }
  }
}
```

**Errors:** 400 (invalid query), 401, 403, 404.

**Note:** **`open_issues`** from latest relevant `BatchFile` / `FileIssueCategory` (or product rule). **`review_acknowledged`** from `SourceFile.review_acknowledged`. Do **not** return a separate review **`comment`** field. Same row shape for **§4.7** (plus course context fields).

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
    "scanned_courses": 0,
    "issues": {
      "total_reported": 0,
      "resolved": 0,
      "still_open": 0
    },
    "content_summary": {
      "errors": 0,
      "suggestions": 0,
      "issues_fixed": 0,
      "marked_resolved": 0
    },
    "file_pipeline": {
      "total_files": 0,
      "files_scanned": 0,
      "files_with_issues": 0,
      "awaiting_review": 0,
      "fixed_by_access_hub": 0,
      "files_replaced_in_canvas": 0
    },
    "issue_categories": [
      {
        "category": "string",
        "found": 0,
        "fixed": 0,
        "remaining": 0
      }
    ]
  }
}
```

**Notes:** `canvas_term_id` filters which `Course` rows participate. **`issue_categories`** uses the same aggregation approach as §0.3 across all `SourceFile` rows in scope. Optional summary fields may still rely on **new columns** or rollups (§0.4).

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

### 5.1 Current phase (implemented direction)

- **Tenant boundary:** Every request is scoped by `institution_id` in the path. The caller (e.g. Access Hub UI backend or LTI middleware) must only request resources for the institution it represents. Cross-institution access must return **403** or **404** (pick one policy and apply consistently).
- **Course scope:** Course endpoints must verify `Course.institution_id === institution_id` from the path.
- **Authentication:** HTTP Basic (or equivalent shared secret) as in §1.2 — suitable for early integration when the **only** client is a trusted server. **Target replacement:** **signed service requests** (§5.3) for calls from LMS integration middleware to this API.

### 5.2 End-user and platform identity (middleware responsibility)

The **Sparient Access Hub API** is invoked server-to-server. End-user and LMS context are established **before** that call (typical patterns below). The middleware then calls this API using **§5.3** (or Basic during transition).

| Layer | Role |
|-------|------|
| **LTI 1.3** | Launch in Canvas (or other LTI 1.3 platform): validate platform-signed JWTs (`iss`, `aud`, `exp`, nonce); read context and role claims; map instructor vs admin. |
| **OAuth 2.0 / OIDC (Canvas as IdP)** | User completes Canvas login; middleware obtains tokens and may call Canvas APIs to confirm course access; middleware issues or holds a session. |
| **Per-tenant secrets for signing** | Signing key material used for **§5.3** may be stored per `Institution` (or per deployment); rotate on a schedule. |

**Principles:** (1) Do **not** rely on path parameters alone once any untrusted client could reach this API — the signing key (or Basic secret) must bind to **institution** (and optionally service identity). (2) Separate instructor (course) and institution-admin surfaces in the middleware (routes, keys, or claims). (3) Prefer **short-lived** proof of freshness in signatures (timestamp window) over long-lived passwords for production traffic.

### 5.3 Signed service requests (target for API authentication)

**Goal:** Only a **trusted integration service** (BFF / LTI tool server) that already validated LMS context may call `/api/v1/access-hub/**`. Requests carry a **cryptographic signature**; this API verifies it with a **shared secret** or **verifying key** configured per institution (or global deployment key with path-scoped checks).

**Recommended pattern (illustrative; exact headers and string-to-sign belong in OpenAPI / implementation):**

1. **Canonical string** includes at least: HTTP method, path (and query if present), **SHA-256 hash of body** (or empty body marker), **Unix timestamp** (seconds), and a **nonce** or request id if replay protection beyond clock skew is required.
2. **HMAC-SHA256** (or equivalent) over that canonical string using the institution’s **signing secret** (or a deployment-wide secret plus mandatory `institution_id` match in path).
3. Client sends signature in a dedicated header (e.g. `X-Signature`) plus `X-Timestamp` (and optional `X-Nonce`). Reject if timestamp is outside an allowed skew (e.g. ±5 minutes).
4. **TLS** is still required in production; signing is **not** a substitute for HTTPS.

**401** if signature missing, malformed, or wrong; **403** if signature valid but `institution_id` in the path is not allowed for that key.

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
  aggregate source_files and batches for those courses into issue totals, file_pipeline counts, content_summary (counts only)
  issue_categories = rollup FileIssueCategory per §0.3 across all SourceFiles in those courses
  return JSON  // no score_percent or impact scorecard
```

### 6.7 Course home dashboard rollups

```
function courseDashboard(institutionId, canvasCourseId):
  course = getCourse(institutionId, canvasCourseId)
  compute issues.{total_reported, resolved, still_open} and counts.* per §4.1 / functional §3.2
  high_impact_files = filter/sort SourceFiles with open_issues (product rule)
  issues_by_file_type = group by file type with files + issues counts
  issue_categories = rollup FileIssueCategory per §0.3 for SourceFiles in course
  return JSON
```

---

## 7. Security and scalability

### 7.1 Authentication

- **Initial:** HTTP Basic per §1.2 / functional spec; store **hashed** credentials or secure compare in config.
- **Target:** **Signed service requests** per **§5.3** from LMS integration middleware; document header names and string-to-sign in OpenAPI when implemented.
- **TLS** in production; credentials or signing secrets must never be sent except over HTTPS.

### 7.2 Authorization

- Enforce **institution scoping** on every query (`WHERE institution_id = :id` via joins on `Course` / `Institution`).
- See **§5** for tenant rules and recommended LMS-oriented authentication and authorization patterns beyond Basic + path scope.

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
| 1.3 | 2026-04-20 | §5: adopt **signed service requests** as target API auth (§5.3); LTI/OAuth as middleware-only; remove mTLS as co-primary option; §7.1 aligned. |
| 1.2 | 2026-04-20 | Aligned dashboards with functional §3.2/§3.3.1: no scores; `issue_categories` list (`found`/`fixed`/`remaining`); course home high-impact files and issues-by-type; removed review `comment` and enrollment; file list adds `open_issues`, `review_acknowledged`, sort; expanded §5 with LMS-friendly auth options (LTI 1.3, OAuth, etc.). |
| 1.1 | 2026-04-15 | Comments from `BatchFile.error_message`; `batch_file_id` only for replace; score from remediated vs total files; dashboard metrics need new DB columns; enrollment out of scope; impact tier mapping TODO; functional-spec cross-ref for comments vs enrollment. |
| 1.0 | 2026-04-15 | Initial technical specification from functional spec + Prisma schema + FILE_STATUSES. |

# Sparient Engine — Frontend API Contract

Authoritative reference for the HTTP endpoints the frontend hits. All paths are prefixed with `/api/v1`. All responses are JSON. Error responses follow the shape `{ "error": "<message>", "code": "<CODE>" }`.

---

## Institutions

### Update institution

`PATCH /institutions/:institutionId`

Update editable fields on an institution. Every field in the body is optional — only the fields you send are written. The other columns stay untouched.

**Request body:**

```jsonc
{
  "name": "string",                // 1–255 chars
  "syncEnabled": true,
  "syncTime": "02:00",             // "HH:MM" UTC
  "writebackOptIn": true,
  "syncConfig": { ... }            // see syncConfig section below
                                   // OR null to reset to defaults
                                   // OR omit to leave unchanged
}
```

**Response (200 OK):**

```jsonc
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Test University",
    "slug": "test-u",
    "sourceType": "canvas",
    "writebackOptIn": false,
    "s3Bucket": null,
    "syncEnabled": true,
    "syncTime": "02:00",
    "syncConfig": { ... } | null,
    "lastSyncedAt": "2026-04-29T02:00:12Z" | null,
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-05-01T13:24:00Z"
    // NOTE: `credentials` is intentionally never returned. Don't expect it.
  }
}
```

**Errors:**

| Status | When |
|--------|------|
| `400`  | Body validation failed (bad field, unknown enum value, bad shape). Message names the offending field. |
| `404`  | Institution not found. |
| `500`  | Server error. |

---

### `syncConfig` shape

`syncConfig` is a JSON blob of seven optional fields. **All fields are optional.** If you send `syncConfig` at all, you can include any subset — fields you omit keep their existing stored values (merge semantics, NOT replace).

```jsonc
{
  "excludedCanvasCourseIds": ["105", "106"],            // Canvas course IDs to skip
  "allowedFileTypes":        ["pdf", "docx"],            // logical file types to sync
  "allowedCourseStates":     ["available", "unpublished"],
  "maxFileSizeBytes":        52428800,                   // 50 MB; null = no cap
  "skipLockedFiles":         false,                      // skip Canvas-locked files
  "skipHiddenFiles":         false,                      // skip Canvas-hidden files
  "writebackRequiresReviewAck": false                    // reserved (no effect today)
}
```

#### Field-by-field

**`excludedCanvasCourseIds: string[]`**
Exact-match exclude list against Canvas's course ID. Empty array = no exclusions.

**`allowedFileTypes: FileType[]`**
Logical type names. **Default for new/null institutions:** `["pdf", "docx", "pptx", "xlsx", "jpg", "png"]`. Send `[]` to fall back to the default (open-by-default; you can't block all file types via this field — disable sync entirely instead).

Supported values:

| Value | Extensions matched |
|-------|---------------------|
| `pdf` | `.pdf` |
| `docx` | `.docx` |
| `pptx` | `.pptx` |
| `xlsx` | `.xlsx` |
| `doc` | `.doc` |
| `ppt` | `.ppt` |
| `xls` | `.xls` |
| `odt` | `.odt` |
| `odp` | `.odp` |
| `ods` | `.ods` |
| `rtf` | `.rtf` |
| `txt` | `.txt` |
| `csv` | `.csv` |
| `epub` | `.epub` |
| `html` | `.html`, `.htm` |
| `jpg` | `.jpg`, `.jpeg` |
| `png` | `.png` |
| `gif` | `.gif` |
| `webp` | `.webp` |
| `bmp` | `.bmp` |
| `tiff` | `.tiff`, `.tif` |
| `svg` | `.svg` |

The string `"jpeg"` is accepted as an alias for `"jpg"` (no need to teach users the distinction).

Archives (`.zip`, `.rar`) are intentionally not supported — see `docs/TODO.md` → *Archive support* for the rationale and what would need to change.

**`allowedCourseStates: CourseState[]`**
Canvas course states to include. **Default:** `["available", "unpublished"]`. Allowed values: `"available"`, `"unpublished"`, `"completed"`. (Canvas also has `"created"` and `"deleted"` — we deliberately don't accept those.)

Empty array = fall back to default.

**`maxFileSizeBytes: number | null`**
Skip files larger than this many bytes. Must be a positive integer if set. `null` (default) = no cap. Files Canvas reports without a known size are always included regardless of cap.

**`skipLockedFiles: boolean`**
When `true`, files marked `locked` in Canvas are skipped. Default `false`.

**`skipHiddenFiles: boolean`**
When `true`, files marked `hidden` in Canvas are skipped. Default `false`.

**`writebackRequiresReviewAck: boolean`**
Reserved for the upcoming writeback feature. Settable today, but no consumer reads it on this branch. Will gate `qualityLabel = 'RequiresReview'` files behind a manual ack when wired up. Default `false`.

#### Reset to defaults

Send `"syncConfig": null` to clear the column entirely. The engine will resolve to all defaults on next sync.

#### Merge semantics example

Existing stored config:
```jsonc
{ "excludedCanvasCourseIds": ["105"], "skipLockedFiles": true }
```

You PATCH:
```jsonc
{ "syncConfig": { "skipHiddenFiles": true } }
```

Resulting stored config:
```jsonc
{
  "excludedCanvasCourseIds": ["105"],     // preserved
  "skipLockedFiles": true,                 // preserved
  "skipHiddenFiles": true,                 // added
  // other fields fill in defaults at validate time
  "allowedFileTypes": ["pdf","docx","pptx","xlsx","jpg","png"],
  "allowedCourseStates": ["available","unpublished"],
  "maxFileSizeBytes": null,
  "writebackRequiresReviewAck": false
}
```

#### Validation errors

A bad enum value names the offending value plus the supported list:

```
File type 'webp2' is not supported. Supported types: pdf, docx, pptx, xlsx, doc, ppt, xls, odt, odp, ods, rtf, txt, csv, epub, html, jpg, png, gif, webp, bmp, tiff, svg.
```

A bad type for a field (e.g. number where boolean expected) returns 400 with the JSON path of the offender:

```jsonc
{ "error": "syncConfig.skipLockedFiles: Expected boolean, received number", "code": "BAD_REQUEST" }
```

The whole PATCH is atomic — if any validation fails, nothing is written.

#### "Existing syncConfig has invalid values" error

Rare but possible: a 400 with a message starting `"Existing syncConfig has invalid values; PATCH { \"syncConfig\": null } first to reset, then re-apply your changes."`. This means the institution's stored `syncConfig` blob contains values that the current schema rejects (typically a manual DB edit, or an older registry entry that's since been removed — e.g. archives like `zip`/`rar`). We refuse to silently salvage because that would hide config drift. Recovery: send `PATCH { "syncConfig": null }` to reset the column to NULL (defaults take over), then re-apply your intended changes in a follow-up PATCH.

This error path is **not** triggered by malformed *user input* — that's caught by the body validation above. It only fires when the *already-stored* config is invalid and the current PATCH would have to merge into it.

---

### Wipe institution data

`DELETE /institutions/:institutionId/data`

Wipes all course/file/batch data for an institution, leaving the institution row intact. Useful for resetting dev/test or forcing a clean re-sync.

**Response:**
```jsonc
{
  "success": true,
  "institutionId": "uuid",
  "deleted": {
    "issueCategories": 0, "batchFiles": 0, "batches": 0, "sourceFiles": 0, "courses": 0
  }
}
```

---

### Create institution — coming soon

`POST /institutions` is on the roadmap (see `docs/TODO.md`). Until it ships, institutions are created via `npm run db:seed`. Frontend should design the registration form against the body shape documented in TODO.md.

---

## Sync

### Trigger institution sync

`POST /sync/institutions/:institutionId?force=true`

Enqueues a discovery message. Returns immediately (202-style).

**Response (200 OK):**
```jsonc
{
  "success": true,
  "message": "Sync enqueued",
  "institutionId": "uuid"
}
```

`?force=true` clears `lastSyncedAt` on every course of the institution and rewinds `discoveredModifiedAt` so every file is re-evaluated on the next sync. Use sparingly — kicks a full re-process.

---

### Trigger single-course sync

`POST /sync/institutions/:institutionId/courses/:courseId?force=true`

Same shape as above, scoped to one Canvas course id.

---

## Batches

### Get batch

`GET /batches/:batchId`

Returns a batch with its institution and course.

```jsonc
{
  "success": true,
  "data": {
    "id": "uuid",
    "institutionId": "uuid",
    "courseId": "uuid",
    "status": "completed" | "completed_with_warnings" | "failed" | "pending",
    "totalFiles": 12,
    "succeeded": 11,
    "failed": 1,
    "requiresReview": 0,
    "totalIssuesFound": 38,
    "totalIssuesFixed": 36,
    "completedAt": "2026-04-29T02:14:33Z" | null,
    "institution": { ... },
    "course":      { ... }
  }
}
```

### Get batch files

`GET /batches/:batchId/files`

Returns the per-file results for a batch, including issue categories.

### List batches for an institution

`GET /batches/institutions/:institutionId?status=completed&courseId=...`

### Stuck batches

`GET /batches/stuck?olderThanHours=24`

Returns pending batches whose `request_written_at` is older than N hours — Connectivo never produced a response in time.

---

## Replace (push remediated files back to Canvas)

These are the **external-facing** replace endpoints. Callers address files purely by Canvas ids — they never need our batch ids. The server always resolves the **latest completed remediation** for a file itself, so there is no "superseded by a newer batch" conflict to handle.

Both are **asynchronous**: a successful call stamps `writebackState='queued'` and enqueues the work; the writeback worker performs the Canvas push later and stamps the terminal state (`written` | `skipped_stale` | `failed`). **An accepted file is *queued*, not yet written** — poll the file's `writebackState` for the final outcome.

> The older, UI-oriented `POST /batches/:batchId/files/:batchFileId/replace` (replace one *specific* batch version) still exists and is unchanged.

### Replace one file

`POST /institutions/:institutionId/courses/:canvasCourseId/files/:canvasFileId/replace`

- `:institutionId` — our internal institution UUID.
- `:canvasCourseId`, `:canvasFileId` — Canvas's own ids.
- No request body.

**Response (202 Accepted):**

```jsonc
{ "success": true, "status": "queued", "canvasFileId": "12345" }
```

**Errors:**

| Status | When |
|--------|------|
| `404`  | Institution, course, or file not found (course must be synced and the file discovered). |
| `409`  | File has no completed remediation, or the completed remediation has no output to write back. |
| `502`  | Failed to enqueue the writeback job (the optimistic `queued` stamp is rolled back). |

### Bulk replace (course-scoped)

`POST /institutions/:institutionId/courses/:canvasCourseId/files/replace`

Replace many files in one course in a single call.

**Request body:**

```jsonc
{
  "canvasFileIds": ["12345", "67890"]   // explicit list, max 100
                                        // OR omit / send {} -> every eligible file in the course
}
```

- An explicit list longer than **100** → `400`.
- Omitting the list targets every file in the course with a completed remediation; if that set exceeds **100**, the call `400`s and asks you to pass an explicit list (no silent truncation).

**Response — partial success.** Each file is admitted independently, so one failure never blocks the rest:

```jsonc
{
  "success": true,
  "accepted": [
    { "canvasFileId": "12345" }
  ],
  "rejected": [
    { "canvasFileId": "67890", "code": "no_completed_remediation",
      "reason": "File has no completed remediation to write back" },
    { "canvasFileId": "99999", "code": "not_found",
      "reason": "File not discovered in this course" }
  ]
}
```

| Status | When |
|--------|------|
| `202`  | At least one file was queued. Inspect `accepted` / `rejected` for the per-file breakdown. |
| `422`  | Zero files were queued (every requested file was rejected); `success: false`, see `rejected`. |
| `400`  | List exceeds 100, or "all eligible" expansion exceeds 100. |
| `404`  | Institution or course not found. |

**Per-file rejection `code`s:** `not_found`, `no_completed_remediation`, `no_remediated_output`, `enqueue_failed`.

---

## Conventions

- **Auth:** None on this branch. The endpoints are infra-trusted (CI / ops only). Any frontend will sit behind whatever auth layer the broader product team wires up.
- **Timestamps:** ISO-8601 UTC.
- **IDs:** Internal IDs are UUIDs. Canvas IDs are strings (always — Enterprise tenants exceed JS Number range).
- **Pagination:** Not yet — all collection responses are unpaginated. Add `?limit` / `?cursor` if a customer hits a count where it matters.
- **Idempotency:** PATCH is idempotent. `POST /sync/...` is at-least-once (kicks SQS); duplicate calls are coalesced by the discovery handler if they arrive in the same minute.

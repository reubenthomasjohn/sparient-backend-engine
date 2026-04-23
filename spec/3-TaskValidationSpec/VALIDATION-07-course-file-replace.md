# VALIDATION-07 — Course file replace

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.1.3 (trigger file swap with remediated artifact; placeholder integration acceptable)

## Parameters

| Name | In | Required |
|------|-----|----------|
| `institution_id` | path | yes |
| `canvas_course_id` | path | yes |
| `canvas_file_id` | path | yes |
| `batch_file_id` | body | yes |

## Result

- **202** (preferred) `data`: `request_id`, `status` (e.g. `queued`), `message`
- **200** acceptable if synchronous stub completes immediately
- **400** if `remediated_s3_key` null or body invalid
- **404** if course, source file, or batch file not found / mismatched `source_file_id` or `canvas_file_id`
- **409** if replacement already in progress (when implemented)

## Behavior

- **401** / **403** per auth and scope
- Idempotency / conflict rules documented if multiple POSTs for same file

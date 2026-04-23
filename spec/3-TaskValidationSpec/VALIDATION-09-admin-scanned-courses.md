# VALIDATION-09 — Admin scanned courses

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.3.2 (tabular courses with metrics; counts not scores; **no** enrollment in API)

## Parameters

| Name | In | Required |
|------|-----|----------|
| `institution_id` | path | yes |
| `canvas_term_id` | query | no |
| `q` | query | no |
| `page` | query | no |
| `page_size` | query | no |

## Result

- **200** `data.items[]` with: `canvas_course_id`, `course_name`, `course_code`, `account_name`, `institution_id`, `initial_scan_at`, `last_scanned_at`, `counts` (errors, suggestions, content_scanned, content_fixed, content_resolved, files_scanned)
- **Pagination:** `page.number`, `page.size`, `page.total_items`
- **Forbidden on each item:** `total_students`, `enrollment`, `score_percent`

## Behavior

- **400** invalid pagination
- **401** / **404** / **403** per scope
- Search matches course name and/or code per implementation

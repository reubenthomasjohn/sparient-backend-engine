# VALIDATION-05 — Course files list

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.1.1 (file list, filters, sort, accessibility summary in `status.summary`, replacement states, open issues; no separate comments field)

## Parameters

| Name | In | Required | Notes |
|------|-----|----------|--------|
| `institution_id` | path | yes | |
| `canvas_course_id` | path | yes | |
| `q` | query | no | `display_name`, `file_name` search |
| `status` | query | no | default `all`; `in_progress`, `complete`, `failed` |
| `hide_replaced_in_canvas` | query | no | default false |
| `sort` | query | no | e.g. `open_issues_desc` |
| `page` | query | no | 1-based |
| `page_size` | query | no | cap e.g. 100 |

## Result

- **200** `data.items[]` each with: `source_file_id`, `canvas_file_id`, `display_name`, `file_name`, `file_type`, `mime_type`, `last_updated`, `open_issues`, `review_acknowledged`, `status` (pipeline, last_outcome, summary), `canvas_replacement` (state, writeback_state)
- **Pagination:** `data.page`: `number`, `size`, `total_items`
- **Forbidden:** `comment` key on items

## Behavior

- **400** invalid enum or page params
- **401** / **404** / **403** per TASK-01/02
- `hide_replaced_in_canvas=true` excludes rows whose replacement state is replaced
- `status` filters align with derived pipeline/replacement (exact mapping documented in implementation)

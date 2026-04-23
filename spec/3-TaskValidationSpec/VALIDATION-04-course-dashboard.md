# VALIDATION-04 — Course dashboard

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.2 (issue totals, file pipeline counts, high-impact files, issues by file type; no scores; policy via settings §3.1.2)

## Parameters

| Name | In | Required |
|------|-----|----------|
| `institution_id` | path | yes |
| `canvas_course_id` | path | yes |

## Result

- **200** `success: true`, `data` includes at minimum:
  - `canvas_course_id`
  - `issues`: `total_reported`, `resolved`, `still_open`
  - `counts`: `total_files`, `files_scanned`, `files_with_issues`, `awaiting_review`, `fixed_by_access_hub`, `files_replaced_in_canvas`
  - `high_impact_files[]`: `source_file_id`, `canvas_file_id`, `display_name`, `open_issues`
  - `issues_by_file_type[]`: `file_type`, `files`, `issues`
  - `issue_categories[]`: `category`, `found`, `fixed`, `remaining`
- **Forbidden keys** anywhere in `data`: `score_percent`, `band`, `impact_scorecard`, accessibility grade fields

## Behavior

- **401** without valid auth
- **404** if institution or course composite unknown (per TASK-02 policy)
- **403** if scope policy uses 403 for cross-tenant
- Counts are non-negative integers; empty course yields zeros and empty arrays where appropriate

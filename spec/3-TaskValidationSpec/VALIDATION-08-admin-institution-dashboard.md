# VALIDATION-08 — Admin institution dashboard

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.3.1 (institution-wide counts and summaries; no percentage or score matrix; issue-oriented and file-pipeline totals)

## Parameters

| Name | In | Required |
|------|-----|----------|
| `institution_id` | path | yes |
| `canvas_term_id` | query | no |

## Result

- **200** `data` includes: `institution_id`, `scanned_courses`, `issues` (total_reported, resolved, still_open), `content_summary` (errors, suggestions, issues_fixed, marked_resolved), `file_pipeline` (totals per tech §4.5), `issue_categories[]` with `category`, `found`, `fixed`, `remaining`
- **Forbidden:** `account_accessibility`, `score_percent`, `impact_scorecard`, grade bands

## Behavior

- **401** / **404** / **403** per TASK-01/02
- `canvas_term_id` restricts which courses contribute to rollups (implementation defines null-term policy)
- All metrics are counts or category breakdowns, not normalized scores

# TASK-04 — Course home dashboard (GET)

## Objective

Implement **GET** course dashboard aggregates: issue totals, file-pipeline counts, high-impact files, issues by file type, and `issue_categories` per tech §4.1 — **no** accessibility scores.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §4.1, §6.7, §0.2–§0.3

## Prerequisites

- TASK-01, TASK-02, TASK-03

## Scope in

- Route: `GET /api/v1/access-hub/institutions/{institution_id}/courses/{canvas_course_id}/dashboard`
- Response `data` shape as tech §4.1 JSON (field names may match exactly or as agreed in OpenAPI)
- `high_impact_files`: product rule for membership (e.g. `open_issues > 0`), sort by `open_issues` descending
- Policy **text** for Home remains from settings endpoint (TASK-06); this task may omit policy from dashboard body unless product wants duplication

## Scope out

- PATCH settings
- Admin institution dashboard (TASK-08)

## Deliverables

- Handler + service aggregation using TASK-03 rollups
- Tests with fixture DB: empty course, course with files and categories

## References

- Functional trace: tech §8 — §3.2 → §4.1

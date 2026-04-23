# TASK-09 — Admin scanned courses list (GET)

## Objective

Implement **GET** paginated list of courses for an institution with per-course scan metrics and counts — **no** enrollment or total students fields.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §4.6

## Prerequisites

- TASK-01, TASK-02, TASK-03

## Scope in

- Route: `GET /api/v1/access-hub/institutions/{institution_id}/courses`
- Query: `canvas_term_id`, `q` (name/code search), `page`, `page_size`
- Per-row: course identity, account/institution echo, `initial_scan_at`, `last_scanned_at`, `counts` object per §4.6
- Derive scan timestamps from `Batch` per tech hints (min/max rules documented in code)

## Scope out

- Enrollment sync
- Score or grade columns

## Deliverables

- Handler + query with pagination
- Tests: search `q`, term filter

## References

- `prisma/schema.prisma` — `Course`, `Batch`

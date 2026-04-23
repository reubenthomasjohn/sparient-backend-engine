# TASK-10 — Admin cross-course files list (GET)

## Objective

Implement **GET** institution-scoped file list with same row shape as course files (TASK-05) plus `canvas_course_id`, `course_name`, `account_name`, and optional filters including `canvas_course_id` and term.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §4.7

## Prerequisites

- TASK-01, TASK-02, TASK-03 (reuse list row mapping from TASK-05)

## Scope in

- Route: `GET /api/v1/access-hub/institutions/{institution_id}/files`
- Query: `canvas_term_id`, `q`, `status`, `hide_replaced_in_canvas`, `page`, `page_size`, optional `canvas_course_id`
- Join `SourceFile` → `Course` → `Institution` for labels; enforce institution boundary

## Scope out

- Mutations

## Deliverables

- Handler + efficient query (indexes on `course_id`, institution filter)
- Tests: term filter, single-course filter

## References

- Functional §3.3.3

# TASK-05 — Course files list (GET)

## Objective

Implement **GET** paginated course file list for Review: search, status filter, hide replaced, sort, row fields including `open_issues`, `review_acknowledged`, pipeline and canvas replacement — **no** `comment` field.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §4.2

## Prerequisites

- TASK-01, TASK-02, TASK-03

## Scope in

- Route: `GET .../courses/{canvas_course_id}/files`
- Query: `q`, `status` (`all|in_progress|complete|failed`), `hide_replaced_in_canvas`, `sort` (e.g. `open_issues_desc`), `page`, `page_size`
- Map filters to TASK-03 derived enums
- `last_updated` from spec (align with “last activity” in functional §3.1.1)
- `review_acknowledged` from `SourceFile.review_acknowledged`

## Scope out

- Admin cross-course list (TASK-10)
- PATCH `review_acknowledged` (future task if required by product)

## Deliverables

- Handler + repository with pagination (`total_items`, `page`)
- Tests for filter and sort combinations

## References

- `prisma/schema.prisma` — `SourceFile.reviewAcknowledged`

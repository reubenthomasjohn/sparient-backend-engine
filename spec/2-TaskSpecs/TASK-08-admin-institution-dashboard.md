# TASK-08 — Admin institution dashboard (GET)

## Objective

Implement **GET** institution-wide dashboard: scanned course count, issue totals, content summary counts, file pipeline counts, and `issue_categories` rollup across scoped courses — **no** account score or score matrix.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §4.5, §6.6, §0.2–§0.3

## Prerequisites

- TASK-01, TASK-02, TASK-03

## Scope in

- Route: `GET /api/v1/access-hub/institutions/{institution_id}/dashboard`
- Query: optional `canvas_term_id` filtering `Course.canvas_term_id`
- Response shape §4.5; aggregation per §6.6 and TASK-03 category rollup at institution scope

## Scope out

- Course-level dashboard (TASK-04)
- New DB columns for summary fields until migrated (tech §0.4) — document zeros or best-effort

## Deliverables

- Handler + aggregation service
- Tests: term filter narrows participating courses

## References

- Functional: §3.3.1

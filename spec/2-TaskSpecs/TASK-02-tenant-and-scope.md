# TASK-02 — Tenant and institution/course scope

## Objective

Enforce that every Access Hub request is authorized for the **institution** in the path and that **course** routes only access courses belonging to that institution.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §5.1, §7.2

## Prerequisites

- TASK-01

## Scope in

- Resolve `institution_id` path segment to an existing `Institution` (or equivalent) where applicable
- For routes with `canvas_course_id`, load `Course` by `(institution_id, canvas_course_id)` and reject mismatch
- Cross-institution or unknown resource: **403** or **404** — pick one policy, document in code and README, apply consistently

## Scope out

- LMS user identity, LTI claims (middleware); signed service keys (TASK-12)
- Business logic for aggregates (TASK-03+)

## Deliverables

- Middleware or service helpers: `assertInstitution`, `getCourseForInstitution`
- Unit/integration tests: wrong `institution_id`, course in another institution → same error policy

## References

- `prisma/schema.prisma` — `Institution`, `Course`, `@@unique([institutionId, canvasCourseId])`

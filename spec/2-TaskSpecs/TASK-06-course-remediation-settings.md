# TASK-06 — Course remediation settings (GET/PATCH)

## Objective

Expose read/update of per-course remediation delivery mode (`opt_in` / `opt_out`) mapped to `Course.writebackOptIn` with effective and institution values per tech §4.3 and §2.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §4.3, §2

## Prerequisites

- TASK-01, TASK-02

## Scope in

- `GET` and `PATCH` `.../courses/{canvas_course_id}/settings`
- PATCH body: `remediation_delivery.mode`
- Persistence: `opt_out` → `writebackOptIn true`; `opt_in` → `false` on **course** row
- Response booleans: `effective_writeback_opt_in`, `course_writeback_opt_in`, `institution_writeback_opt_in` (nullable course override as per schema)

## Scope out

- Institution-level settings (TASK-11)

## Deliverables

- Handlers + validation (Zod or equivalent)
- Tests: toggle mode, effective flag when course override null vs set

## References

- `prisma/schema.prisma` — `Course.writebackOptIn`, `Institution.writebackOptIn`

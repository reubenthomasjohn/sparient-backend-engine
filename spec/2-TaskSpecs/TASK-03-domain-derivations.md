# TASK-03 — Domain derivations (writeback, pipeline, replacement, issue rollups)

## Objective

Implement reusable logic derived from persisted state: effective remediation delivery flag, file **pipeline** label, **canvas replacement** API enum, selection of **latest `BatchFile`** per `SourceFile`, and **`FileIssueCategory`** rollup per tech §0.3.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §2, §3, §0.2–§0.3, §6.1–§6.4
- [docs/FILE_STATUSES.md](../../docs/FILE_STATUSES.md) — predicates for needs upload / batching / in-flight / terminal

## Prerequisites

- TASK-01

## Scope in

- `effective_writeback = Course.writebackOptIn ?? Institution.writebackOptIn` (§2)
- Pipeline label from `SourceFile` timestamps and `last_outcome` (§3, §6.3)
- `canvas_replacement.state` + `writeback_state` exposure rules (§3, §6.4)
- **Latest BatchFile** rule: document one consistent ordering (e.g. `created_at DESC`) for “current remediation snapshot”; use same rule in list and dashboards
- **issue_categories:** per §0.3, sum `found` / `fixed` / `remaining` by `category` across chosen batch files; stable sort (e.g. by category name or `remaining` desc)
- Helpers: `getCourse`, `pipelineLabel`, `canvasReplacementState`, rollup entry points for course vs institution scope

## Scope out

- HTTP handlers (TASK-04+)
- New columns beyond existing Prisma schema (note §0.4 gaps if rollups need them later)

## Deliverables

- Pure functions or service module covered by unit tests (predicate edge cases, empty data)
- Short ADR or code comment documenting **latest BatchFile** choice

## References

- `prisma/schema.prisma` — `SourceFile`, `BatchFile`, `FileIssueCategory`, `WritebackState`, `LastOutcome`

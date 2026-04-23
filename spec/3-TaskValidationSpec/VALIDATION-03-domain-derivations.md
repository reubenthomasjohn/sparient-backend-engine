# VALIDATION-03 — Domain derivations

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.1.1 (pipeline/replacement concepts for file rows), §3.2 (counts and issue breakdowns without scores), §3.1.2 (effective policy / writeback)

## Parameters

| Input | Source |
|-------|--------|
| `SourceFile` row | DB |
| `Institution` / `Course` | DB for `writebackOptIn` |
| Optional `BatchFile` + `FileIssueCategory[]` | DB for latest snapshot |

## Result

- **Effective writeback:** boolean consistent with §2 mapping (`opt_out` ⇔ `true`)
- **Pipeline:** one of `needs_upload | needs_batching | in_flight | terminal | deleted | unknown` per §6.3
- **Canvas replacement:** `pending | replaced | failed | not_applicable` plus nullable `writeback_state` per §3 / §6.4
- **issue_categories:** array of `{ category, found, fixed, remaining }` with non-negative integers; no score fields
- **Open issues** helper (if provided here): consistent with sum of `remaining` or product rule documented in TASK-05/04

## Behavior

- Deleted / missing batch: rollup returns empty category list or zeros per product rule; no throw for empty course
- Same `SourceFile` always maps to same labels given same DB state (deterministic)
- Rollup does not emit `score_percent`, bands, or impact tiers

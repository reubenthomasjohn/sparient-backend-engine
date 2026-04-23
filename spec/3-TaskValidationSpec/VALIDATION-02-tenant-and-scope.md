# VALIDATION-02 — Tenant and scope

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §2.1 (account/institution boundary), §3 intro (course vs admin scope)

## Parameters

| Context | Path / input |
|---------|----------------|
| Institution | `institution_id` (UUID) on all Access Hub routes |
| Course-scoped | `canvas_course_id` plus `institution_id` |

## Result

- Successful resolution yields an internal `course.id` / `institution.id` for downstream queries
- No partial leak of other tenants’ data in error messages

## Behavior

- Unknown `institution_id` (no row) → **404** (or **403** if policy hides existence — must match TASK-02 chosen policy)
- Known institution, unknown course composite → **404** (typical)
- Course row exists but `course.institution_id !== path institution_id` → **403** or **404** per locked policy
- Valid scope → pass to handler

# VALIDATION-06 — Course remediation settings

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.1.2 (read/update remediation delivery; opt in / opt out; display current policy string support)

## Parameters

**GET**

| Name | In | Required |
|------|-----|----------|
| `institution_id` | path | yes |
| `canvas_course_id` | path | yes |

**PATCH** — body JSON:

| Field | Type | Required |
|-------|------|----------|
| `remediation_delivery.mode` | `opt_in \| opt_out` | yes |

## Result

- **200** GET/PATCH: `data.canvas_course_id`, `data.remediation_delivery` with `mode`, `effective_writeback_opt_in`, `course_writeback_opt_in`, `institution_writeback_opt_in`
- `mode === opt_out` iff `effective_writeback_opt_in === true`

## Behavior

- **400** missing/invalid `mode`
- **401** / **404** / **403** per scope
- **409** optional if concurrent update policy added
- After PATCH, persisted `Course.writebackOptIn` matches §2 mapping

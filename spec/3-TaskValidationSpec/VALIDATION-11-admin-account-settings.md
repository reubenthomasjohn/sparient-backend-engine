# VALIDATION-11 — Admin account settings

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.3.4 (GET/UPDATE account-level remediation defaults)

## Parameters

**GET** — path `institution_id` only.

**PATCH** — body:

| Field | Type | Required |
|-------|------|----------|
| `remediation_delivery.mode` | `opt_in \| opt_out` | yes |

## Result

- **200** `data.institution_id`, `data.remediation_delivery.mode`, `data.remediation_delivery.writeback_opt_in`
- Consistency: `mode === opt_out` iff `writeback_opt_in === true`

## Behavior

- **400** invalid body
- **401** / **404** / **403**
- Persisted institution row matches §2 after PATCH

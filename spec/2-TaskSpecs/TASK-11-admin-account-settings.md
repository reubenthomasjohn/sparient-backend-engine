# TASK-11 — Admin account remediation settings (GET/PATCH)

## Objective

Expose institution-level remediation delivery **GET/PATCH** mapping to `Institution.writebackOptIn` per tech §4.8 and §2.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §4.8, §2

## Prerequisites

- TASK-01, TASK-02

## Scope in

- Routes under `/api/v1/access-hub/institutions/{institution_id}/settings`
- PATCH body: `remediation_delivery.mode` → update `Institution.writebackOptIn` (`opt_out` → true, `opt_in` → false)
- Response: `institution_id`, `remediation_delivery.mode`, `writeback_opt_in`

## Scope out

- Course override (TASK-06)

## Deliverables

- Handlers + validation
- Tests: institution default affects effective course policy when course override null

## References

- `prisma/schema.prisma` — `Institution.writebackOptIn`

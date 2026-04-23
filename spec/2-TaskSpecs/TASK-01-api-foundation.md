# TASK-01 — Access Hub API foundation

## Objective

Establish shared HTTP conventions for `/api/v1/access-hub/**`: JSON envelopes, identifier rules, status code catalog, and initial **HTTP Basic** authentication (with `/health` excluded). Encode global payload rules from tech §0.1 so no endpoint returns forbidden constructs.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §1, §0.1, §1.2–§1.5, §7.1 (initial), §7.4–§7.6

## Prerequisites

- none

## Scope in

- Base path prefix `/api/v1/access-hub`
- `Content-Type: application/json` for bodies
- Success envelope `success` + `data`; error envelope aligned with `errorHandler.middleware.ts`
- HTTP status catalog §1.5
- Basic auth on all Access Hub routes; unauthenticated `/health` unchanged
- Global exclusions: do not design responses that include accessibility **scores**, per-file **`comment`** (separate from summaries), or **enrollment** (tech §0.1)
- Optional performance / rate-limit / logging notes from §7.4–7.6 as non-functional guidance for implementers

## Scope out

- Tenant matching (TASK-02), domain derivations (TASK-03), individual route handlers (TASK-04+)
- Signed request verification (TASK-12)

## Deliverables

- Express (or equivalent) router mount for `/api/v1/access-hub`
- Basic auth middleware for that mount
- Shared response helpers and error codes consistent with existing app patterns
- Tests or contract checks for envelope shape and 401 without credentials

## References

- `src/api/middleware/errorHandler.middleware.ts`, `src/utils/errors.ts`
- `src/app.ts` (global rate limit, `/health`)

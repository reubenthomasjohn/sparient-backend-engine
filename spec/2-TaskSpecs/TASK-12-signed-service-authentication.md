# TASK-12 — Signed service request authentication (target)

## Objective

Add optional (or phased) **HMAC-signed** request authentication for `/api/v1/access-hub/**` per tech §5.3, allowing trusted middleware to call the API without Basic; verify canonical string, timestamp skew, and key-to-institution binding.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §5.2–§5.3, §7.1 target

## Prerequisites

- TASK-01 (middleware ordering); layer **with** or **instead of** Basic per product decision
- TASK-02 for **403** when key valid but `institution_id` not allowed for that secret

## Scope in

- Canonical string: method, path (+ query if required), SHA-256 of body, Unix timestamp, optional nonce
- HMAC-SHA256 with per-institution or deployment secret
- Headers: e.g. `X-Signature`, `X-Timestamp`, optional `X-Nonce`
- Reject outside clock skew (e.g. ±5 minutes)
- **401** malformed/missing/wrong signature; **403** institution not allowed for key

## Scope out

- LTI JWT validation inside Sparient (middleware responsibility per §5.2)
- Key rotation UX

## Deliverables

- Auth middleware branch + config for secrets
- Unit tests: skew, tampered body, wrong path, wrong institution

## References

- Tech §5.3

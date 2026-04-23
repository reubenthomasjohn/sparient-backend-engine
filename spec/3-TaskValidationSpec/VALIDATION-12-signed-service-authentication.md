# VALIDATION-12 — Signed service authentication

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §1.3 (initial Basic model); TASK-12 implements tech **target** auth for integration — functional spec may later add explicit “signed request” wording; validation here follows [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md) §5.3.

## Parameters

| Input | Location | Required |
|-------|----------|----------|
| Timestamp | header (e.g. `X-Timestamp`) | yes |
| Signature | header (e.g. `X-Signature`) | yes |
| Nonce | header (optional) | no |
| HTTP method, path, query | request line | yes |
| Body | raw body | as per method |

## Result

- Request **accepted** when HMAC over documented canonical string matches expected value for configured secret scoped to path `institution_id`
- **401** if signature missing, wrong, or timestamp outside allowed window
- **403** if signature valid but institution/key binding fails

## Behavior

- When both Basic and signed auth are enabled: define precedence (e.g. try signature first, then Basic) in implementation docs
- No secret or signature material in logs
- TLS required in non-dev environments (tech §7.1)

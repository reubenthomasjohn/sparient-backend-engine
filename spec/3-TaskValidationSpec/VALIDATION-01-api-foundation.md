# VALIDATION-01 — API foundation

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §4.1 (initial security model: protected endpoints; health behavior implied by app pattern, not Access Hub–specific)

## Parameters

- **Auth:** `Authorization: Basic …` required for any `GET|POST|PATCH` under `/api/v1/access-hub/**`
- **No path/body** for this task’s middleware-only checks (envelope tests may use dummy route)

## Result

- **Success:** JSON body `{ "success": true, "data": … }` for successful handler output
- **Error:** `{ "success": false, "error": { "code", "message", "details?" } }`
- **Forbidden in any Access Hub response design:** `score_percent`, `band`, impact scorecard fields, `comment` (dedicated review-comment field), `total_students` / enrollment fields (tech §0.1)

## Behavior

- Missing/invalid Basic → **401** with error envelope
- `/health` → not blocked by Access Hub Basic middleware (remains app default)
- Malformed JSON on PATCH/POST bodies → **400** when validated by route-level parser (catalog §1.5)
- Rate limit when global limiter applies → **429** per app behavior

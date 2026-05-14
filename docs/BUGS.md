# Open Bugs

Bugs surfaced in recent reviews that are deliberately deferred. Listed in
severity order. Each entry has a recommended fix and the reason we chose to
defer rather than fix now. For pre-existing larger items see also
`docs/KNOWN_ISSUES.md`.

---

## 1. `Number("")` returns 0; empty-string size silently passes the size cap

**Severity:** Low (edge case Canvas almost certainly never produces)

**File:** `src/services/sources/canvas/CanvasSourceClient.ts` — `exceedsSizeCap`. Also `mappers.ts` `toDiscoveredFile` for the `sizeBytes` derivation.

`Number("")` evaluates to `0`. The current guard checks `file.size == null` (covers null/undefined) and `Number.isFinite(sizeNum)` (covers NaN). An empty string passes both: `0 > cap` is `false`, file is included. If Canvas ever serves `size: ""` for a file (highly unlikely — Canvas uses integers or omits the field), we treat it as a 0-byte file. Open-by-default behavior, but silently wrong.

**Fix:** add an explicit empty-string check before `Number()`.
```ts
if (file.size == null || file.size.length === 0) return false;
```

**Why deferred:** Canvas's API has not been observed to return empty-string sizes. The current open-by-default behavior is acceptable on the rare chance it does. Add the guard if we ever see a "0-byte" file in production logs that wasn't actually 0 bytes.

---

## 2. TOCTOU in `CanvasFileReplacer.replaceFile` — double `getFile`

**Severity:** Pre-existing, low for this branch

**File:** `src/services/sources/canvas/CanvasFileReplacer.ts` — `isCanvasFileEligibleToReplace` calls `client.getFile`, then `replaceFile` calls `client.getFile` again on the next line.

A file could be modified or deleted between the eligibility check and the second fetch. The second fetch could throw an uncaught 404, or succeed with different `modified_at` than the eligibility check verified.

**Fix (already implemented in writeback branch):** have `isCanvasFileEligibleToReplace` (or an internal helper) return the fetched `CanvasFile` so `replaceFile` reuses it. See `fetchAndCheckEligibility` pattern from the writeback branch.

**Why deferred:** This branch doesn't currently call `replaceFile` at all (writeback lives elsewhere). The fix is already in the writeback branch and will land when that merges.

---

## 3. `getEffectiveSyncConfig` is called twice per `discoverFiles` invocation

**Severity:** Low (wasteful, not buggy)

**Files:**
- `src/services/sources/canvas/CanvasSourceClient.ts` — constructor
- `src/workers/course/handler.ts` — `discoverFiles` (computes `allowedMimeTypes` for the detector)

Both calls take the same `Institution` row and produce identical results. Two JSON parses, two `syncConfig: resolved` log entries per `discoverFiles` invocation. Confusing for log readers; minor extra work in the hot path.

**Fix:** expose the resolved config from `CanvasSourceClient` (e.g. a `getSyncConfig(): EffectiveSyncConfig` method) and have the handler reuse it. Or only emit the `syncConfig: resolved` log in one place.

**Why deferred:** No correctness risk. Cleanup-when-touching this code.

---

## 4. `PATCH /institutions/:id` with `{ syncConfig: {} }` writes existing config back to itself

**Severity:** Cosmetic

**File:** `src/api/routes/institutions.routes.ts` — PATCH handler.

If the caller sends an empty `syncConfig` object, `Object.entries(data.syncConfig).filter(...)` is `[]`, the merge is just `existingResult.data` unchanged, and the strict re-validate passes. The handler writes the existing config back to the row and emits an `Institution updated` log line for a change that didn't change anything.

**Fix:** short-circuit when `merged` deep-equals `existingResult.data`, or detect `Object.keys(patchEntries).length === 0` and skip the write.

**Why deferred:** No correctness or security impact — the write is idempotent. The audit log is mildly misleading but rare. Deal with this if a frontend bug ever spams empty patches.

---

## Closed/dismissed (kept for traceability)

- **Postman collection's "List files" hardcodes 4 MIME types.** Illustrative-only debug request; not a contract surface. Won't fix unless someone uses it for real verification.
- **`KNOWN_ISSUES.md` M1–M11 / L1–L7.** Pre-existing audit list. Out of scope for the recent feature work.
- **PATCH 500 on `findUnique`→`update` race window.** Acknowledged but dismissed — race window is sub-second on a low-traffic admin endpoint.

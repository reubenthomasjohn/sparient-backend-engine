# TASK-07 — Course file replace (POST)

## Objective

Implement **POST** to trigger remediated file replacement in Canvas workflow: validate `batch_file_id` against course/file ownership and `remediated_s3_key`, return **202** (preferred) or **200** stub.

## Source

- [TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md): §4.4, §6.5

## Prerequisites

- TASK-01, TASK-02, TASK-03

## Scope in

- Route: `POST .../courses/{canvas_course_id}/files/{canvas_file_id}/replace`
- Body: `{ "batch_file_id": "uuid" }`
- Validation chain per §4.4
- Queue or stub job; return `request_id`, `status`, `message` per §4.4

## Scope out

- Actual Canvas upload implementation (may remain stub)
- Bulk replace batching

## Deliverables

- Handler + job enqueue (or no-op stub with stable response)
- Tests: 400 missing remediated key, 404 wrong file/batch, 409 duplicate queue if implemented

## References

- `prisma/schema.prisma` — `BatchFile`, `SourceFile`

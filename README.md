# Sparient Backend Engine

Backend engine for pulling course files from institutional sources (Canvas, SharePoint), sending them for accessibility remediation via Connectivo, and managing the full file lifecycle. Connectivo integration is via S3 (request/response JSON files), not REST APIs.

## Architecture Overview

```
Manual Trigger / EventBridge (daily sweep)
        │
        ▼
  SyncOrchestrator ──► discovery queue
                          │
                          ▼
                   Discovery Lambda (institution-level)
                   ├── Lists Canvas courses, upserts to DB
                   └── Fans out one message per active course
                          │
                          ▼
                   Discovery Lambda (course-level, parallel)
                   ├── Lists Canvas files for one course
                   ├── FileChangeDetector bumps discovered_modified_at
                   ├── Enqueues one UploadJob per new/changed file
                   └── BatchBuilder + RequestPublisher for files already in S3
                          │
                          ▼
                      upload queue
                          │
                          ▼
                    Upload Lambda
                    ├── Re-fetches Canvas file (fresh pre-signed URL)
                    ├── Streams to S3 (content-addressed key: v-:modifiedAtMs)
                    ├── Conditionally UPDATEs s3_source_modified_at (monotonic)
                    └── BatchBuilder + RequestPublisher writes request.json to S3
                          │
                          ▼
           Connectivo polls sparient-remediation-requests bucket,
           processes files, writes remediated PDFs to remediated bucket,
           writes response.json to sparient-remediation-responses bucket
                          │
                          ▼ (S3 event → SQS)
                   Responses Lambda
                   ├── Validates response.json (Zod schema)
                   └── RemediationService writes outcomes to DB, batch → terminal
```

See `docs/ARCHITECTURE.md` for the full deployment diagram, fan-out details, and cost breakdown.

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Docker](https://www.docker.com/) (for local PostgreSQL, or use Neon)
- AWS account with S3 buckets (source, remediated, requests, responses)
- Canvas API token, domain, and account ID

---

## Getting Started

### 1. Clone and install

```bash
git clone <repo-url>
cd sparient-backend-engine
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```bash
# Database — local Docker or Neon connection string
DATABASE_URL=postgresql://sparient:sparient@localhost:5432/sparient

# AWS (optional locally — SDK uses default credential chain)
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-2
S3_SOURCE_BUCKET=your-source-bucket
S3_REMEDIATED_BUCKET=your-remediated-bucket
S3_REQUESTS_BUCKET=sparient-remediation-requests
S3_RESPONSES_BUCKET=sparient-remediation-responses

# Canvas
CANVAS_DOMAIN=your-institution.instructure.com   # no https://
CANVAS_ACCOUNT_ID=1                               # found in Canvas Admin URL
CANVAS_API_TOKEN=your-canvas-api-token

# Optional
INSTITUTION_NAME="University of XYZ"
```

**Getting your Canvas credentials:**
- **API Token**: Canvas → Profile picture → Settings → Approved Integrations → New Access Token
- **Account ID**: Canvas → Admin → Settings → look at the URL: `.../accounts/1`
- **Domain**: your Canvas URL without `https://`, e.g. `myuni.instructure.com`

### 3. Start the database

For local Postgres:
```bash
docker compose up -d
docker compose ps   # State should show "healthy"
```

Or set `DATABASE_URL` to a Neon connection string (the dev deployment uses Neon).

### 4. Run migrations

```bash
npm run db:migrate
```

### 5. Seed the database

Creates the first institution record from your `.env` Canvas credentials.

```bash
npm run db:seed
```

The output will print your `institutionId` — copy it into your Postman collection variables.

### 6. Start the server

```bash
npm run dev
```

Server starts on `http://localhost:3000`. You should see:

```
Database connected
InMemoryQueue(discovery): consumer started
InMemoryQueue(upload): consumer started
Server listening on port 3000
```

---

## Testing with Postman

Import `sparient.postman_collection.json` into Postman and set the collection variables:

| Variable | Where to get it |
|---|---|
| `institutionId` | Output of `npm run db:seed` |
| `canvasDomain` | Your Canvas domain |
| `canvasApiToken` | Your Canvas API token |
| `canvasAccountId` | Your Canvas account ID |

### Recommended test flow

**1. Verify Canvas credentials directly**
```
Canvas API (Direct) → List courses in account
```
Confirms your token and account ID are correct before triggering a sync.

**2. Check available files in a course**
```
Canvas API (Direct) → List files in a course
```
Set `courseId` to a Canvas course ID from step 1. Confirms files exist and MIME types are supported.

**3. Trigger a sync**
```
Sync (Internal) → Trigger single course sync
```
Watch the server logs. You should see: discovery → upload to S3 → batch created → request.json written.

**4. Check batch was created**
```
Batches (Internal) → List batches for institution
```
You should see a batch with `status: pending` and `requestWrittenAt` set.

**5. Verify request.json landed in S3**
```bash
aws s3 ls s3://sparient-remediation-requests/<institutionId>/
```

**6. Simulate Connectivo's response**
Upload a fake response.json to the responses bucket:
```bash
aws s3 cp response.json s3://sparient-remediation-responses/<institutionId>/<courseId>/<batchId>.json
```

**7. Process the response (local dev)**
```
Admin → Process response manually
```
Set `institutionId`, `courseId`, and `batchId` in Postman variables first.

**8. Verify final state**
```
Batches (Internal) → Get batch by ID
```
Should show terminal status (`completed`, `completed_with_warnings`, or `failed`).

---

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run db:migrate` | Run pending database migrations |
| `npm run db:seed` | Seed institution record |
| `npm run db:studio` | Open Prisma Studio (DB browser) at `localhost:5555` |
| `npm run db:reset` | Drop and recreate the database (destructive) |

Scheduling is driven by two columns on `institutions`:

| Column | Default | Purpose |
|---|---|---|
| `sync_enabled` | `true` | Set to `false` to opt an institution out of the nightly sweep |
| `sync_interval_hours` | `24` | How often the sweep re-queues a discovery for this institution |

---

## API Reference

### Internal endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/sync/institutions/:id` | Enqueue institution discovery (fans out per course). `?force=true` rewinds `discovered_modified_at` |
| `POST` | `/api/v1/sync/institutions/:id/courses/:courseId` | Enqueue single-course discovery |
| `DELETE` | `/api/v1/institutions/:id/data` | Wipe all courses/files/batches for the institution |
| `GET` | `/api/v1/batches/:id` | Get batch detail |
| `GET` | `/api/v1/batches/:id/files` | Get files + pinned `s3SourceKey` / `sourceModifiedAt` for a batch |
| `GET` | `/api/v1/batches/institutions/:id` | List batches for an institution |
| `GET` | `/api/v1/batches/stuck` | List pending batches with no response after N hours |
| `POST` | `/api/v1/admin/responses/:instId/:courseId/:batchId` | Manually trigger response processing (reads response.json from S3) |
| `GET` | `/health` | Health check |

---

## Project Structure

```
src/
├── api/
│   ├── middleware/
│   │   └── errorHandler.middleware.ts
│   └── routes/
│       ├── sync.routes.ts
│       ├── batches.routes.ts
│       ├── admin.routes.ts            # Manual response processing
│       └── institutions.routes.ts
├── config/index.ts                    # Zod-validated env config
├── db/client.ts                       # Prisma singleton (pg adapter)
├── queue/
│   ├── IQueue.ts                      # Send / startConsumer / stop
│   ├── InMemoryQueue.ts               # Dev: setInterval poller
│   ├── SqsQueue.ts                    # Prod: SQS long-poll
│   └── index.ts                       # Factory + DiscoveryJob / UploadJob types
├── workers/
│   ├── api/
│   │   └── lambda.ts                  # Express app for API Gateway
│   ├── discovery/
│   │   ├── handler.ts                 # Sweep + institution fan-out + course discover
│   │   └── lambda.ts                  # SQSEvent → handler
│   ├── upload/
│   │   ├── handler.ts                 # Stream Canvas → S3, BatchBuilder
│   │   └── lambda.ts                  # SQSEvent → handler
│   ├── responses/
│   │   ├── handler.ts                 # Read + validate response.json, RemediationService
│   │   └── lambda.ts                  # SQSEvent (S3 event) → handler
│   └── monolith/
│       └── lambda.ts                  # Single-Lambda entry (drains queues inline)
├── services/
│   ├── sources/
│   │   ├── ISourceClient.ts           # Interface for all source systems
│   │   ├── SourceRegistry.ts          # Maps source_type → client
│   │   └── canvas/
│   │       ├── CanvasClient.ts        # Paginated Canvas HTTP client
│   │       └── CanvasFileFetcher.ts   # Implements ISourceClient
│   ├── storage/S3Service.ts           # S3 upload, putJson, getJson
│   ├── sync/
│   │   ├── FileChangeDetector.ts      # Bumps discovered_modified_at, clears outcomes
│   │   ├── BatchBuilder.ts            # Atomic claim + RequestPublisher
│   │   └── SyncOrchestrator.ts        # Enqueues a DiscoveryJob
│   └── remediation/
│       ├── RemediationService.ts      # Writes outcomes from response.json
│       └── RequestPublisher.ts        # Writes request.json to S3
├── types/
│   ├── canvas.ts
│   ├── connectivo.ts                  # Zod schemas + TS types for request/response JSON
│   └── source.ts
├── utils/
│   ├── logger.ts                      # Winston (JSON in prod, readable in dev)
│   ├── errors.ts
│   └── failure.ts                     # Retry-count + exponential backoff helper
├── app.ts
└── server.ts                          # Local dev entry (in-memory queues)
prisma/
├── schema.prisma
├── seed.ts
└── migrations/
prisma.config.ts                       # Prisma 7 datasource config
docker-compose.yml
```

---

## Deployment

AWS deployment uses Neon (Postgres), SQS, 4 Lambdas, API Gateway, and EventBridge. No VPC or NAT. ~$1/mo for dev.

- `docs/ARCHITECTURE.md` — full diagram, component details, fan-out design, cost breakdown.
- `terraform/README.md` — bring-up walkthrough.

CI/CD: push to `main` → GitHub Actions runs Terraform apply → Prisma migrate → builds 4 Docker images → updates 4 Lambdas.

## Adding a New Source (e.g. SharePoint)

1. Create `src/services/sources/sharepoint/SharePointFileFetcher.ts` implementing `ISourceClient`
2. Add `sharepoint` to the `SourceType` enum in `prisma/schema.prisma` and run a migration
3. Register it in `src/services/sources/SourceRegistry.ts`
4. Add the relevant credential fields to the `credentials` JSONB for institutions using SharePoint

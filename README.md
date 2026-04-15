# Sparient Backend Engine

Backend engine for pulling course files from institutional sources (Canvas, SharePoint), sending them for accessibility remediation via Connectivo, and managing the full file lifecycle.

## Architecture Overview

```
Nightly Cron / Manual Trigger
        │
        ▼
  SyncOrchestrator ──► discovery queue
                          │
                          ▼
                   Discovery worker
                   ├── Lists Canvas courses + files
                   ├── FileChangeDetector bumps discovered_modified_at
                   └── Enqueues one UploadJob per new/changed file
                          │
                          ▼
                      upload queue
                          │
                          ▼
                    Upload worker
                    ├── Re-fetches Canvas file (fresh pre-signed URL)
                    ├── Streams to S3 (content-addressed key: v-:modifiedAtMs)
                    ├── Conditionally UPDATEs s3_source_modified_at (monotonic)
                    └── Calls BatchBuilder, which atomically claims files
                          │
                          ▼
  Connectivo polls  GET  /api/v1/connectivo/batches
                    POST /api/v1/connectivo/batches/:id/acknowledge   (idempotent)
                    POST /api/v1/connectivo/batches/:id/results       (idempotent)
                          │
                          ▼
                  RemediationService writes last_outcome;
                  missing files are marked failed → retry job picks them up.
```

Queues are abstracted behind `IQueue`. In dev (no `SQS_*_URL` set) both queues run in-process with a `setInterval` poller. In prod the same handlers run as Lambdas triggered by SQS.

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Docker](https://www.docker.com/) (for local PostgreSQL)
- AWS account with two S3 buckets (source + remediated)
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
# Database — leave as-is for local Docker setup
DATABASE_URL=postgresql://sparient:sparient@localhost:5432/sparient

# AWS
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
S3_SOURCE_BUCKET=your-source-bucket-name
S3_REMEDIATED_BUCKET=your-remediated-bucket-name

# Canvas
CANVAS_DOMAIN=your-institution.instructure.com   # no https://
CANVAS_ACCOUNT_ID=1                               # found in Canvas Admin URL
CANVAS_API_TOKEN=your-canvas-api-token

# Connectivo — generate with: openssl rand -hex 32
CONNECTIVO_API_KEY_SECRET=your-secret-here

# Optional
INSTITUTION_NAME="University of XYZ"

# Queues — leave unset in dev to use the in-memory queue. In prod, set both URLs
# and set QUEUE_START_CONSUMERS=false on the API service (Lambdas consume instead).
# SQS_DISCOVERY_URL=https://sqs.us-east-1.amazonaws.com/…/sparient-discovery
# SQS_UPLOAD_URL=https://sqs.us-east-1.amazonaws.com/…/sparient-upload
# QUEUE_START_CONSUMERS=true
```

**Getting your Canvas credentials:**
- **API Token**: Canvas → Profile picture → Settings → Approved Integrations → New Access Token
- **Account ID**: Canvas → Admin → Settings → look at the URL: `.../accounts/1`
- **Domain**: your Canvas URL without `https://`, e.g. `myuni.instructure.com`

### 3. Start the database

```bash
docker compose up -d
```

Postgres will be available at `localhost:5432`. Wait for the healthcheck to pass before continuing:

```bash
docker compose ps   # State should show "healthy"
```

### 4. Run migrations

```bash
npm run db:migrate
```

When prompted for a migration name, enter `init`.

### 5. Seed the database

Creates the first institution record from your `.env` Canvas credentials and generates a Connectivo API key.

```bash
npm run db:seed
```

The output will print your `institutionId` and `connectivoApiKey` — copy these into your Postman collection variables.

### 6. Start the server

```bash
npm run dev
```

Server starts on `http://localhost:3000`. You should see:

```
Database connected
Server listening on port 3000
Nightly sync job scheduled { schedule: '0 2 * * *' }
Retry job scheduled { schedule: '0 */2 * * *' }
```

---

## Testing with Postman

Import `sparient.postman_collection.json` into Postman and set the collection variables:

| Variable | Where to get it |
|---|---|
| `institutionId` | Output of `npm run db:seed` |
| `connectivoApiKey` | Output of `npm run db:seed` |
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
Sync (Internal) → Trigger full institution sync
```
This runs in the background. Watch the server logs to track progress.

**4. Check batch was created**
```
Batches (Internal) → List batches for institution
```
You should see a batch per course with `status: pending`.

**5. Simulate Connectivo polling**
```
Connectivo (Authenticated) → List pending batches
```
From the response, set the following collection variables from one of the files:
- `batchId` — top-level `batch_id`
- `sourceFileId` — `files[i].file_id` (this is the source_file UUID, *not* the Canvas file id)
- `canvasFileId` — `files[i].canvas_file_id`
- `sourceModifiedAtMs` — parse the `v-<ms>` segment out of `files[i].s3_key` and paste the ms value. Used only to build the sample `remediated_path` in step 7.

**6. Simulate Connectivo acknowledging**
```
Connectivo (Authenticated) → Acknowledge batch
```
Idempotent: re-POSTing the same `connectivo_batch_id` returns 200. A different id on a processing batch returns 409.

**7. Simulate Connectivo submitting results**
```
Connectivo (Authenticated) → Submit batch results
```
`file_id` must be the source_file UUID (`sourceFileId`), not `canvasFileId`. Files missing from the payload are automatically marked failed. Replaying the same `connectivo_batch_id` on a terminal batch is a no-op.

**8. Verify final state**
```
Batches (Internal) → Get files in a batch
```

---

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run db:migrate` | Run pending database migrations |
| `npm run db:seed` | Seed institution + Connectivo API key |
| `npm run db:studio` | Open Prisma Studio (DB browser) at `localhost:5555` |
| `npm run db:reset` | Drop and recreate the database (destructive) |
| `make build-all` | Build all three Lambda Docker images |
| `make push-all` | Push all three images to ECR (run `make ecr-login` first) |

Scheduling is driven by two columns on `institutions`:

| Column | Default | Purpose |
|---|---|---|
| `sync_enabled` | `true` | Set to `false` to opt an institution out of the nightly sweep entirely |
| `sync_interval_hours` | `24` | How often the sweep re-queues a discovery for this institution |

---

## API Reference

### Connectivo endpoints (requires `X-API-Key` header)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/connectivo/batches` | List all pending batches with file details |
| `POST` | `/api/v1/connectivo/batches/:id/acknowledge` | Acknowledge a batch, begin processing |
| `POST` | `/api/v1/connectivo/batches/:id/results` | Submit remediation results |

### Internal endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/sync/institutions/:id` | Enqueue a full institution discovery job (`?force=true` rewinds `discovered_modified_at`) |
| `POST` | `/api/v1/sync/institutions/:id/courses/:courseId` | Enqueue a single-course discovery job |
| `DELETE` | `/api/v1/institutions/:id/data` | Wipe all courses/files/batches for the institution |
| `GET` | `/api/v1/batches/:id` | Get batch detail |
| `GET` | `/api/v1/batches/:id/files` | Get files + pinned `s3SourceKey` / `sourceModifiedAt` for a batch |
| `GET` | `/api/v1/batches/institutions/:id` | List batches for an institution |
| `GET` | `/health` | Health check |

---

## Project Structure

```
src/
├── api/
│   ├── middleware/
│   │   ├── apiKeyAuth.middleware.ts   # SHA-256 key validation
│   │   └── errorHandler.middleware.ts
│   └── routes/
│       ├── connectivo.routes.ts
│       ├── sync.routes.ts
│       └── batches.routes.ts
├── config/index.ts                    # Zod-validated env config
├── db/client.ts                       # Prisma singleton (pg adapter)
├── jobs/
│   └── nightlySync.job.ts             # Local-dev cron: enqueues a sweep at 2 AM
├── queue/
│   ├── IQueue.ts                      # Send / startConsumer / stop
│   ├── InMemoryQueue.ts               # Dev: setInterval poller
│   ├── SqsQueue.ts                    # Prod: SQS long-poll
│   └── index.ts                       # Factory + DiscoveryJob / UploadJob types
├── workers/
│   ├── discovery/
│   │   ├── handler.ts                 # Discovery entry (queue + Lambda share this)
│   │   └── lambda.ts                  # SQSEvent → handler, ReportBatchItemFailures
│   └── upload/
│       ├── handler.ts                 # Upload entry (monotonic UPDATE + BatchBuilder)
│       └── lambda.ts                  # SQSEvent → handler
├── services/
│   ├── sources/
│   │   ├── ISourceClient.ts           # Interface for all source systems
│   │   ├── SourceRegistry.ts          # Maps source_type → client
│   │   └── canvas/
│   │       ├── CanvasClient.ts        # Paginated Canvas HTTP client
│   │       └── CanvasFileFetcher.ts   # Implements ISourceClient
│   ├── storage/S3Service.ts
│   ├── sync/
│   │   ├── FileChangeDetector.ts      # Bumps discovered_modified_at, clears outcomes
│   │   ├── BatchBuilder.ts            # Atomic claim via batched_modified_at
│   │   └── SyncOrchestrator.ts        # Thin wrapper — enqueues a DiscoveryJob
│   └── remediation/RemediationService.ts
├── types/
│   ├── canvas.ts
│   ├── connectivo.ts
│   └── source.ts
├── utils/
│   ├── logger.ts                      # Winston (JSON in prod, readable in dev)
│   ├── errors.ts
│   └── failure.ts                     # Retry-count + exponential backoff helper
├── app.ts
└── server.ts
prisma/
├── schema.prisma
├── seed.ts
└── migrations/
prisma.config.ts                       # Prisma 7 datasource config
docker-compose.yml
```

---

## Adding a New Source (e.g. SharePoint)

1. Create `src/services/sources/sharepoint/SharePointFileFetcher.ts` implementing `ISourceClient`
2. Add `sharepoint` to the `SourceType` enum in `prisma/schema.prisma` and run a migration
3. Register it in `src/services/sources/SourceRegistry.ts`
4. Add the relevant credential fields to the `credentials` JSONB for institutions using SharePoint

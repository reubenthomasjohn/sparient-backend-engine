# Sparient Backend Engine

Backend engine for pulling course files from institutional sources (Canvas, SharePoint), sending them for accessibility remediation via Connectivo, and managing the full file lifecycle.

## Architecture Overview

```
Nightly Cron / Manual Trigger
        │
        ▼
  SyncOrchestrator
  ├── Pulls courses + files from Canvas
  ├── Uploads new/changed files to S3 (source bucket)
  └── Creates a batch per course (status: pending)
        │
        ▼
  Connectivo polls GET /api/v1/connectivo/batches
  ├── Acknowledges each batch
  ├── Processes files, writes remediated files to S3 (remediated bucket)
  └── POSTs results to POST /api/v1/connectivo/batches/:id/results
        │
        ▼
  RemediationService stores results, triggers retries/resubmits
```

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
Copy a `batch_id` from the response and set it as the `batchId` variable.

**6. Simulate Connectivo acknowledging**
```
Connectivo (Authenticated) → Acknowledge batch
```

**7. Simulate Connectivo submitting results**
```
Connectivo (Authenticated) → Submit batch results
```
Update the `file_id` in the request body to match a `sourceFileId` from step 5.

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
| `POST` | `/api/v1/sync/institutions/:id` | Trigger full institution sync |
| `POST` | `/api/v1/sync/institutions/:id/courses/:courseId` | Trigger single course sync |
| `GET` | `/api/v1/batches/:id` | Get batch detail |
| `GET` | `/api/v1/batches/:id/files` | Get files + results for a batch |
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
│   ├── nightlySync.job.ts             # Cron: 2 AM daily
│   └── retry.job.ts                   # Cron: every 2 hours
├── services/
│   ├── sources/
│   │   ├── ISourceClient.ts           # Interface for all source systems
│   │   ├── SourceRegistry.ts          # Maps source_type → client
│   │   └── canvas/
│   │       ├── CanvasClient.ts        # Paginated Canvas HTTP client
│   │       └── CanvasFileFetcher.ts   # Implements ISourceClient
│   ├── storage/S3Service.ts
│   ├── sync/
│   │   ├── FileChangeDetector.ts      # Handles all file change edge cases
│   │   ├── BatchBuilder.ts
│   │   └── SyncOrchestrator.ts
│   ├── remediation/RemediationService.ts
│   └── retry/RetryService.ts
├── types/
│   ├── canvas.ts
│   ├── connectivo.ts
│   └── source.ts
├── utils/
│   ├── logger.ts                      # Winston (JSON in prod, readable in dev)
│   └── errors.ts
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

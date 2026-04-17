# Sparient Backend Engine — Functional Specification

**Document type:** Functional specification (behavior and data needs).  
**Version:** 1.2  
**Date:** 2026-04-15  

This document describes what the **Canvas Access HUB** (Canvas UI) API services must **do** for consumers. It does **not** prescribe routing, database queries, JSON field names, or error codes. Those belong in a technical design or OpenAPI specification.

---

## 1. Purpose and scope

### 1.1 Role of the Sparient Backend Engine

The Sparient Backend Engine is a multi-purpose system that:

- Runs **batch file processing** and **data synchronization** (e.g. discovery, uploads, remediation pipelines).
- Exposes **API services** that read and write data in **PostgreSQL** for UIs; **this specification** covers only the **Canvas**-embedded Access Hub UI.

### 1.2 API surface in scope

| API surface | Primary consumers | Purpose |
|-------------|-------------------|---------|
| **Canvas Access HUB API Services** | Canvas-embedded Access Hub UI (course and admin experiences) | Surface remediation health, file lists, settings, and actions scoped to courses or the institution. |

### 1.3 Initial security model

For the **initial phase**, all relevant endpoints are protected with **HTTP Basic Authentication**. Valid credentials are verified against a **configured secret** (e.g. stored as a hash or token in configuration). Exact storage and rotation are implementation details.

### 1.4 Out of scope for this document

- API consumers or integrations **outside** the Canvas-embedded Access Hub UI (covered only by other documents, if any).
- Concrete URL paths, HTTP verbs per resource, request/response schemas, and status code catalogs.
- Prisma models, migrations, and SQL.
- Non-functional requirements such as rate limits, SLAs, and logging (unless they directly affect a functional rule).

---

## 2. Conceptual model

### 2.1 Identifiers

| Concept | Description |
|---------|-------------|
| **canvas_course_id** | Canvas’s identifier for a course. Primary scope for instructor-facing course pages (Home, Review course files, Remediation settings). |
| **canvas_file_id** | Canvas’s identifier for a file within a course. Used when listing files and when triggering replacement. |
| **remediated_file_id** | Logical identifier for the remediated artifact produced by the remediation pipeline (or stored output) that should replace the Canvas file. Exact semantics are bound to the processing model. |
| **Account / institution** | The institutional or sub-account context used in admin views (e.g. “CSU Fullerton” with an account id). Multi-tenant filtering and authorization are expected at this boundary. |
| **Term** | An academic or Canvas term (e.g. “Default Term”) used to narrow admin lists and aggregates. |

### 2.2 Relationship to existing domain concepts

The engine already reasons about **institutions**, **courses** (including `canvas_course_id`), **source files**, **batches**, and remediation outcomes. This specification uses **business language** aligned with those concepts without requiring this document to mirror the database schema.

### 2.3 Actors

| Actor | Typical use |
|-------|-------------|
| **Course user (e.g. instructor)** | Views course accessibility summary, reviews files, reads or changes course remediation settings, may trigger file replacement when allowed. |
| **Administrator** | Views institution-wide dashboards, scanned courses, cross-course files, and account-level remediation settings. |

---

## 3. Canvas Access HUB API Services

These capabilities support the Access Hub UI embedded in Canvas: course context via **canvas_course_id**, and admin context via **account / institution** (and optional **term**).

---

### 3.1 Course module (course-scoped)

All behaviors below are keyed by **canvas_course_id** unless stated otherwise.

#### 3.1.1 File status and comments (read-only)

**Capability:** Provide a **list of course files** with remediation-related status and **read-only comments**, suitable for a “Review course files” view.

**Inputs (conceptual):**

- Required: **canvas_course_id**.
- Optional filters aligned with the UI:
  - **Search** — free-text match on file or display name.
  - **Status filter** — e.g. **all**, **pending**, **done**, **failed** (exact enum is a product decision; the API must support the same distinctions the UI exposes).
  - **Hide replaced in Canvas** — when true, exclude files that are already replaced in Canvas from the list.

**Outputs (conceptual, per file row):**

- **File identity** — display name and underlying filename as needed for the table.
- **File type / category** — e.g. Image, PDF, Word, Excel, PowerPoint, Video (may be derived from MIME type or extension).
- **Last updated** — reflects last known change relevant to the user (e.g. last sync or last scan/remediation activity), not necessarily Canvas “modified” alone.
- **Status / issues** — summary of the latest scan/remediation outcome (e.g. “no issues detected in the latest scan” or counts/messages as available).
- **Canvas replacement state** — e.g. **pending replacement**, **replaced**, **failed** (labels must align with filters such as pending / done / failed).
- **Comments** — read-only annotations associated with the file where the system stores them.

**Non-goals for this phase:**

- No **create, update, or delete** of comments through this API.

---

#### 3.1.2 Course settings (read and update)

**Capability:** Manage **per-course remediation delivery** settings for a **canvas_course_id**.

**Behavior:**

- **Read:** Return the current settings for the course.
- **Update:** Accept a new configuration and persist it; return the updated settings.

**Functional content (minimum):**

- A **remediation delivery mode** with two mutually exclusive options, consistent with the UI:
  - **Opt in** — remediate documents but **do not** automatically upload or replace files in Canvas.
  - **Opt out** — remediate documents **and** upload/replace in Canvas when the pipeline produces a replacement (subject to other rules).

The API must allow the UI to show the current policy (e.g. “Opt in — remediate without automatic Canvas upload”) and to save changes via a single explicit action (e.g. “Save settings”).

---

#### 3.1.3 File replacement (trigger)

**Capability:** Initiate a **file swap** so that a remediated artifact replaces the Canvas file.

**Inputs (conceptual):**

- **canvas_file_id** — the Canvas file to replace.
- **remediated_file_id** — the remediated artifact to use (or equivalent logical reference).

**Behavior:**

- The endpoint **triggers** the replacement workflow (enqueue job, call internal service, etc.).
- **Actual integration** with Canvas (upload, overwrite, or LTI-driven replace) is a **placeholder** in the initial phase: the contract exists, but the real service call may be stubbed until integrated.

---

### 3.2 Course module (course home / dashboard aggregates)

The **Home** tab for a course shows **aggregate** accessibility information for that **canvas_course_id**. The same service layer should be able to supply:

- **Course accessibility score** (percentage) and a qualitative band (e.g. from “needs attention” to “strong”).
- **Counts:** total files, files scanned, files with open issues, open issues, files remediated, files replaced in Canvas.
- **Issues by file type** — for types such as Image, PDF, Word, Excel, PowerPoint, Video: issue counts and/or score per type.
- **Impact scorecard** — scores (e.g. category scores) for **high**, **medium**, and **low** impact classes of issues.

These may be delivered as one aggregated response or as separate reads; this document only requires that the **data concepts** are available to match the UI.

---

### 3.3 Admin module (institution / account-scoped)

Admin experiences operate above a single course: **institution/account** context, optional **term**, and sometimes **search** or **filter** controls.

#### 3.3.1 Institutional dashboard (high-level health)

**Capability:** Provide **institution-wide** remediation health for the **Dashboard** view.

**Conceptual aggregates** (aligned with the admin UI):

- **Account accessibility score** (percentage) with a visual scale.
- **Total scanned courses** (count).
- **Impact scorecard** — category scores for **high**, **medium**, and **low** impact.
- **Content summary** — e.g. totals for: errors, suggestions, issues fixed, marked resolved (wording may match product copy).
- **Course files summary** — e.g. file issues, total files, files remediated, files marked reviewed.

**Filters (conceptual query inputs):**

- **Institution / account** (e.g. a named account such as “CSU Fullerton”).
- **Term** (e.g. “Default Term”).
- Additional **filter** dimensions as shown in the UI (exact parameters are a product decision).

---

#### 3.3.2 Scanned courses list

**Capability:** Support a **tabular list of courses** with per-course metrics (e.g. “Scanned Courses” tab).

**Per row (conceptual):**

- Course name.
- Total students (or enrollment count as available).
- Account name and identifier.
- **Initial scan** and **last scanned** dates.
- Counts: errors, suggestions, content scanned, content fixed, content resolved, files scanned.

**List controls:**

- **Search** (e.g. “Search courses…”).
- Same **account** and **term** (and general filter) behavior as the dashboard where applicable.
- Actions such as **rescan** or **refresh** are **functional expectations** of the product (batch operations may be separate from read APIs; this document only notes that the UI implies them).

---

#### 3.3.3 Course files (cross-course)

**Capability:** Where the UI provides a **Course Files** tab across the institution, the API must support a **consistent file-oriented list** (columns and filters analogous to the course file review view, but scoped to many courses). Exact columns follow the same principles as **File status and comments** (section 3.1.1), extended with course and account context as needed.

---

#### 3.3.4 Account settings (global remediation defaults)

**Capability:** **GET** and **UPDATE** **account-level** (institution-level) remediation settings — parallel in spirit to **Course settings** (section 3.1.2) but applying to the **whole account/institution** unless overridden by course-level rules (override behavior is a product rule; this document only requires that global defaults exist and are editable).

---

## 4. Cross-cutting requirements

### 4.1 Authentication

- Initial phase: **Basic Authentication** on all endpoints that expose or mutate this data, unless a future revision explicitly carves out public health checks.

### 4.2 Consistency with the UI

- Responses should be sufficient to render: **course Home**, **Review course files**, **Remediation settings**, **Access Hub Admin** (Dashboard, Scanned Courses, Course Files, Remediation Settings) without ad hoc client-side invention of core metrics.

### 4.3 Comments

- **File comments** are **read-only** from the Canvas course API in the initial phase. Persistence and future edit APIs are out of scope here unless product requirements change.

---

## 5. Traceability — UI areas to capabilities

| UI area | Capability sections |
|---------|----------------------|
| Course Home — score, counts, issues by type, impact scorecard | §3.2 |
| Course — Review course files (search, filters, table, Canvas column) | §3.1.1 |
| Course — Remediation settings (opt in / opt out, save) | §3.1.2 |
| Course — Replace / review action leading to swap | §3.1.3 |
| Admin — Dashboard aggregates and filters | §3.3.1 |
| Admin — Scanned Courses table | §3.3.2 |
| Admin — Course Files | §3.3.3 |
| Admin — Remediation Settings (account) | §3.3.4 |

---

## 6. Assumptions

- **PostgreSQL** remains the system of record for data surfaced by these APIs.
- **canvas_course_id**, **canvas_file_id**, and institution/account identifiers are **stable** keys for filtering and display.
- **Exact** score formulas (e.g. how account accessibility score combines errors and suggestions) are **product/analytics** decisions and may be documented separately; this specification requires only that the **concepts** and **aggregates** match what the UI promises.

---

## 7. Revision history

| Version | Date | Summary |
|---------|------|---------|
| 1.2 | 2026-04-15 | Removed remaining references to non-Canvas API surfaces; document is Canvas Access HUB only. |
| 1.1 | 2026-04-15 | Scope limited to Canvas UI APIs only. |
| 1.0 | 2026-04-15 | Initial functional specification for Canvas Access HUB APIs. |

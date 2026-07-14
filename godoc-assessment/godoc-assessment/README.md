# GoDoc Take-Home Assessment - Document Upload & Acknowledgement

A simplified flow where a consultation-related document is uploaded by one
party and acknowledged (or rejected) by a second party.

## Contents

- [Tech stack & why](#tech-stack--why)
- [Architecture](#architecture)
- [State machine](#state-machine)
- [Setup & run](#setup--run)
- [Running tests](#running-tests)
- [API overview](#api-overview)
- [Assumptions](#assumptions)
- [Known limitations & what I'd add next](#known-limitations--what-id-add-next)
- [A note on the committed `.env`](#a-note-on-the-committed-env)

## Tech stack & why

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + Express + TypeScript | Small, well-understood surface area for a scoped assessment; TypeScript catches the kind of state/typo mistakes that matter in a state-machine-heavy flow. |
| Database | SQLite via Node's built-in `node:sqlite` | Zero external services to stand up, single file, and it's built into Node 22+ so `npm install` never touches a native compiler or the network. A traditional choice here would be `better-sqlite3` (native binding) or Postgres; I moved off `better-sqlite3` specifically because it requires downloading prebuilt binaries / building from source, which is a real point of setup friction on a reviewer's machine. For a real production system handling many documents and reviewers, I'd move to Postgres for proper concurrent-write throughput, connection pooling, and easier hosting - noted in "known limitations" below. |
| File storage | Local disk (`multer.diskStorage`) | Simplest thing that works for a take-home; metadata (filename, mime type, size, status) lives in the DB, the file itself lives in `/uploads` referenced by a generated filename (never trusts the original filename for the on-disk path, to avoid path traversal / collisions). In production this would be S3 (or GCS) with the DB storing the object key, so app servers stay stateless. |
| Frontend | React + Vite + TypeScript | Minimal build setup, fast dev loop, and satisfies the "modern JS framework" bonus without pulling in a full Next.js app for what's ultimately three screens' worth of UI. |
| Tests | Jest + Supertest | Standard Node testing stack; Supertest lets me test the real Express app (routing, middleware, validation, status codes) without spinning up a live server. |

## Architecture

```
frontend/        Vite + React SPA. Talks to the API via same-origin
                  fetch("/api/...") - the Vite dev server proxies /api to
                  the Express backend (see frontend/vite.config.ts) so there
                  is no CORS dance in local dev.
src/
  app.ts          Express app wiring (middleware, routes, error handler)
  server.ts       Boots the app on PORT
  db/index.ts     SQLite connection + schema (idempotent CREATE TABLE)
  lib/
    validation.ts Upload validation (mime type allowlist, size limit)
    stateMachine.ts  Pure, declarative transition table for document status
    documents.ts   Data access + the actual transition logic
  routes/
    documents.ts   REST endpoints (upload, list, get, download, acknowledge, reject)
tests/            Unit tests (validation, state machine) + integration
                  tests (full HTTP flow via Supertest)
```

The backend is a single Express process today. The reason it's split into
`lib/validation.ts`, `lib/stateMachine.ts`, and `lib/documents.ts` as
separate, independently-testable modules (rather than one big route
handler) is specifically so it can grow: a new document type, a new
validation rule, or a new terminal state (e.g. `EXPIRED`) is a change in one
module, not a rewrite of the route layer. If this needed to scale past a
single process, the natural next step is extracting `lib/` into a package
that a booking service or a notifications service could also import,
without touching the HTTP layer at all.

## State machine

```
        ACKNOWLEDGE
UPLOADED ─────────────► ACKNOWLEDGED   (terminal)
   │
   └──────────────────► REJECTED       (terminal)
        REJECT
```

- `UPLOADED` is the only state a document starts in and the only state from
  which it can transition.
- `ACKNOWLEDGED` and `REJECTED` are both terminal. I added `REJECTED` beyond
  what's strictly required ("uploaded → acknowledged") because a real
  reviewer needs a way to say "this is the wrong document" - modeling only
  the happy path felt like it'd miss the point of "reason about correctness
  under ... transitions."
- Transitions are defined once, declaratively, in `src/lib/stateMachine.ts`
  (`canTransition` / `nextState`), and the route handlers never set
  `status` directly - they always go through this module. Adding a new
  state later means editing one transition table, not hunting through
  route handlers for every place `status` gets written.
- **Concurrency correctness on transitions**: this option doesn't have the
  same double-booking risk as the booking-system option, but the same
  failure mode exists in miniature - two requests could race to act on the
  same document (double-click, two open tabs, a retried request). I handle
  this with an atomic conditional update: `UPDATE documents SET status = ...
  WHERE id = ? AND status = 'UPLOADED'` (see `applyTransition` in
  `src/lib/documents.ts`). If two acknowledge/reject requests race, exactly
  one `UPDATE` actually changes a row (`changes = 1`); the loser sees
  `changes = 0` and gets a `409 Conflict` instead of silently overwriting
  the winner's decision. This is covered by an integration test that fires
  two concurrent acknowledge requests and asserts exactly one succeeds
  (`tests/documents.integration.test.ts`, "only allows one of two
  concurrent acknowledge requests to succeed").

## Setup & run

**Requirements:** Node.js 22.5+ (uses the built-in `node:sqlite` module).

```bash
# 1. Backend
npm install
npm run build
npm start            # http://localhost:4000

# 2. Frontend (separate terminal)
cd frontend
npm install
npm run dev           # http://localhost:5173, proxies /api to :4000
```

For local iteration, `npm run dev` in the project root runs the backend
with hot reload (`ts-node-dev`) instead of `npm run build && npm start`.

The SQLite schema is created automatically on first run (idempotent
`CREATE TABLE IF NOT EXISTS`, see `src/db/index.ts`). There's also an
explicit `npm run migrate` if you want to create the DB file without
starting the server.

Uploaded files are written to `./uploads` (configurable via `UPLOAD_DIR`
in `.env`).

## Running tests

```bash
npm test
```

17 tests: unit tests for validation rules and the state machine transition
table, plus integration tests that exercise the real Express app end to end
(upload → acknowledge, upload → reject, invalid file type/size, acting on a
document that doesn't exist, and the concurrent-acknowledge race test
described above). Each test file gets its own throwaway SQLite file and
upload directory (`tests/setupEnv.ts`) so tests never interfere with each
other or with `data/dev.db`.

## API overview

| Method | Route | Description |
|---|---|---|
| GET | `/api/health` | Liveness check |
| POST | `/api/documents` | Upload a document. `multipart/form-data`: `file`, `uploaderName`, `intendedRecipient`. Returns `201` + the document, or `400` with `{ errors: string[] }` on validation failure. |
| GET | `/api/documents` | List all documents, most recent first |
| GET | `/api/documents/:id` | Get one document's metadata |
| GET | `/api/documents/:id/download` | Download the original file |
| POST | `/api/documents/:id/acknowledge` | Body: `{ actor: string }`. `200` + updated document, `409` if not currently `UPLOADED`, `404` if not found |
| POST | `/api/documents/:id/reject` | Body: `{ actor: string, reason?: string }`. Same status codes as acknowledge |

## Assumptions

- **No authentication.** Uploader and reviewer identify themselves by
  typing their name into the form (`uploaderName` / `intendedRecipient` /
  `actor`). This is explicitly a shortcut - see limitations below.
- **`intendedRecipient` is informational, not enforced.** Anyone can
  acknowledge or reject any document by typing an actor name; the system
  doesn't check that the actor matches the intended recipient. Enforcing
  that properly requires real auth (see below).
- **Allowed file types**: PDF, PNG, JPEG, DOC, DOCX. Max size 10MB. Both
  configurable via `.env` (`ALLOWED_MIME_TYPES`, `MAX_FILE_SIZE_MB`).
- **One document, one decision.** A document can only be acknowledged or
  rejected once. There's no "re-open" or "re-upload a corrected version"
  flow - a rejected document just sits there rejected. A real product would
  probably want a "superseded by" link to a re-upload.
- **Single reviewer per document.** The schema assumes one
  `intendedRecipient`; it doesn't model multiple people needing to sign off.

## Known limitations & what I'd add next

- **Auth.** This is the biggest one. Right now identity is a free-text
  name, which is fine for demonstrating the state machine and validation
  but would need to be replaced with real sessions/JWT + a `users` table
  before this could go anywhere near production, so that `intendedRecipient`
  can actually be enforced server-side instead of trusted from the client.
- **File storage.** Local disk works for one instance; it does not work if
  this app ever runs on more than one server/container, since the file
  would only exist on whichever instance handled the upload. I'd swap
  `multer.diskStorage` for an S3-compatible object store and store just the
  object key in the DB - the `documents` table and API shape barely change.
- **SQLite → Postgres.** SQLite is genuinely fine for this assessment's
  scope, but a single-file database is a ceiling: no read replicas, limited
  concurrent-write throughput, awkward to run across multiple app
  instances. Because all DB access already goes through
  `src/lib/documents.ts`, swapping the driver is contained to that file and
  `src/db/index.ts` - the routes and the state machine don't know or care
  what database is underneath.
- **No virus/malware scanning on uploads.** For a real healthcare-adjacent
  product handling documents from patients, I'd add a scanning step
  (e.g. ClamAV or a cloud AV API) before a file is considered "uploaded"
  rather than trusting mime-type sniffing alone.
- **No pagination on `GET /api/documents`.** Fine at demo scale, would need
  cursor-based pagination once document volume grows.
- **HRM/notification hooks.** Not built - see the assessment's scope 3 for
  the kind of external-system integration this would eventually need
  (e.g. notifying the intended recipient by email that a document is
  waiting). I left this out to keep the core flow's correctness the focus,
  per the assessment's own guidance to prioritize depth on what's built
  over breadth.

## A note on the committed `.env`

The assessment brief explicitly asks for the environment variable(s) to be
committed to the repository, so `.env` is checked in rather than
git-ignored. In a real codebase I would not do this - `.env` would hold
secrets (DB credentials, API keys) and belong in `.gitignore` with a
`.env.example` committed instead. Here it only holds non-secret local
config (port, file size limit, upload directory, DB path), so committing it
is low-risk, but I wanted to flag that this is a deliberate exception to
normal practice, not an oversight.

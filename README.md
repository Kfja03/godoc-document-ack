# GoDoc Take-Home Assessment - Document Upload & Acknowledgement

A role-based flow where consultants upload consultation-related documents
and approvers acknowledge or reject them, with visibility rules scoped by
who uploaded what and who's allowed to approve.

## Contents

- [Tech stack & why](#tech-stack--why)
- [Architecture](#architecture)
- [Authentication & roles](#authentication--roles)
- [State machine](#state-machine)
- [Setup & run](#setup--run)
- [Running with Docker](#running-with-docker)
- [Running tests](#running-tests)
- [API overview](#api-overview)
- [Assumptions](#assumptions)
- [Known limitations & what I'd add next](#known-limitations--what-id-add-next)
- [A note on the committed `.env`](#a-note-on-the-committed-env)

## Tech stack & why

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + Express + TypeScript | Small, well-understood surface area for a scoped assessment; TypeScript catches the kind of state/typo mistakes that matter in a state-machine-heavy flow with role checks layered on top. |
| Database | SQLite via Node's built-in `node:sqlite` | Zero external services to stand up, single file, and it's built into Node 22+ so `npm install` never touches a native compiler or the network. I moved off `better-sqlite3` (the more typical choice) specifically because it requires downloading prebuilt binaries / building from source, which is a real point of setup friction on a reviewer's machine. For a real production system I'd move to Postgres - noted in "known limitations" below. |
| Auth | `bcryptjs` + `jsonwebtoken`, JWT in an httpOnly cookie | No external auth provider needed for a scoped assessment, but still real password hashing and a real signed session token rather than a trust-the-client name field. httpOnly means the token isn't readable from JS (mitigates XSS token theft); `bcryptjs` is pure JS (same native-build-avoidance reasoning as the SQLite choice above). |
| File storage | Local disk (`multer.diskStorage`) | Simplest thing that works for a take-home; metadata lives in the DB, the file itself lives in `/uploads` referenced by a generated filename (never trusts the original filename for the on-disk path). In production this would be S3/GCS with the DB storing the object key. |
| Frontend | React + Vite + TypeScript | Minimal build setup, fast dev loop, satisfies the "modern JS framework" bonus without the overhead of a full Next.js app for what's a handful of screens. |
| Tests | Jest + Supertest | Supertest drives the real Express app (routing, middleware, auth, validation, status codes) without spinning up a live server, and its `.agent()` persists cookies across requests so multi-step "login, then act" flows are easy to test. |

## Architecture

```
frontend/
  src/App.tsx       Auth-gated shell: shows Login until a session exists,
                     then the workspace (upload panel + document grid)
  src/Login.tsx      Login form + one-click demo account fill-in
  src/api.ts         Typed fetch wrappers, all with credentials: "include"

src/
  app.ts             Express app wiring (middleware, routes, error handler)
  server.ts          Boots the app on PORT; auto-seeds demo users if the
                      users table is empty (so `docker compose up` works
                      with zero extra steps)
  db/
    index.ts          SQLite connection + schema (idempotent CREATE TABLE)
    demoUsers.ts       Shared demo account list (used by seed.ts and the
                        auto-seed-if-empty check in server.ts)
    seed.ts            `npm run seed` - explicit one-off seeding
  lib/
    validation.ts      Upload validation (mime type allowlist, size limit)
    stateMachine.ts     Pure, declarative transition table for document status
    roles.ts            canUpload() / canApprove() - the only place role
                         logic is defined, so it can't drift between routes
    users.ts             User creation, lookup, password hashing/verification
    tokens.ts             JWT sign/verify
    documents.ts           Data access, visibility filtering, transitions
  middleware/
    auth.ts             requireAuth, requireUploadCapability,
                         requireApproveCapability
  routes/
    auth.ts              login, logout, me
    documents.ts           upload, list, get, download, acknowledge, reject
tests/                 Unit tests (validation, state machine) + integration
                       tests (full HTTP flow via Supertest, including auth
                       and role enforcement)
```

The backend is a single Express process. Role logic lives in exactly one
place (`lib/roles.ts`) and visibility logic in exactly one place
(`listDocumentsForUser` / `canUserSeeDocument` in `lib/documents.ts`) -
routes call into these rather than re-implementing the rules, so adding a
fourth role or a fourth visibility case later is a change in one function,
not a hunt through every route handler.

## Authentication & roles

Every user has exactly one role, set at account creation (there's no
self-signup - see "known limitations"):

| Role | Can upload? | Can acknowledge/reject? | Can see |
|---|---|---|---|
| `UPLOAD_ONLY` | Yes | No | Their own documents in any status, **plus** any document from anyone that's been `ACKNOWLEDGED` |
| `APPROVE_ONLY` | No | Yes | Every document, any status, any uploader |
| `UPLOAD_AND_APPROVE` | Yes | Yes | Every document, any status, any uploader |

This is enforced in two independent places, deliberately:

1. **Route-level capability checks** (`requireUploadCapability` /
   `requireApproveCapability` middleware) - a `POST /api/documents` from a
   user without upload capability never even reaches the upload logic; it
   gets a `403` immediately.
2. **Row-level visibility filtering** (`listDocumentsForUser`,
   `canUserSeeDocument`) - this is the part that actually answers "upload
   only should only see their own uploaded files, approved or pending,
   plus every approved file from anyone." It's applied in the SQL query
   for `GET /api/documents` (so the list is correct) *and* independently
   re-checked on `GET /api/documents/:id` and the download route (so
   guessing a document's UUID doesn't bypass the list-level filtering -
   both return `404`, not `403`, for a document you're not allowed to know
   exists).

Sessions are a JWT stored in an httpOnly cookie (`godoc_session`), issued on
login and verified on every request via the `requireAuth` middleware. The
frontend never touches the token directly - it just calls `/api/auth/me` on
load to figure out whether there's a valid session.

**Demo accounts** (password for all: `password123`), auto-seeded on first
boot (or run `npm run seed` explicitly):

| Email | Role |
|---|---|
| `alice@godoc.test` | Upload only |
| `dana@godoc.test` | Upload only |
| `bob@godoc.test` | Approve only |
| `carol@godoc.test` | Upload & approve |

The login screen has one-click buttons to fill these in, since a reviewer
will likely want to try more than one role.

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
  reviewer needs a way to say "this is the wrong document."
- Transitions are defined once, declaratively, in `src/lib/stateMachine.ts`
  (`canTransition` / `nextState`); route handlers never set `status`
  directly.
- **Who can act, and who they're recorded as**: the actor is always the
  authenticated session user (`req.user.id`), never a client-supplied
  name - `acknowledged_by_id` / `rejected_by_id` are foreign keys to
  `users`, and the API joins in the name for display. This closes a gap in
  an earlier version of this project where "who acted" was just a free-text
  field the client could set to anything.
- **Concurrency correctness on transitions**: two requests could race to
  act on the same document (double-click, two open tabs, a retried
  request). This is handled with an atomic conditional update:
  `UPDATE documents SET status = ... WHERE id = ? AND status = 'UPLOADED'`
  (see `applyTransition` in `src/lib/documents.ts`). If two
  acknowledge/reject requests race, exactly one `UPDATE` actually changes a
  row; the loser sees `changes = 0` and gets a `409 Conflict` instead of
  silently overwriting the winner's decision. Covered by an integration
  test that fires two concurrent acknowledge requests from two different
  approvers and asserts exactly one succeeds.

## Setup & run

**Requirements:** Node.js 22.5+ (uses the built-in `node:sqlite` module).

```bash
# 1. Backend
npm install
npm run build
npm run seed         # creates the demo accounts (optional - the server
                      # auto-seeds on first boot if the users table is empty)
npm start             # http://localhost:4000

# 2. Frontend (separate terminal)
cd frontend
npm install
npm run dev            # http://localhost:5173, proxies /api to :4000
```

For local iteration, `npm run dev` in the project root runs the backend
with hot reload (`ts-node-dev`) instead of `npm run build && npm start`.

The SQLite schema is created automatically on first run (idempotent
`CREATE TABLE IF NOT EXISTS`, see `src/db/index.ts`).

Uploaded files are written to `./uploads` (configurable via `UPLOAD_DIR` in
`.env`).

## Running with Docker

```bash
docker compose up --build
```

- Backend: http://localhost:4000 - auto-seeds the demo accounts above on
  first boot, no extra step needed. SQLite + uploads persist in named
  volumes (`backend_data` / `backend_uploads`) across restarts/rebuilds -
  use `docker compose down -v` to wipe them and start fresh.
- Frontend: http://localhost:8080 - nginx serves the built static app and
  proxies `/api/*` to the backend container (see `frontend/nginx.conf`),
  so the session cookie stays same-origin from the browser's perspective.

Each service has its own multi-stage Dockerfile: a build stage compiles
TypeScript / runs the Vite build, and the runtime stage only ships the
compiled output plus production dependencies.

## Running tests

```bash
npm test
```

24 tests: unit tests for validation rules and the state machine transition
table, plus integration tests covering auth (login success/failure, `/me`,
logout), capability enforcement (upload-only blocked from
acknowledging/rejecting with `403`, approve-only blocked from uploading),
document visibility per role (including that a hidden document 404s even
when fetched directly by ID, not just filtered out of the list), search and
status filtering, the full upload → acknowledge/reject lifecycle, and the
concurrent-acknowledge race test. Each test file gets its own throwaway
SQLite file and upload directory (`tests/setupEnv.ts`), and every test
within `documents.integration.test.ts` clears the `documents`/`users`
tables in `beforeEach` so tests can assert exact visible-document lists
without leaking state between cases.

## API overview

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | none | Liveness check |
| POST | `/api/auth/login` | none | Body: `{ email, password }`. Sets the session cookie, returns `{ user }`. `401` on bad credentials. |
| POST | `/api/auth/logout` | session | Clears the session cookie |
| GET | `/api/auth/me` | session | Returns `{ user }` for the current session, `401` if not logged in |
| POST | `/api/documents` | session + upload capability | `multipart/form-data`: `file`. Uploader is taken from the session, not the request body. `403` without upload capability, `400` on invalid file. |
| GET | `/api/documents?status=&search=` | session | Documents visible to the caller (see visibility rules above); optional status filter and filename search, both applied server-side |
| GET | `/api/documents/:id` | session | `404` if the document doesn't exist *or* isn't visible to the caller - the two are indistinguishable on purpose |
| GET | `/api/documents/:id/download` | session | Same visibility check as above |
| POST | `/api/documents/:id/acknowledge` | session + approve capability | `200` + updated document, `409` if not currently `UPLOADED`, `403` without approve capability |
| POST | `/api/documents/:id/
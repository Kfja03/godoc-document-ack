# GoDoc Take-Home Assessment - Document Upload & Acknowledgement

A role-based flow where consultants upload consultation-related documents
and approvers acknowledge or reject them, with visibility rules scoped by
who uploaded what and who's allowed to approve.

## Contents

- [Tech stack & why](#tech-stack--why)
- [Architecture](#architecture)
- [Authentication & roles](#authentication--roles)
- [State machine](#state-machine)
- [Editing, deletion & retention](#editing-deletion--retention)
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
    roles.ts            canUpload() / canApprove() / canManage() - the only
                         place role logic is defined, so it can't drift
                         between routes
    users.ts             User creation, lookup, password hashing/verification
    tokens.ts             JWT sign/verify
    documents.ts           Data access, visibility filtering, transitions,
                            file replacement, permanent delete
    retention.ts            Finds + purges expired REJECTED documents
  middleware/
    auth.ts             requireAuth, requireUploadCapability,
                         requireApproveCapability, requireManageCapability
  routes/
    auth.ts              login, logout, me
    documents.ts           upload, list, get, download, acknowledge, reject,
                            edit (PATCH), delete (DELETE)
tests/                 Unit tests (validation, state machine, retention) +
                       integration tests (full HTTP flow via Supertest,
                       including auth, role enforcement, and manage actions)
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

| Role | Can upload? | Can acknowledge/reject? | Can edit/delete *any* document? | Can see |
|---|---|---|---|---|
| `UPLOAD_ONLY` | Yes | No | No | Their own documents in any status, **plus** any document from anyone that's been `ACKNOWLEDGED` |
| `APPROVE_ONLY` | No | Yes | No | Every document, any status, any uploader |
| `UPLOAD_AND_APPROVE` ("lead") | Yes | Yes | Yes | Every document, any status, any uploader |

This is enforced in two independent places, deliberately:

1. **Route-level capability checks** (`requireUploadCapability` /
   `requireApproveCapability` / `requireManageCapability` middleware) - a
   `POST /api/documents` from a user without upload capability never even
   reaches the upload logic; it gets a `403` immediately.
2. **Row-level visibility filtering** (`listDocumentsForUser`,
   `canUserSeeDocument`) - this is the part that actually answers "upload
   only should only see their own uploaded files, approved or pending,
   plus every approved file from anyone." It's applied in the SQL query
   for `GET /api/documents` (so the list is correct) *and* independently
   re-checked on `GET /api/documents/:id` and the download route (so
   guessing a document's UUID doesn't bypass the list-level filtering -
   both return `404`, not `403`, for a document you're not allowed to know
   exists).

**Edit/delete is deliberately narrower than approve.** `canManage()` only
returns true for `UPLOAD_AND_APPROVE`, not for `APPROVE_ONLY` - an approver
can accept or reject a document, but correcting someone else's mistake (or
permanently removing a document) is a bigger action than a review decision,
so it's scoped to the "lead" role specifically rather than piggybacking on
approve capability.

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

## Editing, deletion & retention

Two lead-only ("`UPLOAD_AND_APPROVE`") actions sit alongside the state
machine rather than inside it:

- **Edit (`PATCH /api/documents/:id`)** replaces the file on an existing
  document - upload a new file, keep the same document record. Because the
  content changed, any prior acknowledge/reject decision is no longer
  meaningful, so this **resets the document to `UPLOADED`** and clears the
  acknowledged/rejected fields (`replaceDocumentFile` in
  `src/lib/documents.ts`). A corrected document goes back into the review
  queue rather than staying "approved" against a file nobody actually
  reviewed. The old file is deleted from disk once the DB points at the new
  one.
- **Delete (`DELETE /api/documents/:id`)** permanently removes the document
  row and its file. This is a **hard delete** - there's no trash/undo. See
  "known limitations" for the audit-trail trade-off that comes with that.

Both require `canManage()` (lead only, not `APPROVE_ONLY`) and both work on
any document regardless of uploader or status - a lead can fix or remove
anyone's document, not just their own.

**Retention: rejected documents auto-delete after 30 days.**
`src/lib/retention.ts` exports `purgeExpiredRejectedDocuments`, a pure
function (DB query + file cleanup, no HTTP involved) that finds every
`REJECTED` document whose `rejected_at` is older than the retention window
and deletes both the row and the file. `src/server.ts` runs it once at
boot and then every 6 hours via `setInterval`. The window is configurable
via `REJECTED_RETENTION_DAYS` in `.env` (default 30).

This is a deliberately naive scheduler, not a real job queue - worth being
upfront about the trade-off: it only runs while this one process is alive,
doesn't coordinate across multiple instances (each would run its own
redundant sweep if this were ever scaled horizontally), and a missed window
because the process was down just means expired documents live a bit
longer rather than anything breaking. A production version would move this
to a proper cron trigger or queue worker calling the same
`purgeExpiredRejectedDocuments` function - it's already decoupled from
Express specifically so that swap doesn't touch the retention logic itself.
The frontend shows a "days until auto-delete" hint on rejected document
cards (`RETENTION_DAYS` in `frontend/src/App.tsx`), computed client-side
from `rejected_at` - it assumes the default 30-day window rather than
reading it from the API, so it'd need to be passed down from `GET
/api/documents` if the retention window is ever made per-deployment
configurable in a way the frontend needs to reflect exactly.

## Setup & run

**Requirements:** Node.js 22.5+ (uses the built-in `node:sqlite` module).

```bash
# 1. Backend
npm install
npm run build
npm run seed         # creates the demo accounts (optional - the server

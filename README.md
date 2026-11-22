# Task Master API

A REST backend for team task tracking: accounts, teams with invitations, tasks with assignment, filtering, search and sorting, comments, file attachments, real-time notifications over Server-Sent Events, and AI-written task descriptions and summaries.

**Stack:** Node.js 20+, Express 5, PostgreSQL through Prisma, Redis, S3-compatible object storage, JWT auth with bcrypt, zod validation, pino logging, Anthropic SDK.

## Getting started

```bash
npm install
cp .env.example .env          # set JWT_SECRET; ANTHROPIC_API_KEY is optional
npm run deps:up               # Postgres, Redis and MinIO in containers
npx prisma migrate deploy
npm run dev                   # http://localhost:3000
```

Tests run against a separate `taskmaster_test` database, using the settings in `.env.test`:

```bash
npm run deps:up
PGPASSWORD=taskmaster psql -h localhost -p 55432 -U taskmaster -c 'CREATE DATABASE taskmaster_test'   # once
npm test
```

To run the whole thing as it would run in production (two API replicas behind nginx, sharing Postgres, Redis and MinIO):

```bash
docker compose up -d --build   # API on http://localhost:8080
```

## Scaling

The API servers keep no state of their own, so you scale by running more of them behind a load balancer. Anything that has to be shared lives in a backing service:

| Concern | Where it lives | Why |
|---|---|---|
| Data | PostgreSQL | Indexed for the hot queries (a user's tasks, a team's tasks, sorted by due or created date, unread notifications). Search uses `pg_trgm` GIN indexes, so `?q=` doesn't scan the whole table |
| Sessions | JWT, nothing stored | Any instance can check any token. Logged-out tokens are a primary-key lookup in Postgres |
| Live notifications | Redis pub/sub | Each instance delivers to the streams it holds. A notification raised on instance A reaches a user streaming from instance B |
| Missed notifications | Postgres plus `Last-Event-ID` | When an instance goes away, the browser reconnects to another one and gets whatever it missed in between |
| Rate limits | Redis | Counters are shared, so 3 instances don't mean 3 times the limit |
| Attachments | S3 / MinIO / R2 | Uploads stream straight to storage (never buffered whole in memory). Downloads redirect to a short-lived signed URL, so file bytes never pass through the API |

Other things in place:

- **Cursor pagination.** `GET /tasks` and `GET /notifications` return a `nextCursor`. Paging with it stays fast however deep you go, and new rows don't shift pages or show up twice, unlike `OFFSET`. Page numbers still work for small lists.
- **Health checks.** `/health` is liveness. `/ready` checks Postgres, Redis and storage, and returns 503 while the instance shuts down, so the load balancer takes it out of rotation.
- **Graceful shutdown.** On SIGTERM the instance stops being ready, closes its SSE streams so clients move elsewhere, lets in-flight requests finish (forced after 10s), then exits.
- **Tracing.** Every response has an `X-Request-Id`, reused from the load balancer when it sends one, and the JSON logs carry it plus the instance id. Tokens are redacted from logs.

Sizing notes:

- **Database connections.** Each instance opens a pool (Prisma's default is CPU count times 2 plus 1). Set `?connection_limit=N` on `DATABASE_URL` so that instances times N stays under Postgres's `max_connections`. With many instances, put PgBouncer in front and add `&pgbouncer=true`.
- **SSE connections** are long-lived. Each costs memory but almost no CPU. Make the load balancer's idle timeout longer than the 25-second heartbeat.
- **Without Redis** (`REDIS_URL` empty) the app runs as a single instance: rate limits and live delivery stay inside the process. Fine for development, wrong for more than one replica. The server logs a warning at startup.
- **In docker compose**, nginx looks up the replicas' addresses once at startup. If you recreate the API containers, recreate `lb` too. A real platform load balancer (Kubernetes Service, ALB, etc.) handles this for you.

## Design notes

- **Auth.** Passwords are hashed with bcrypt (12 rounds by default). Login returns a JWT that carries a unique id (`jti`). Logout stores that id in a revocation table, so a logged-out token stops working right away instead of living until it expires. Changing the password revokes the current token too. Login and register are rate limited, and a failed login takes the same time whether or not the email exists.
- **Access.** Every task belongs to a team or is personal. Team tasks are visible to all team members; personal tasks only to their creator. Anyone who can see a task can update it, comment on it and attach files. Only the creator or a team owner/admin can delete it. Assignees must belong to the task's team. Requests for teams or tasks you cannot see return 404, not 403, so ids can't be probed.
- **Team roles.** `OWNER` (one per team; can delete it and change roles), `ADMIN` (can invite and remove members), `MEMBER`. Removing a member unassigns their tasks in that team.
- **Notifications** are stored in the database and also pushed live over SSE to connected clients. You get one when a task is assigned to you, when a task you created or are assigned to is updated, commented on or gets an attachment, and for team invitations. You never get a notification for your own actions.
- **Attachments** are stored under random keys (never the client filename) and capped at `MAX_UPLOAD_MB`.
- **AI** endpoints call Claude (`claude-opus-5-5` by default, with server-side refusal fallback on). They return suggested text and save nothing; the client decides whether to use it. Without `ANTHROPIC_API_KEY` they answer `503`.

## API

Base path `/api/v1`. Send `Authorization: Bearer <token>` on everything except register and login. Bodies are JSON unless noted.

Errors look like `{ "error": { "message": "...", "details": [{ "path": "email", "message": "..." }] } }`. Status codes: `400` validation, `401` not logged in, `403` not allowed, `404` not found or not visible, `409` conflict, `413` file too large, `429` rate limited, `503` AI not configured.

### Auth and profile

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `email, password, name` | Password: 8 to 72 chars, at least one letter and one number. Returns `{ token, user }` |
| POST | `/auth/login` | `email, password` | Returns `{ token, user }` |
| POST | `/auth/logout` | | Revokes the token |
| GET | `/users/me` | | Your profile |
| PATCH | `/users/me` | `name?, bio?, avatarUrl?` | |
| PUT | `/users/me/password` | `currentPassword, newPassword` | Logs you out; log in again |

### Teams and invitations

| Method | Path | Body | Who |
|---|---|---|---|
| POST | `/teams` | `name, description?` | Anyone; you become owner |
| GET | `/teams` | | Teams you belong to |
| GET | `/teams/:teamId` | | Members, with roles |
| PATCH | `/teams/:teamId` | `name?, description?` | Owner/admin |
| DELETE | `/teams/:teamId` | | Owner |
| POST | `/teams/:teamId/invitations` | `email` | Owner/admin. Works for emails not registered yet |
| GET | `/teams/:teamId/invitations` | | Owner/admin |
| PATCH | `/teams/:teamId/members/:userId` | `role: ADMIN or MEMBER` | Owner |
| DELETE | `/teams/:teamId/members/:userId` | | Owner/admin, or yourself to leave |
| GET | `/invitations` | | Your pending invitations |
| POST | `/invitations/:id/accept` | | Joins the team |
| POST | `/invitations/:id/decline` | | |

### Tasks

| Method | Path | Body |
|---|---|---|
| POST | `/tasks` | `title, description?, status?, priority?, dueDate?, teamId?, assigneeId?` |
| GET | `/tasks` | Query parameters below |
| GET | `/tasks/:taskId` | |
| PATCH | `/tasks/:taskId` | Any of `title, description, status, priority, dueDate, assigneeId` |
| DELETE | `/tasks/:taskId` | Creator or team owner/admin |

`status` is `OPEN`, `IN_PROGRESS` or `COMPLETED`. Setting `COMPLETED` records `completedAt`. `priority` is `LOW`, `MEDIUM` or `HIGH`. Set `assigneeId: null` to unassign.

Query parameters for `GET /tasks`:

| Param | Example | Meaning |
|---|---|---|
| `status` | `open,in_progress` | One or more statuses, case-insensitive |
| `priority` | `high` | One or more priorities |
| `assignee` | `me`, `unassigned`, a user id | |
| `createdBy` | `me` or a user id | |
| `teamId` | | Only this team's tasks |
| `q` | `report` | Searches title and description |
| `dueBefore`, `dueAfter` | `2030-01-31` | |
| `overdue` | `true` | Past due and not completed |
| `sort` | `-dueDate` | `createdAt`, `updatedAt`, `dueDate`, `priority`, `title`, `status`; a leading `-` sorts descending. Default `-createdAt`. Tasks with no due date sort last |
| `limit` | `50` | Default 20, up to 100 |
| `cursor` | | The `nextCursor` from the previous page. Recommended for large lists |
| `page` | `2` | Page number, if not using a cursor. Default 1 |

With page numbers the response is `{ data, pagination: { page, limit, total, totalPages, nextCursor } }`. With a cursor it's `{ data, pagination: { limit, nextCursor } }`, with no total, since counting is the slow part on big tables. `nextCursor` is `null` on the last page. A cursor only works with the `sort` it came from. "My tasks" is `GET /tasks?assignee=me`.

### Comments and attachments

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/tasks/:taskId/comments` | | Oldest first |
| POST | `/tasks/:taskId/comments` | `body` | |
| PATCH | `/tasks/:taskId/comments/:commentId` | `body` | Author only |
| DELETE | `/tasks/:taskId/comments/:commentId` | | Author or team owner/admin |
| GET | `/tasks/:taskId/attachments` | | |
| POST | `/tasks/:taskId/attachments` | multipart, field `file` | |
| GET | `/tasks/:taskId/attachments/:id/download` | | With S3 storage, a 302 to a signed URL valid for `S3_DOWNLOAD_URL_TTL` seconds |
| DELETE | `/tasks/:taskId/attachments/:id` | | Uploader, task creator, or team owner/admin |

### Notifications

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?unread=true&limit=50&cursor=` | Newest first. Returns `{ data, unreadCount, pagination: { limit, nextCursor } }` |
| PATCH | `/notifications/:id/read` | |
| POST | `/notifications/read-all` | |
| GET | `/notifications/stream` | SSE stream |

Browsers' `EventSource` can't send headers, so the stream also accepts the token as a query parameter:

```js
const events = new EventSource(`/api/v1/notifications/stream?access_token=${token}`);
events.addEventListener('notification', (e) => console.log(JSON.parse(e.data)));
```

Event types: `connected` once on open, then `notification` with `{ id, type, message, data, read, createdAt }`. `type` is `TASK_ASSIGNED`, `TASK_UPDATED`, `TASK_COMMENTED` or `TEAM_INVITATION`.

Each event carries an SSE `id`. When the connection drops, `EventSource` reconnects on its own and sends `Last-Event-ID`, and the server replays what was missed (up to 100). A notification can occasionally arrive twice around a reconnect, so ignore ids you have already seen.

### AI

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/ai/task-description` | `title, notes?` | `{ description }`: a goal sentence plus acceptance criteria |
| POST | `/ai/tasks/:taskId/summary` | | `{ summary }`: status, progress and blockers taken from the comments |

Limited to 10 requests a minute per user.

## Example

```bash
B=http://localhost:3000/api/v1   # or :8080 for the docker compose stack
TOKEN=$(curl -s -X POST $B/auth/register -H 'content-type: application/json' \
  -d '{"email":"sam@example.com","password":"secret123","name":"Sam"}' | jq -r .token)
TEAM=$(curl -s -X POST $B/teams -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Platform"}' | jq -r .id)
curl -s -X POST $B/tasks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"title\":\"Rotate API keys\",\"teamId\":\"$TEAM\",\"dueDate\":\"2030-02-01\",\"priority\":\"HIGH\"}"
curl -s "$B/tasks?assignee=unassigned&sort=dueDate" -H "authorization: Bearer $TOKEN"
```

## Project layout

```
prisma/                   schema and migrations
src/app.js                Express app, health and readiness checks
src/server.js             startup and graceful shutdown
src/routes/               auth, users, teams, invitations, tasks, comments, attachments, notifications, ai
src/services/             access rules, tokens, notification hub (Redis fan-out), Claude calls
src/storage/              local disk and S3 drivers
src/middleware/           auth, validation, rate limiting, error handling
docker-compose.yml        Postgres, Redis, MinIO, two API replicas, nginx
tests/                    end-to-end API tests (node:test + supertest)
```

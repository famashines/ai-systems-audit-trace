# Changelog

## Unreleased

- `budget.ReservationExpired` is an audit entry: it books money with no
  owner action.
- `GET /internal/audit` reads with a cursor (batches of 10) and stops at
  the first entry that passes the 960 KiB page limit or at `limit`. It
  does not load `limit + 1` documents first.
- The role test also tries `$merge` and `$out` into `audit` and a rename
  of `processed` onto `audit` with `dropTarget`. Each fails with code 13.
- The CI job `gitops-init` fails when `test/integration/mongodb-init.js`
  is not the same as gitops `kubernetes/ai-systems/ai-systems-mongodb/base/init.js`
  on `main`. It runs only on a push to `main`, because `GITOPS_TOKEN` can
  write to gitops and must not be in a pull request run. It uses `cmp`
  and prints no file content. `CLAUDE.md` has the same check by hand.
- Unit tests for the exact byte fit of a page: an entry that fills the
  page to the limit is kept, and at one byte less it starts the next
  page.
- The rename test is a separate test. Its name says that it checks only
  the outcome.

- New service (M3-06). Five durable consumers named `audit-trace`, on
  `ORCHESTRATION`, `CONVERSATION`, `BUDGET`, `AGENTS` and `PROMPTS`, with
  the full stream filters of the gitops grants. Contracts v0.4.1, kit
  v0.3.0.
- An event is an audit entry when its actor is the owner or its type is a
  system decision (`README.md`, "Audit entries"). The entry is the source
  event and `recordedAt`, in the collection `audit`.
- Insert-only: the service writes `audit` only with `insertOne`. The
  gitops role `auditTrace` allows `find` and `insert` on `audit`, not
  `update` or `remove`. An integration test runs the gitops `init.js` on
  a MongoDB with auth and shows that update, replace, delete, drop and an
  index change by the service user fail with code 13.
- Once for each source event: the unique `eventId` index of gitops. A
  duplicate key is "already recorded" and the message is acked. The
  service stops at start when the index is missing.
- One OpenTelemetry span `audit <event type>` for each handled event, with
  `ai_systems.correlation_id`, the event id and type, and whether it was
  an entry and a new insert.
- `GET /internal/audit?limit=<n>&before=<id>`: pages of the log, newest
  first, at most 100 items and 960 KiB, with `next`. The handler checks
  the owner bearer token first, as budget does.
- CI, release workflow, Dockerfile and Renovate from prompt-studio.

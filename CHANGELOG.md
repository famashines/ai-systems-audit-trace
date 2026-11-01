# Changelog

## Unreleased

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

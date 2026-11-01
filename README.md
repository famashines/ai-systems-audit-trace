# ai-systems-audit-trace

The Audit and Trace service of ai-systems (ADR 0005, ADR 0021). It reads
the events of the other contexts from NATS JetStream and keeps an
insert-only audit log in MongoDB: who did what and when (PRD G5, LIVE-5,
OBS-2, ARCHITECTURE 11.1 "Repudiation"). It emits no events. The service
is internal and has no Ingress.

```
NATS ORCHESTRATION (orchestration.>) --durable audit-trace--+
NATS CONVERSATION  (conversation.>)  --durable audit-trace--+
NATS BUDGET        (budget.>)        --durable audit-trace--+--> audit-trace
NATS AGENTS        (agents.>)        --durable audit-trace--+      | one span for each event
NATS PROMPTS       (prompts.>)       --durable audit-trace--+      | insertOne (entries only)
                                                                   v
                                             MongoDB audit_trace.audit (insert and find only)
owner --api-gateway (not yet)--GET /internal/audit--> audit-trace
```

Architecture and reasons: `ai-systems-docs` (`ARCHITECTURE.md` 5 to 7 and
11, ADR 0008, 0018, 0021, 0023). Schemas: `@famashines/ai-systems-contracts`
v0.4.1. An audit entry is not a contract shape in M3. The entry is the
source event, so the actor of each owner command event is the owner
(contracts `README.md`, "Owner commands").

## Audit entries

An event is an audit entry when one of these is true:

- its `actor.kind` is `owner`. Each owner command gives an event with the
  owner as actor, so every owner action is in the log, also a new one.
- its type is a system decision in `systemDecisions`
  (`src/domain/audit.ts`), whatever the actor:

| Stream          | System decisions                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORCHESTRATION` | `TaskSubmitted`, `MessageRefused`, `ClarificationRequested`, `ClarificationAnswered`, `PlanProposed`, `PlanEdited`, `PlanApproved`, `PlanRejected`, `TaskModeChanged`, `TaskCancelled`, `RunStarted`, `CheckpointOpened`, `CheckpointResolved`, `SteeringMessageAdded`, `SubtaskReassigned`, `SubtaskRetrying`, `SubtaskFailed`, `SubtaskBlocked`, `RunPaused`, `RunResumed`, `RunBlocked`, `RunCompleted`, `RunFailed`, `RunCancelled` |
| `CONVERSATION`  | `ConversationStarted`, `OwnerMessagePosted`                                                                                                                                                                                                                                                                                                                                                                                             |
| `BUDGET`        | `BudgetSet`, `ReservationRefused`, `ThresholdCrossed`                                                                                                                                                                                                                                                                                                                                                                                   |
| `AGENTS`        | all: `AgentCreated`, `AgentVersionPublished`, `AgentVersionActivated`, `AgentEnabled`, `AgentDisabled`                                                                                                                                                                                                                                                                                                                                  |
| `PROMPTS`       | all: `PromptCreated`, `PromptVersionPublished`                                                                                                                                                                                                                                                                                                                                                                                          |

Not entries, unless the actor is the owner (for example `SubtaskQueued`
after `RetrySubtask`): the call and scheduling steps
`orchestration.CallRequested`, `CallSettled`, `CallCancelRequested`,
`SubtaskQueued`, `SubtaskWaiting`, `SubtaskStarted`, `SubtaskCompleted`;
`conversation.AgentReplyPosted` (a copy of an orchestration event); the
ledger steps `budget.FundsReserved`, `ReservationSettled`,
`ReservationExpired`. They are trace data (M6), not decisions.

The service does not read `LLM`. The gitops grants allow it, for M6.

A unit test fails when a contracts upgrade adds an event type to one of the
five streams that is not in one of the two lists. So each new type needs a
decision.

The NATS grants pin the filter of each durable consumer to the full stream
(`orchestration.>` and so on), so the service reads all events of a stream
and selects the entries in code. An event that is not an entry is acked
with no write.

## An entry

The document in `audit` is the source event (`eventId`, `type`,
`schemaVersion`, `streamId`, `version`, `occurredAt`, `correlationId`,
`causationId`, `actor`, `payload`) and `recordedAt` (BSON date, the clock
of the service). `_id` is a MongoDB ObjectId. The payload is kept in full,
because it holds the "what" (plan version, cap, reason). Prompt and output
text can be in it (`TaskSubmitted`, `OwnerMessagePosted`, `PlanProposed`).
ADR 0018 puts that text in audit-trace and keeps it out of the logs. The
logs and spans of this service have ids and types only.

## Insert-only role

The MongoDB user `audit_trace` has the custom role `auditTrace` on the
database `audit_trace`. gitops makes it in
`kubernetes/ai-systems/ai-systems-mongodb/base/init.js` (the
`mongodb-init` Job, as `root`):

| Collection                         | Actions                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit`                            | `find`, `insert`, `listIndexes`, `collStats`, `killCursors`                                                                                     |
| `spans`, `processed`, `migrations` | `find`, `insert`, `update`, `remove`, `createIndex`, `dropIndex`, `listIndexes`, `createCollection`, `collStats`, `killCursors`, `changeStream` |
| the database                       | `listCollections`, `dbStats`                                                                                                                    |

The Job also makes the collection `audit` with the unique index
`{ eventId: 1 }` and the index `{ correlationId: 1, occurredAt: 1 }`. The
service cannot make an index on `audit`. At start it reads the indexes of
`audit` and stops with an error when the unique `eventId` index is not
there (the Job did not run).

The service user cannot update, replace or delete an entry, drop
`audit`, or make or drop an index on it. MongoDB refuses with code 13
(`Unauthorized`). The integration test runs the gitops `init.js` (a copy
in `test/integration/mongodb-init.js`) on a MongoDB with `--auth` and a
key file, and tries each of these writes with the service user. The role
needs no change in gitops for M3.

## Once for each source event

The unique index on `eventId` makes the rule. A redelivery, a second copy
of a message, or a replay of a stream gives a duplicate key error
(11000), and the service takes it as "already recorded" and acks. The
service does not write `processed`: the kit consumer only reads it, and
the unique index is enough. One insert is one write, so there is no
transaction.

## Spans

Each handled event, entry or not, has one span `audit <event type>`
(OpenTelemetry API, the provider of `kit/observability`). Its parent is
the `traceparent` header of the message (kit consumer). Attributes:

| Attribute                   | Value                                      |
| --------------------------- | ------------------------------------------ |
| `ai_systems.correlation_id` | `correlationId` of the event (the task id) |
| `ai_systems.event_id`       | `eventId`                                  |
| `ai_systems.event_type`     | `type`                                     |
| `ai_systems.audit.entry`    | `true` when the event is an audit entry    |
| `ai_systems.audit.inserted` | `false` when the entry was already there   |

A failed insert sets the span status to error with the error class. The
spans go out over OTLP only when `OTEL_EXPORTER_OTLP_ENDPOINT` or
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set (ADR 0018, until Tempo in
P9b).

## API

| Method | Path                                    | Content                                                                       |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/internal/audit?limit=<n>&before=<id>` | One page of the audit log, newest first. Needs an owner bearer token.         |
| GET    | `/health`                               | Liveness: 200 while the process runs                                          |
| GET    | `/ready`                                | Readiness: `mongo`, `nats`, and `consumer-<STREAM>` for each of the 5 streams |
| GET    | `/metrics`                              | Prometheus metrics                                                            |

### `GET /internal/audit`

The handler checks `Authorization: Bearer <access token>` first, with
`bearerHook` of `kit/auth` (role `owner`, issuer `OIDC_ISSUER`, audience
`OIDC_AUDIENCE`), as budget does. Then it reads the query.

| Query    | Default | Rule                                                            |
| -------- | ------- | --------------------------------------------------------------- |
| `limit`  | `50`    | integer, 1 to 100                                               |
| `before` | none    | the `id` of an entry (24 lower-case hex); entries older than it |

```json
{
  "items": [
    {
      "id": "6720f1a2c3d4e5f6a7b8c9d0",
      "eventId": "…",
      "type": "orchestration.PlanApproved",
      "schemaVersion": 1,
      "streamId": "task-…",
      "version": 4,
      "occurredAt": "2026-11-01T10:00:00.000Z",
      "correlationId": "…",
      "causationId": "…",
      "actor": { "kind": "owner", "id": "<sub>" },
      "payload": { "taskId": "…", "planVersion": 1 },
      "recordedAt": "2026-11-01T10:00:00.120Z"
    }
  ],
  "next": "6720f1a2c3d4e5f6a7b8c9cf"
}
```

The order is `_id` descending: the order in which the service recorded
the entries. `next` is the `before` value of the next page, or `null` when
no older entry is there. A page is limited to 960 KiB of JSON, because
api-gateway reads at most 1 MiB from an upstream, so a page can have fewer
items than `limit`. A page always has at least one item when an older
entry is there. Use `next`, not `items.length < limit`, as the end rule.

| Status | When                                                | Body                               |
| ------ | --------------------------------------------------- | ---------------------------------- |
| 200    | A page                                              | `{ items, next }`                  |
| 400    | `limit` or `before` is not valid                    | Problem JSON, `code` `validation`  |
| 401    | No token, or a token that is not valid              | Problem JSON                       |
| 403    | No `owner` role                                     | Problem JSON                       |
| 503    | MongoDB does not answer, or Keycloak cannot be read | Problem JSON, `code` `unavailable` |

## Configuration

Environment variables (`.env.example` has all of them):

| Variable                                                            | Default                                         | Content                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `MONGODB_URI`                                                       | required                                        | `mongodb://audit_trace:<password>@<host>/audit_trace?replicaSet=rs0` |
| `MONGODB_DATABASE`                                                  | `audit_trace`                                   | Database name                                                        |
| `NATS_SERVERS`                                                      | required                                        | NATS URLs, comma-separated; at least one                             |
| `NATS_USER`                                                         | required                                        | `ai-systems-audit-trace` on the cluster                              |
| `NATS_PASSWORD`                                                     | required                                        | From the SealedSecret                                                |
| `OIDC_ISSUER`                                                       | `https://auth.famashines.com/realms/ai-systems` | Keycloak realm                                                       |
| `OIDC_JWKS_URL`                                                     | `<issuer>/protocol/openid-connect/certs`        | JWKS inside the cluster                                              |
| `OIDC_AUDIENCE`                                                     | `ai-systems-app`                                | Audience and `azp` of the token                                      |
| `PORT`                                                              | `8080`                                          | HTTP port                                                            |
| `LOG_LEVEL`                                                         | `info`                                          | pino level                                                           |
| `RELEASE`                                                           | `local`                                         | Release id in logs, metrics and spans                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | not set                                         | Traces go over OTLP only when one is set                             |

The database of the path in `MONGODB_URI` is the auth source. The user
`audit_trace` is in the database `audit_trace`, not in `admin`. gitops has
the SealedSecrets `mongodb-audit-trace` (`MONGODB_URI`,
`MONGODB_PASSWORD`) and `ai-systems-audit-trace-nats` (`NATS_USER`,
`NATS_PASSWORD`).

The kit service name is `audit-trace`. So the inbox prefix is
`_INBOX_audit-trace`, the durable consumer of each stream is
`audit-trace`, and the DLQ subject is `dlq.audit-trace.<subject>`. The
gitops user `ai-systems-audit-trace` has all the grants that the service
needs (ADR 0023): for each of the five streams
`$JS.API.STREAM.INFO.<STREAM>`,
`$JS.API.CONSUMER.CREATE.<STREAM>.audit-trace.<filter>`,
`$JS.API.CONSUMER.INFO.<STREAM>.audit-trace`,
`$JS.API.CONSUMER.MSG.NEXT.<STREAM>.audit-trace`,
`$JS.ACK.<STREAM>.audit-trace.>`; and `$JS.API.INFO`,
`dlq.audit-trace.>`, subscribe `_INBOX_audit-trace.>`. No grant change is
needed.

At start the service connects to MongoDB, checks the `audit` indexes,
connects to NATS, starts the five consumers, and listens. It runs no
migration. The service does not make streams: the gitops stream Job makes
them. While a stream is missing, its consumer tries again and the
readiness check `consumer-<STREAM>` is false.

## Known limits

- The page order is the record order (`_id`), not `occurredAt`. A
  consumer that is behind records an older event later. The entry has
  `occurredAt` for the real time. A page by `occurredAt` needs an index
  `{ occurredAt: -1, _id: -1 }` in gitops `init.js`, because the service
  cannot make an index on `audit`.
- With two or more pods, ObjectIds of the same second from two pods are
  not in record order. One replica is the plan (ARCHITECTURE 13).
- An event type that the contracts version of the service does not know
  fails the zod check and goes to the DLQ after the kit retries. Upgrade
  the contracts, then replay the DLQ (runbook).
- The log keeps entries for ever. SET-3 (delete all data, keep only the
  fact of the delete) needs an admin step, because the service user
  cannot delete. That is M9 work.
- The JWKS comes over plain HTTP inside the cluster (ARCHITECTURE 11.1,
  accepted).

## Not done

- The `spans` collection (the full trace of each run, with the call
  bodies from ai-proxy) is M6-02. In M3 the spans are OpenTelemetry spans
  only.
- The api-gateway route for the audit log. It must forward the
  `Authorization` header of the owner.
- The gitops app: `kubernetes/ai-systems/ai-systems-audit-trace/base`
  (Deployment, Service, NetworkPolicy, ServiceMonitor) and `prod`
  (`kustomization.yaml`). The NetworkPolicy needs egress to MongoDB, NATS
  and Keycloak (port 8080, JWKS), and ingress from api-gateway when the
  route is there.

## Run locally

Node 26 (`nvm use`), and a MongoDB replica set where the gitops `init.js`
ran, and NATS with JetStream and the five streams. `docker compose up` in
`kit` makes both.

```sh
npm ci
cp .env.example .env
node --env-file=.env src/main.ts
```

In `.env`, fill in the required values and delete the lines that you do
not set.

## Container image

```sh
docker build --build-arg RELEASE=$(git rev-parse HEAD) -t ai-systems-audit-trace .
```

Node 26 slim, pinned by digest, with no npm, no npx and no test packages.
The entrypoint is `node src/main.ts` as uid 1000. It writes nothing to
disk, so a read-only root file system works.

Release: when `ci` passes on a push to `main`, `.github/workflows/release.yml`
builds and scans the image, pushes
`ghcr.io/famashines/ai-systems-audit-trace:sha-<commit>`, and opens or
updates the pull request from the branch
`release/ai-systems-audit-trace-prod` in `famashines/gitops`. That step
needs the org secret `GITOPS_TOKEN` with access to this repo, and the
gitops folder `kubernetes/ai-systems/ai-systems-audit-trace/prod` with a
`kustomization.yaml`. The folder is not there yet.

## Test

| Command                    | Does                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `npm run verify`           | type check, lint, unit tests with the coverage gates               |
| `npm run test:integration` | MongoDB with auth and the gitops role, and NATS, in Testcontainers |

Commands for agents: `CLAUDE.md`.

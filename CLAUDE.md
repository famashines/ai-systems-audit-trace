# CLAUDE.md for ai-systems-audit-trace

Rules for all ai-systems repos: `ai-systems-docs/CLAUDE.md`
(local: `../../docs/CLAUDE.md`). What the service does: `README.md`.

## Commands

| Command                    | Does                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `npm ci`                   | install from the lock file (builds kit and contracts on install) |
| `npm run check`            | `tsc --noEmit` (TypeScript 7)                                    |
| `npm run lint`             | ESLint (strict type-checked) and Prettier check                  |
| `npm test`                 | unit tests, two coverage gates (see below)                       |
| `npm run verify`           | check, lint and test                                             |
| `npm run test:integration` | `test/integration` with Testcontainers (needs Docker)            |
| `npm start`                | `node src/main.ts`                                               |

## Layout

```
src
├── domain/audit.ts            which events are entries, the entry, the page byte limit; no I/O
├── application/audit.ts       the recorder (span and insert), the index check, the page read
├── adapters/http.ts           GET /internal/audit, the owner token check, the query schema
└── main.ts                    config, the five consumers, wiring by constructor, start, shutdown
test
├── unit                       node:test, fake collections, an in-memory span exporter
└── integration                MongoDB with auth and the gitops role, NATS, in Testcontainers
```

## Rules

- Never add an update, a delete or an index change on `audit`. The
  MongoDB role refuses them (code 13), and the integration test proves it.
- Once for each source event comes from the unique `eventId` index, which
  gitops makes. Do not add a `processed` write or a transaction for it.
- A contracts upgrade that adds an event type to a read stream breaks the
  unit test `each event type of a read stream ...`. Put the type in
  `systemDecisions` or in `notEntries` of the test, and change the table
  in `README.md`.

## Coverage gates (ADR 0017)

`npm test` runs the unit tests two times, because node:test thresholds are
for all included files together:

- `test:domain`: `src/domain`, 90% lines and 85% branches.
- `test:unit`: `src` without `main.ts`, 70% lines.

`main.ts` is wiring. The integration test covers it through `start()`.

## Integration tests

- `test/integration/mongodb-init.js` is a copy of the gitops file
  `kubernetes/ai-systems/ai-systems-mongodb/base/init.js` (same content
  as gitops `origin/main` `aaba642`). The test runs it in a MongoDB with
  `--auth` and a key file, as gitops and the kit compose file do. Change
  the copy together with gitops. ESLint and Prettier skip it.
- CI does not compare the copy with gitops: `famashines/gitops` is
  private, and the `GITHUB_TOKEN` of this repo cannot read it. Do this
  check by hand before each PR that touches MongoDB, and after each gitops
  change of `init.js`. No output means the same content:

  ```sh
  gh api repos/famashines/gitops/contents/kubernetes/ai-systems/ai-systems-mongodb/base/init.js \
    -H "Accept: application/vnd.github.raw" | diff - test/integration/mongodb-init.js
  ```

- The NATS config in the test has the grants of the user
  `ai-systems-audit-trace` and `ai-systems-admin` from gitops
  (`kubernetes/infrastructure/nats/values.yaml`). Change them together
  with gitops.
- The test publishes a message two times with no `Nats-Msg-Id`, so
  JetStream does not drop the copy and the unique index does the work.
- Wait with `waitFor`, never with a fixed sleep. Pass `drainDelayMs: 0` to
  `start()`.
- The CI job `integration` runs on `ubuntu-22.04`: `mongo:8.0.34` does not
  start on the kernel of `ubuntu-24.04`. See the kit `CLAUDE.md`.
- `Collection.dropIndexes()` of the driver returns `false` on an error and
  does not throw. Use `dropIndex(name)` in a test that expects a refusal.

## Dependencies

- Kit and contracts come from git tags. A new tag needs a new
  `allowScripts` entry with the commit of the tag
  (`npm install-scripts approve <package>`).
- Kit v0.3.0 asks for contracts v0.1.0, but npm installs one copy, v0.4.1
  (`npm ls @famashines/ai-systems-contracts`).
- `mongodb`, `zod` and `@opentelemetry/api` have the exact versions that
  the kit pins, so there is one copy of each. A second copy of
  `@opentelemetry/api` gives a no-op tracer and no spans. Check with
  `npm ls zod mongodb @opentelemetry/api`.
- `@opentelemetry/sdk-trace` (dev) is the in-memory span exporter of the
  unit tests. It has the version that `@opentelemetry/sdk-node` of the kit
  uses.
- TypeScript 6 (`typescript`, for ESLint) and 7 (`typescript-7`, for
  `check`): ADR 0022. Never run `npx tsc`.
- The Docker build stage uses the full Node image, because npm needs `git`
  to install the kit and contracts. The runtime stage is slim.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { MongoClient, MongoServerError, type Db } from "mongodb";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { loadConfig } from "@famashines/ai-systems-kit/config";
import { connectNats, type Nats } from "@famashines/ai-systems-kit/messaging";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import {
  createStreams,
  mongoImage,
  startNats,
  waitFor,
  type Started,
} from "@famashines/ai-systems-kit/testing";
import type { AuditPage } from "../../src/application/audit.ts";
import { envSchema, start } from "../../src/main.ts";

const auditTraceGrants = [
  "dlq.audit-trace.>",
  "$JS.API.INFO",
  ...["ORCHESTRATION", "CONVERSATION", "LLM", "BUDGET", "AGENTS", "PROMPTS"].flatMap((stream) => [
    `$JS.API.STREAM.INFO.${stream}`,
    `$JS.API.CONSUMER.CREATE.${stream}.audit-trace.${stream.toLowerCase()}.>`,
    `$JS.API.CONSUMER.INFO.${stream}.audit-trace`,
    `$JS.API.CONSUMER.MSG.NEXT.${stream}.audit-trace`,
    `$JS.ACK.${stream}.audit-trace.>`,
  ]),
];

const adminGrants = [
  "$JS.API.>",
  "$JS.ACK.>",
  "orchestration.>",
  "conversation.>",
  "llm.>",
  "budget.>",
  "agents.>",
  "prompts.>",
  "dlq.>",
];

const list = (subjects: string[]): string => subjects.map((s) => `"${s}"`).join(", ");

const natsConfig = `
jetstream { store_dir: /data }
accounts {
  AISYSTEMS {
    jetstream { max_file: 1073741824, max_memory: 0 }
    users = [
      {
        user: ai-systems-admin, password: admin
        permissions {
          publish { allow: [${list(adminGrants)}] }
          subscribe { allow: ["_INBOX_admin.>"] }
        }
      }
      {
        user: ai-systems-audit-trace, password: audit-trace
        permissions {
          publish { allow: [${list(auditTraceGrants)}] }
          subscribe { allow: ["_INBOX_audit-trace.>"] }
        }
      }
    ]
  }
}
`;

const streamSpecs = [
  { name: "ORCHESTRATION", subjects: ["orchestration.>"] },
  { name: "CONVERSATION", subjects: ["conversation.>"] },
  { name: "LLM", subjects: ["llm.>"] },
  { name: "BUDGET", subjects: ["budget.>"] },
  { name: "AGENTS", subjects: ["agents.>"] },
  { name: "PROMPTS", subjects: ["prompts.>"] },
  { name: "DLQ", subjects: ["dlq.>"] },
];

const mongoUsers = [
  "ORCHESTRATION",
  "PROJECTIONS",
  "CONVERSATION_HUB",
  "AI_PROXY",
  "BUDGET",
  "AGENT_MANAGER",
  "PROMPT_STUDIO",
  "NOTIFICATION",
  "AUDIT_TRACE",
];

async function startAuthMongo(): Promise<StartedTestContainer> {
  const container = await new GenericContainer(mongoImage)
    .withUser("999:999")
    .withEntrypoint([
      "bash",
      "-c",
      "head -c 756 /dev/urandom | base64 -w0 > /tmp/keyfile && chmod 400 /tmp/keyfile && exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /tmp/keyfile --bind_ip_all",
    ])
    .withEnvironment({
      HOME: "/tmp",
      MONGO_INITDB_ROOT_USERNAME: "root",
      MONGO_INITDB_ROOT_PASSWORD: "root",
    })
    .withCopyContentToContainer([
      {
        content: await readFile(new URL("mongodb-init.js", import.meta.url), "utf8"),
        target: "/init/init.js",
      },
    ])
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/, 2))
    .start();
  const result = await container.exec(["mongosh", "--nodb", "--quiet", "--norc", "/init/init.js"], {
    env: {
      HOME: "/tmp",
      MONGODB_HOST: "localhost:27017",
      ROOT_PASSWORD: "root",
      ...Object.fromEntries(mongoUsers.map((name) => [`${name}_PASSWORD`, name.toLowerCase()])),
    },
  });
  if (result.exitCode !== 0) throw new Error(`init.js failed: ${result.output}`);
  return container;
}

const logger = createLogger({ service: "test", release: "test", level: "silent" });
const issuer = "https://auth.example.test/realms/ai-systems";
let mongoContainer: StartedTestContainer;
let natsContainer: Started;
let root: MongoClient;
let rootDb: Db;
let service: MongoClient;
let serviceDb: Db;
let admin: Nats;
let js: JetStreamClient;
let jwks: Server;
let privateKey: CryptoKey;
let running: Awaited<ReturnType<typeof start>> | undefined;
let base = "";

const token = () =>
  new SignJWT({ typ: "Bearer", azp: "ai-systems-app", realm_access: { roles: ["owner"] } })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience("ai-systems-app")
    .setSubject("owner-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

before(async () => {
  [mongoContainer, natsContainer] = await Promise.all([
    startAuthMongo(),
    startNats({ config: natsConfig }),
  ]);
  const address = `${mongoContainer.getHost()}:${String(mongoContainer.getMappedPort(27017))}`;
  const serviceUri = `mongodb://audit_trace:audit_trace@${address}/audit_trace?directConnection=true`;
  root = await MongoClient.connect(`mongodb://root:root@${address}/?directConnection=true`);
  rootDb = root.db("audit_trace");
  service = await MongoClient.connect(serviceUri);
  serviceDb = service.db("audit_trace");
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  admin = await connectNats({
    servers: natsContainer.url,
    user: "ai-systems-admin",
    pass: "admin",
    service: "admin",
    logger,
  });
  js = jetstream(admin.connection);
  await createStreams(admin.connection, streamSpecs);
  const config = loadConfig(envSchema, {
    MONGODB_URI: serviceUri,
    NATS_SERVERS: natsContainer.url,
    NATS_USER: "ai-systems-audit-trace",
    NATS_PASSWORD: "audit-trace",
    OIDC_ISSUER: issuer,
    OIDC_JWKS_URL: `http://127.0.0.1:${String((jwks.address() as AddressInfo).port)}/certs`,
    LOG_LEVEL: "silent",
  });
  running = await start({ ...config, PORT: 0 }, { drainDelayMs: 0 });
  base = `http://127.0.0.1:${String(running.address.port)}`;
  await waitFor(async () => (await fetch(`${base}/ready`)).ok);
});

after(async () => {
  if (running) assert.equal(await running.app.close(), true);
  await admin.close();
  await service.close();
  await root.close();
  await new Promise((resolve) => jwks.close(resolve));
  await Promise.all([mongoContainer.stop(), natsContainer.stop()]);
});

const taskId = randomUUID();
const runId = randomUUID();
const owner = { kind: "owner", id: "owner-1" } as const;
const system = { kind: "system", id: "seed" } as const;

const envelope = (
  type: string,
  streamId: string,
  payload: object,
  actor: { kind: string; id: string } = owner,
) => ({
  eventId: randomUUID(),
  type,
  schemaVersion: 1,
  streamId,
  version: 1,
  occurredAt: new Date().toISOString(),
  correlationId: taskId,
  causationId: randomUUID(),
  actor,
  payload,
});

type Envelope = ReturnType<typeof envelope>;

const publish = async (event: Envelope): Promise<void> => {
  await js.publish(event.type, JSON.stringify(event));
};

const audit = () => rootDb.collection<{ eventId: string }>("audit");
const recorded = async (eventId: string): Promise<boolean> =>
  (await audit().countDocuments({ eventId })) > 0;

const published: Envelope[] = [];

test("each named consumer records the audit entries of its stream, once per source event", async () => {
  const paused = envelope("orchestration.RunPaused", `task-${taskId}`, { taskId, runId });
  const queued = envelope(
    "orchestration.SubtaskQueued",
    `task-${taskId}`,
    { taskId, runId, subtaskId: randomUUID() },
    system,
  );
  const resumed = envelope("orchestration.RunResumed", `task-${taskId}`, { taskId, runId });
  const others = [
    envelope("conversation.ConversationStarted", `conversation-${randomUUID()}`, {
      conversationId: randomUUID(),
    }),
    envelope("budget.BudgetSet", "budget-cap-month", {
      scope: { kind: "month" },
      hardCapMicroUsd: 5_000_000,
    }),
    envelope("agents.AgentEnabled", `agent-${randomUUID()}`, { agentId: randomUUID() }),
    envelope(
      "prompts.PromptCreated",
      `prompt-${randomUUID()}`,
      { promptId: randomUUID(), name: "writer" },
      system,
    ),
  ];
  for (const event of [paused, paused, queued, resumed, ...others]) await publish(event);
  await waitFor(async () =>
    (await Promise.all([resumed, ...others].map((event) => recorded(event.eventId)))).every(
      Boolean,
    ),
  );
  assert.equal(await audit().countDocuments({ eventId: paused.eventId }), 1);
  assert.equal(await recorded(queued.eventId), false);
  assert.equal(await audit().countDocuments(), 6);
  const entry = await rootDb.collection("audit").findOne({ eventId: paused.eventId });
  assert.deepEqual(entry?.actor, owner);
  assert.equal(entry.correlationId, taskId);
  assert.ok(entry.recordedAt instanceof Date);
  published.push(paused, resumed, ...others);
});

test("GET /internal/audit pages all entries, newest first, for the owner only", async () => {
  assert.equal((await fetch(`${base}/internal/audit`)).status, 401);
  const authorization = `Bearer ${await token()}`;
  const seen: string[] = [];
  let next: string | null = null;
  let pages = 0;
  do {
    const query: string = next === null ? "?limit=2" : `?limit=2&before=${next}`;
    const response = await fetch(`${base}/internal/audit${query}`, {
      headers: { authorization },
    });
    assert.equal(response.status, 200);
    const page = (await response.json()) as AuditPage;
    assert.ok(page.items.length <= 2);
    seen.push(...page.items.map((item) => item.eventId));
    next = page.next;
    pages += 1;
  } while (next !== null);
  assert.equal(pages, 3);
  const all = await audit().find().sort({ _id: -1 }).toArray();
  assert.deepEqual(
    seen,
    all.map((doc) => doc.eventId),
  );
  assert.deepEqual(new Set(seen), new Set(published.map((event) => event.eventId)));
});

const unauthorized = async (work: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof MongoServerError);
    assert.equal(error.code, 13);
    return true;
  });
};

test("the audit-trace MongoDB user can insert and find in audit, but not change or delete", async () => {
  const entries = serviceDb.collection<{ eventId: string; type: string }>("audit");
  const first = published[0];
  assert.ok(first);
  const before = await entries.findOne({ eventId: first.eventId });
  assert.equal(before?.type, "orchestration.RunPaused");
  await unauthorized(() =>
    entries.updateOne({ eventId: first.eventId }, { $set: { type: "orchestration.RunResumed" } }),
  );
  await unauthorized(() =>
    entries.replaceOne({ eventId: first.eventId }, { eventId: first.eventId, type: "x.Y" }),
  );
  await unauthorized(() =>
    entries.findOneAndUpdate({ eventId: first.eventId }, { $set: { type: "x.Y" } }),
  );
  await unauthorized(() => entries.deleteOne({ eventId: first.eventId }));
  await unauthorized(() => entries.deleteMany({}));
  await unauthorized(() => entries.drop());
  await unauthorized(() => entries.createIndex({ type: 1 }, {}, undefined));
  await unauthorized(() => entries.dropIndex("eventId_1"));
  assert.deepEqual(await audit().findOne({ eventId: first.eventId }), before);
  assert.equal(await audit().countDocuments(), published.length);
  const indexes = await audit().indexes();
  assert.ok(indexes.some((index) => index.name === "eventId_1" && index.unique === true));
});

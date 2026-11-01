import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { MongoServerError, ObjectId, type Collection } from "mongodb";
import { checkAuditIndex, readPage, recorder } from "../../src/application/audit.ts";
import type { AuditEntry } from "../../src/domain/audit.ts";
import { event, owner, system, taskId } from "./fixtures.ts";

const exporter = new InMemorySpanExporter();
const tracer = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
}).getTracer("test");
const recordedAt = new Date("2026-11-01T10:00:01.000Z");

beforeEach(() => {
  exporter.reset();
});

const fakeAudit = (insertOne: (entry: AuditEntry) => Promise<unknown>) =>
  ({ insertOne }) as unknown as Collection<AuditEntry>;

const duplicate = () => new MongoServerError({ message: "E11000 duplicate key", code: 11000 });

test("an entry is inserted and its span has the correlation id", async () => {
  const inserted: AuditEntry[] = [];
  const record = recorder(
    fakeAudit((entry) => Promise.resolve(inserted.push(entry))),
    tracer,
    () => recordedAt,
  );
  const source = event("orchestration.RunPaused", owner);
  await record(source);
  assert.deepEqual(inserted, [{ ...source, recordedAt }]);
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.name, "audit orchestration.RunPaused");
  assert.deepEqual(span.attributes, {
    "ai_systems.correlation_id": taskId,
    "ai_systems.event_id": source.eventId,
    "ai_systems.event_type": "orchestration.RunPaused",
    "ai_systems.audit.entry": true,
    "ai_systems.audit.inserted": true,
  });
});

test("an event that is not an entry is not inserted, and it has a span", async () => {
  const record = recorder(
    fakeAudit(() => Promise.reject(new Error("no insert"))),
    tracer,
  );
  await record(event("orchestration.SubtaskQueued", system));
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.attributes["ai_systems.audit.entry"], false);
  assert.equal(span.attributes["ai_systems.audit.inserted"], undefined);
});

test("a second copy of the same event is a duplicate key and is not an error", async () => {
  const record = recorder(
    fakeAudit(() => Promise.reject(duplicate())),
    tracer,
  );
  await record(event("orchestration.RunPaused", owner));
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.attributes["ai_systems.audit.inserted"], false);
  assert.equal(span.status.code, SpanStatusCode.UNSET);
});

test("another insert error goes to the consumer and the span shows the error", async () => {
  const failure = new MongoServerError({ message: "not authorized", code: 13 });
  const record = recorder(
    fakeAudit(() => Promise.reject(failure)),
    tracer,
  );
  await assert.rejects(record(event("orchestration.RunPaused", owner)), failure);
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.status.code, SpanStatusCode.ERROR);
  assert.equal(span.status.message, "MongoServerError");
});

const indexes = (list: object[]) =>
  ({
    indexes: () => Promise.resolve(list),
  }) as unknown as Collection<AuditEntry>;

test("start needs the unique eventId index on audit", async () => {
  const id = { key: { _id: 1 } };
  await checkAuditIndex(indexes([id, { key: { eventId: 1 }, unique: true }]));
  await assert.rejects(checkAuditIndex(indexes([id, { key: { eventId: 1 } }])), /unique eventId/);
  await assert.rejects(
    checkAuditIndex(indexes([id, { key: { eventId: 1, type: 1 }, unique: true }])),
    /unique eventId/,
  );
});

const pageOf = (docs: object[], seen: { filter?: unknown; limit?: number }) =>
  ({
    find: (filter: unknown) => {
      seen.filter = filter;
      return {
        sort: () => ({
          limit: (limit: number) => {
            seen.limit = limit;
            return { toArray: () => Promise.resolve(docs.slice(0, limit)) };
          },
        }),
      };
    },
  }) as unknown as Collection<AuditEntry>;

test("readPage gives the next cursor only when more entries are there", async () => {
  const docs = [3, 2, 1].map((n) => ({
    ...event("orchestration.RunPaused", owner, n),
    _id: new ObjectId(n.toString(16).padStart(24, "0")),
    recordedAt,
  }));
  const seen: { filter?: unknown; limit?: number } = {};
  const first = await readPage(pageOf(docs, seen), { limit: 2 });
  assert.equal(seen.limit, 3);
  assert.deepEqual(seen.filter, {});
  assert.deepEqual(
    first.items.map((item) => item.id),
    [docs[0]?._id.toHexString(), docs[1]?._id.toHexString()],
  );
  assert.equal(first.items[0]?.recordedAt, recordedAt.toISOString());
  assert.equal(first.next, docs[1]?._id.toHexString());
  const last = await readPage(pageOf(docs.slice(2), seen), { limit: 2, before: first.next });
  assert.deepEqual(seen.filter, { _id: { $lt: docs[1]?._id } });
  assert.equal(last.items.length, 1);
  assert.equal(last.next, null);
  assert.deepEqual(await readPage(pageOf([], seen), { limit: 2 }), { items: [], next: null });
});

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { MongoServerError, ObjectId, type Collection } from "mongodb";
import { checkAuditIndex, readBatch, readPage, recorder } from "../../src/application/audit.ts";
import { pageBytes, type AuditEntry } from "../../src/domain/audit.ts";
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

interface Seen {
  filter?: unknown;
  limit?: number;
  batch?: number;
  pulled: number;
}

const pageOf = (docs: object[], seen: Seen) =>
  ({
    find: (filter: unknown) => {
      seen.filter = filter;
      seen.pulled = 0;
      const cursor = {
        sort: () => cursor,
        limit: (limit: number) => {
          seen.limit = limit;
          return cursor;
        },
        batchSize: (batch: number) => {
          seen.batch = batch;
          return cursor;
        },
        async *[Symbol.asyncIterator]() {
          for (const doc of docs.slice(0, seen.limit)) {
            seen.pulled += 1;
            yield await Promise.resolve(doc);
          }
        },
      };
      return cursor;
    },
  }) as unknown as Collection<AuditEntry>;

const docsOf = (count: number, payload?: object) =>
  Array.from({ length: count }, (_, i) => count - i).map((n) => ({
    ...event("orchestration.RunPaused", owner, n),
    ...(payload === undefined ? {} : { payload }),
    _id: new ObjectId(n.toString(16).padStart(24, "0")),
    recordedAt,
  }));

test("readPage gives the next cursor only when more entries are there", async () => {
  const docs = docsOf(3);
  const seen: Seen = { pulled: 0 };
  const first = await readPage(pageOf(docs, seen), { limit: 2 });
  assert.equal(seen.limit, 3);
  assert.equal(seen.batch, readBatch);
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

test("readPage stops reading at the first entry that passes the page bytes", async () => {
  const docs = docsOf(50, { text: "x".repeat(400 * 1024) });
  const seen: Seen = { pulled: 0 };
  const page = await readPage(pageOf(docs, seen), { limit: 50 });
  assert.equal(page.items.length, 2);
  assert.equal(seen.pulled, 3);
  assert.equal(page.next, docs[1]?._id.toHexString());
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= pageBytes);
});

test("readPage keeps one entry that is larger than the page bytes", async () => {
  const docs = docsOf(2, { text: "x".repeat(100) });
  const seen: Seen = { pulled: 0 };
  const page = await readPage(pageOf(docs, seen), { limit: 50 }, 10);
  assert.equal(page.items.length, 1);
  assert.equal(seen.pulled, 2);
  assert.equal(page.next, docs[0]?._id.toHexString());
});

test("readPage keeps an entry that fits the page bytes exactly, and drops it at one byte less", async () => {
  const docs = docsOf(3);
  const seen: Seen = { pulled: 0 };
  const all = await readPage(pageOf(docs, seen), { limit: 50 });
  const [first, second] = all.items;
  assert.ok(first && second);
  const exact =
    Buffer.byteLength(JSON.stringify({ items: [], next: null })) +
    Buffer.byteLength(JSON.stringify(first)) +
    Buffer.byteLength(JSON.stringify(second)) +
    1;
  const fit = await readPage(pageOf(docs, seen), { limit: 50 }, exact);
  assert.deepEqual(fit.items, [first, second]);
  assert.equal(fit.next, second.id);
  const short = await readPage(pageOf(docs, seen), { limit: 50 }, exact - 1);
  assert.deepEqual(short.items, [first]);
  assert.equal(short.next, first.id);
});

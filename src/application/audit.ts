import type { RegisteredEvent } from "@famashines/ai-systems-contracts";
import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { MongoServerError, ObjectId, type Collection, type Db, type WithId } from "mongodb";
import { isAuditEntry, pageBytes, toEntry, type AuditEntry } from "../domain/audit.ts";

export const auditOf = (db: Db): Collection<AuditEntry> => db.collection<AuditEntry>("audit");

export async function checkAuditIndex(audit: Collection<AuditEntry>): Promise<void> {
  const indexes = await audit.indexes();
  const unique = indexes.some(
    (index) => index.unique === true && JSON.stringify(index.key) === '{"eventId":1}',
  );
  if (!unique) throw new Error("audit has no unique eventId index; run the mongodb-init job");
}

const duplicateKey = 11000;

async function insertOnce(audit: Collection<AuditEntry>, entry: AuditEntry): Promise<boolean> {
  try {
    await audit.insertOne(entry);
    return true;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === duplicateKey) return false;
    throw error;
  }
}

export function recorder(
  audit: Collection<AuditEntry>,
  tracer: Tracer,
  now: () => Date = () => new Date(),
): (event: RegisteredEvent) => Promise<void> {
  return (event) =>
    tracer.startActiveSpan(
      `audit ${event.type}`,
      {
        attributes: {
          "ai_systems.correlation_id": event.correlationId,
          "ai_systems.event_id": event.eventId,
          "ai_systems.event_type": event.type,
        },
      },
      async (span) => {
        try {
          const entry = isAuditEntry(event);
          span.setAttribute("ai_systems.audit.entry", entry);
          if (entry) {
            span.setAttribute(
              "ai_systems.audit.inserted",
              await insertOnce(audit, toEntry(event, now())),
            );
          }
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.name : "Error",
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
}

export type AuditItem = Omit<AuditEntry, "recordedAt"> & { id: string; recordedAt: string };

export interface AuditPage {
  items: AuditItem[];
  next: string | null;
}

const toItem = ({ _id, recordedAt, ...entry }: WithId<AuditEntry>): AuditItem => ({
  id: _id.toHexString(),
  ...entry,
  recordedAt: recordedAt.toISOString(),
});

export const readBatch = 10;

export async function readPage(
  audit: Collection<AuditEntry>,
  query: { limit: number; before?: string | undefined },
  limitBytes = pageBytes,
): Promise<AuditPage> {
  const filter = query.before === undefined ? {} : { _id: { $lt: new ObjectId(query.before) } };
  const cursor = audit
    .find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .batchSize(readBatch);
  const items: AuditItem[] = [];
  let size = Buffer.byteLength(JSON.stringify({ items: [], next: null }));
  for await (const doc of cursor) {
    const item = toItem(doc);
    const bytes = Buffer.byteLength(JSON.stringify(item)) + (items.length > 0 ? 1 : 0);
    if (items.length === query.limit || (items.length > 0 && size + bytes > limitBytes)) {
      return { items, next: items.at(-1)?.id ?? null };
    }
    size += bytes;
    items.push(item);
  }
  return { items, next: null };
}

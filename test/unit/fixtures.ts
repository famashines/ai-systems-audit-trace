import { randomUUID } from "node:crypto";
import { parseEvent, type RegisteredEvent } from "@famashines/ai-systems-contracts";

export const taskId = "00000000-0000-4000-8000-000000000001";
export const runId = "00000000-0000-4000-8000-000000000002";
export const subtaskId = "00000000-0000-4000-8000-000000000003";

export const owner = { kind: "owner", id: "owner-1" } as const;
export const system = { kind: "system", id: "orchestration" } as const;

export const event = (
  type: "orchestration.RunPaused" | "orchestration.SubtaskQueued",
  actor: { kind: "owner" | "system"; id: string },
  version = 1,
): RegisteredEvent =>
  parseEvent({
    eventId: randomUUID(),
    type,
    schemaVersion: 1,
    streamId: `task-${taskId}`,
    version,
    occurredAt: "2026-11-01T10:00:00.000Z",
    correlationId: taskId,
    causationId: randomUUID(),
    actor,
    payload: type === "orchestration.RunPaused" ? { taskId, runId } : { taskId, runId, subtaskId },
  });

import assert from "node:assert/strict";
import { test } from "node:test";
import { eventRegistry } from "@famashines/ai-systems-contracts";
import { isAuditEntry, systemDecisions, toEntry } from "../../src/domain/audit.ts";
import { streams } from "../../src/main.ts";
import { event, owner, system } from "./fixtures.ts";

const notEntries = [
  "orchestration.CallRequested",
  "orchestration.CallSettled",
  "orchestration.CallCancelRequested",
  "orchestration.SubtaskQueued",
  "orchestration.SubtaskWaiting",
  "orchestration.SubtaskStarted",
  "orchestration.SubtaskCompleted",
  "conversation.AgentReplyPosted",
  "budget.FundsReserved",
  "budget.ReservationSettled",
];

test("each event type of a read stream is an entry or is named as not an entry", () => {
  const prefixes = Object.values(streams).map((filter) => filter.slice(0, -1));
  const read = Object.keys(eventRegistry).filter((type) =>
    prefixes.some((prefix) => type.startsWith(prefix)),
  );
  assert.deepEqual(
    [...read].sort(),
    [...systemDecisions, ...notEntries].sort(),
    "a new event type needs a decision: add it to systemDecisions or to notEntries",
  );
});

test("an owner event is an entry, also when its type is not a system decision", () => {
  assert.equal(isAuditEntry(event("orchestration.SubtaskQueued", owner)), true);
  assert.equal(isAuditEntry(event("orchestration.SubtaskQueued", system)), false);
  assert.equal(isAuditEntry(event("orchestration.RunPaused", system)), true);
});

test("an entry is the full event and the time it was recorded", () => {
  const source = event("orchestration.RunPaused", owner);
  const recordedAt = new Date("2026-11-01T10:00:01.000Z");
  assert.deepEqual(toEntry(source, recordedAt), { ...source, recordedAt });
});

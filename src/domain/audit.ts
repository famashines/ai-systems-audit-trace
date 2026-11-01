import type { RegisteredEvent } from "@famashines/ai-systems-contracts";

export const systemDecisions: ReadonlySet<RegisteredEvent["type"]> = new Set<
  RegisteredEvent["type"]
>([
  "orchestration.TaskSubmitted",
  "orchestration.MessageRefused",
  "orchestration.ClarificationRequested",
  "orchestration.ClarificationAnswered",
  "orchestration.PlanProposed",
  "orchestration.PlanEdited",
  "orchestration.PlanApproved",
  "orchestration.PlanRejected",
  "orchestration.TaskModeChanged",
  "orchestration.TaskCancelled",
  "orchestration.RunStarted",
  "orchestration.CheckpointOpened",
  "orchestration.CheckpointResolved",
  "orchestration.SteeringMessageAdded",
  "orchestration.SubtaskReassigned",
  "orchestration.SubtaskRetrying",
  "orchestration.SubtaskFailed",
  "orchestration.SubtaskBlocked",
  "orchestration.RunPaused",
  "orchestration.RunResumed",
  "orchestration.RunBlocked",
  "orchestration.RunCompleted",
  "orchestration.RunFailed",
  "orchestration.RunCancelled",
  "conversation.ConversationStarted",
  "conversation.OwnerMessagePosted",
  "budget.BudgetSet",
  "budget.ReservationRefused",
  "budget.ThresholdCrossed",
  "agents.AgentCreated",
  "agents.AgentVersionPublished",
  "agents.AgentVersionActivated",
  "agents.AgentEnabled",
  "agents.AgentDisabled",
  "prompts.PromptCreated",
  "prompts.PromptVersionPublished",
]);

export const isAuditEntry = (event: RegisteredEvent): boolean =>
  event.actor.kind === "owner" || systemDecisions.has(event.type);

export type AuditEntry = RegisteredEvent & { recordedAt: Date };

export const toEntry = (event: RegisteredEvent, recordedAt: Date): AuditEntry => ({
  ...event,
  recordedAt,
});

export const pageBytes = 960 * 1024;

export function fitPage<T>(items: readonly T[], limitBytes = pageBytes): T[] {
  let size = Buffer.byteLength(JSON.stringify({ items: [], next: null }));
  const page: T[] = [];
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + (page.length > 0 ? 1 : 0);
    if (page.length > 0 && size + bytes > limitBytes) break;
    size += bytes;
    page.push(item);
  }
  return page;
}

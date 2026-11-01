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
  "budget.ReservationExpired",
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

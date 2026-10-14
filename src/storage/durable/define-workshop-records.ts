import { defineDoc, defineEntry } from "@earendil-works/pi-durable";
import type { InstallationDocumentV1, ServiceMutationReceiptsDocumentV1 } from "../../installation/schema.js";
import type { BotDocumentV1 } from "../../bot/schema.js";
import type {
  WorkflowRunDocumentV1,
  WorkshopEventV1,
  WorkshopJudgmentV1,
  WorkshopProcessV1,
} from "../../run/records.js";

/** Session-scoped installation index; run history lives in run conversations. */
export const WorkshopInstallationDoc = defineDoc<InstallationDocumentV1>({
  kind: "workshop.installation",
  version: 1,
  scope: "session",
  initial: () => ({ state: "uninitialized" }),
});

/** Conversation-scoped canonical state, retained after every owned task settles. */
export const WorkshopRunDoc = defineDoc<WorkflowRunDocumentV1>({
  kind: "workshop.run",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ state: "uninitialized" }),
});

/** Immutable run events and view-projection failure diagnostics. */
export const WorkshopEventEntry = defineEntry<WorkshopEventV1>("workshop.event");

/** Immutable process-incarnation snapshot, attributable to its owning attempt task. */
export const WorkshopProcessEntry = defineEntry<WorkshopProcessV1>("workshop.process");

/** Immutable accepted decision from the restricted failure-judgment task. */
export const WorkshopJudgmentEntry = defineEntry<WorkshopJudgmentV1>("workshop.judgment");

/** Session-scoped idempotency receipts for committed service mutations. */
export const WorkshopServiceReceiptsDoc = defineDoc<ServiceMutationReceiptsDocumentV1>({
  kind: "workshop.service-receipts",
  version: 1,
  scope: "session",
  initial: () => ({ state: "ready", receipts: [] }),
});

/** Session-scoped shared bot identity and committed run-event scan cursors. */
export const WorkshopBotDoc = defineDoc<BotDocumentV1>({
  kind: "workshop.bot",
  version: 1,
  scope: "session",
  initial: () => ({ state: "ready", conversationId: null, cursorInitialized: false, eventCursors: {} }),
});

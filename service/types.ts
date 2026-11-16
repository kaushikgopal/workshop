import { z } from "zod";

const workflowName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const requestId = z.string().min(1).max(128);
const listLimit = z.number().int().min(0).max(1_000).optional();

const serviceRequestSchema = z.discriminatedUnion("type", [
  z.object({ request_id: requestId, type: z.literal("list_workflows") }).strict(),
  z.object({ request_id: requestId, type: z.literal("list_runs"), limit: listLimit, workflow: workflowName.optional() }).strict(),
  z.object({ request_id: requestId, type: z.literal("read_run"), run_id: z.string().min(1) }).strict(),
  z.object({ request_id: requestId, type: z.literal("start_workflow"), workflow: workflowName }).strict(),
  z.object({ request_id: requestId, type: z.literal("watch_chat") }).strict(),
  z.object({ request_id: requestId, type: z.literal("submit_chat"), content: z.string().min(1) }).strict(),
  z.object({
    request_id: requestId,
    type: z.literal("decide_blocked_run"),
    run_id: z.string().min(1),
    decision_number: z.number().int().positive(),
    decision: z.unknown(),
    note: z.string().optional(),
  }).strict(),
  z.object({ request_id: requestId, type: z.literal("cancel_run"), run_id: z.string().min(1) }).strict(),
  z.object({ request_id: requestId, type: z.literal("pause_workflow"), workflow: workflowName }).strict(),
  z.object({ request_id: requestId, type: z.literal("resume_workflow"), workflow: workflowName }).strict(),
  z.object({ request_id: requestId, type: z.literal("list_actions"), limit: listLimit, workflow: workflowName.optional() }).strict(),
]);

export type ServiceRequest = z.infer<typeof serviceRequestSchema>;
export type ServiceResponse = { request_id?: string; ok: boolean; [key: string]: unknown };

export function parseServiceRequest(value: unknown): ServiceRequest {
  return serviceRequestSchema.parse(value);
}

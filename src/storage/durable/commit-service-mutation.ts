import { Buffer } from "node:buffer";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import { canonicalHash } from "../../definition/hash-canonical-json.js";
import {
  serviceMutationReceiptV1Schema,
  serviceMutationReceiptsDocumentV1Schema,
  type ServiceMutationReceiptV1,
} from "../../installation/schema-v2.js";
import { WorkshopServiceReceiptsDoc } from "./define-workshop-records.js";

const MAX_SERVICE_ONLY_RECEIPTS = 1_000;
const MAX_RECEIPT_RESPONSE_BYTES = 64 * 1024;

export type ServiceMutationRetention =
  | { readonly kind: "service" }
  | { readonly kind: "run"; readonly runId: string };

export type ServiceMutationCommitResult =
  | { readonly kind: "committed"; readonly response: JsonValue }
  | { readonly kind: "replayed"; readonly response: JsonValue }
  | { readonly kind: "idempotency_conflict" };

export interface CommitServiceMutationInput {
  readonly harness: Pick<Harness, "commit">;
  readonly context: Context;
  readonly request: {
    readonly requestId: string;
    readonly method: ServiceMutationReceiptV1["method"];
    readonly arguments: JsonValue;
  };
  readonly retain: (response: JsonValue) => ServiceMutationRetention;
  readonly committedAt?: string;
  readonly apply: (tx: Tx) => JsonValue | Promise<JsonValue>;
}

export type CommitServiceMutationInTransactionInput = Omit<CommitServiceMutationInput, "harness" | "context">;

/** Apply a checked service mutation and retain its response in the same Durable transaction. */
export async function commitServiceMutation(input: CommitServiceMutationInput): Promise<ServiceMutationCommitResult> {
  return await input.harness.commit(
    (tx) => commitServiceMutationInTransaction(tx, input),
    input.context,
  );
}

export type ServiceMutationReceiptLookupResult =
  | { readonly kind: "absent" }
  | { readonly kind: "replayed"; readonly response: JsonValue }
  | { readonly kind: "idempotency_conflict" };

/** Check for an existing receipt before external preflight can reject a committed replay. */
export async function findServiceMutationReceipt(input: {
  readonly harness: Pick<Harness, "snapshot">;
  readonly context: Context;
  readonly request: CommitServiceMutationInput["request"];
}): Promise<ServiceMutationReceiptLookupResult> {
  const requestId = serviceMutationReceiptV1Schema.shape.requestId.parse(input.request.requestId);
  const method = serviceMutationReceiptV1Schema.shape.method.parse(input.request.method);
  const checkedArguments = serviceMutationReceiptV1Schema.shape.response.safeParse(input.request.arguments);
  if (!checkedArguments.success) throw new TypeError("Service mutation arguments must be JSON");
  const requestHash = canonicalHash({ method, arguments: checkedArguments.data });
  const snapshot = await input.harness.snapshot(WorkshopServiceReceiptsDoc, input.context);
  const checkedDocument = serviceMutationReceiptsDocumentV1Schema.safeParse(snapshot ?? { state: "ready", receipts: [] });
  if (!checkedDocument.success) throw new Error("Durable service-receipt document is invalid");
  const prior = checkedDocument.data.receipts.find((receipt) => receipt.requestId === requestId);
  if (prior === undefined) return { kind: "absent" };
  if (prior.method !== method || prior.requestHash !== requestHash) return { kind: "idempotency_conflict" };
  return { kind: "replayed", response: prior.response };
}

/** Compose a mutation receipt with another Durable effect already using the same transaction. */
export async function commitServiceMutationInTransaction(
  tx: Tx,
  input: CommitServiceMutationInTransactionInput,
): Promise<ServiceMutationCommitResult> {
  const requestId = serviceMutationReceiptV1Schema.shape.requestId.parse(input.request.requestId);
  const method = serviceMutationReceiptV1Schema.shape.method.parse(input.request.method);
  const checkedArguments = serviceMutationReceiptV1Schema.shape.response.safeParse(input.request.arguments);
  if (!checkedArguments.success) throw new TypeError("Service mutation arguments must be JSON");
  const requestHash = canonicalHash({ method, arguments: checkedArguments.data });
  const receipts = await tx.doc(WorkshopServiceReceiptsDoc);
  const checkedDocument = serviceMutationReceiptsDocumentV1Schema.safeParse(receipts);
  if (!checkedDocument.success) throw new Error("Durable service-receipt document is invalid");

  const prior = checkedDocument.data.receipts.find((receipt) => receipt.requestId === requestId);
  if (prior !== undefined) {
    if (prior.method !== method || prior.requestHash !== requestHash) return { kind: "idempotency_conflict" };
    return { kind: "replayed", response: prior.response };
  }

  const applied = await input.apply(tx);
  const checkedResponse = serviceMutationReceiptV1Schema.shape.response.safeParse(applied);
  if (!checkedResponse.success) throw new Error("Service mutation response must be JSON");
  const responseBytes = Buffer.byteLength(JSON.stringify(checkedResponse.data), "utf8");
  if (responseBytes > MAX_RECEIPT_RESPONSE_BYTES) {
    throw new Error(`Service mutation receipt exceeds ${MAX_RECEIPT_RESPONSE_BYTES} bytes`);
  }

  const receipt = serviceMutationReceiptV1Schema.parse({
    requestId,
    method,
    requestHash,
    retention: input.retain(checkedResponse.data),
    committedAt: input.committedAt ?? new Date().toISOString(),
    response: checkedResponse.data,
  });
  Object.assign(receipts, {
    state: "ready",
    receipts: retainLatestServiceReceipts([...checkedDocument.data.receipts, receipt]),
  });
  return { kind: "committed", response: checkedResponse.data };
}

function retainLatestServiceReceipts(receipts: readonly ServiceMutationReceiptV1[]): ServiceMutationReceiptV1[] {
  const serviceCount = receipts.filter((receipt) => receipt.retention.kind === "service").length;
  let discard = Math.max(0, serviceCount - MAX_SERVICE_ONLY_RECEIPTS);
  if (discard === 0) return [...receipts];

  return receipts.filter((receipt) => {
    if (receipt.retention.kind !== "service" || discard === 0) return true;
    discard -= 1;
    return false;
  });
}

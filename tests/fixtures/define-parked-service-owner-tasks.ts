import { writeFileSync } from "node:fs";
import { defineTask } from "@earendil-works/pi-durable";

interface MarkerInput { readonly markerPath: string }

export const ParkedTask = defineTask<MarkerInput, { readonly phase: "hold" }, { readonly held: true }>({
  name: "workshop.test.parked-service-owner-hold",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (task) => {
      writeFileSync(task.input.markerPath, "entered");
      await new Promise<void>(() => {});
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "fixture stopped" } }), context);
  },
});

export const PendingTask = defineTask<MarkerInput, { readonly phase: "settle" }, { readonly settled: true }>({
  name: "workshop.test.parked-service-owner-pending",
  version: 1,
  initial: () => ({ phase: "settle" }),
  phases: {
    settle: async (task, runtime, context) => {
      writeFileSync(task.input.markerPath, "executed");
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { settled: true } } }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "fixture stopped" } }), context);
  },
});

import { z } from "zod";

/** JSON timestamps use UTC ISO-8601 with millisecond precision. */
export const utcTimestampSchema = z.iso.datetime({ precision: 3 });

export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const replayPolicySchema = z.enum(["never", "safe"]);

/** Sizes and elapsed times must remain exact in JavaScript's numeric representation. */
export const byteCountSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const elapsedMillisecondsSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);

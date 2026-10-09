import { z } from "zod";

/** JSON timestamps use UTC ISO-8601 with millisecond precision. */
export const utcTimestampV2Schema = z.iso.datetime({ precision: 3 });

export const sha256V2Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const replayPolicyV2Schema = z.enum(["never", "safe"]);

/** Sizes and elapsed times must remain exact in JavaScript's numeric representation. */
export const byteCountV2Schema = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const elapsedMillisecondsV2Schema = z.number().int().nonnegative().refine(Number.isSafeInteger);

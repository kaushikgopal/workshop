import { ZodError } from "zod";

/**
 * The CLI's shared edges: what a command does when the operator got it wrong,
 * and how a failure becomes one readable line.
 *
 * Separate from `main.ts` so each command module can use them without
 * importing the executable's dispatch — a circular import back into the
 * dispatcher would undo the split.
 */

/** Report a usage or runtime failure and stop. Exit code 1 is the CLI's failure. */
export function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Human-readable failure text for CLI errors, including zod issues. */
export function errorText(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.map((i) => `  - ${i.path.join(".") || "definition"}: ${i.message}`).join("\n");
  }
  return e instanceof Error ? e.message : String(e);
}

/** The first positional argument, or a usage failure naming what was missing. */
export function requireArg(args: string[], name: string): string {
  const value = args[0];
  if (!value) die(`missing <${name}> argument`);
  return value;
}

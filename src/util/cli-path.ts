import { resolve } from "node:path";

/**
 * The single executable agents use for internal runtime commands.
 * Source checkouts invoke the executable TypeScript entry point directly;
 * installed packages fall back to the `workshop` binary.
 */
export function runtimeCliInvocation(): string {
  const script = process.argv[1];
  if (script && script.endsWith(".ts")) {
    return resolve(script);
  }
  return "workshop";
}

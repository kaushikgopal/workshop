/**
 * The absolute invocation agents use for internal runtime commands
 * (progress/block). Unquoted-expansion friendly: "bun /abs/path/cli.ts".
 * Falls back to the installed bin when the script path is unknown.
 */
export function runtimeCliInvocation(): string {
  const script = process.argv[1];
  if (script && script.endsWith(".ts")) {
    return `bun ${new URL(`file://${script}`).pathname}`;
  }
  return "workshop";
}

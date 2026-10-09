#!/usr/bin/env bun
import { die, errorText } from "./errors.js";

/**
 * Workshop entry point. Unqualified commands use the v4 Durable engine; a
 * leading `--engine v3` selects the legacy fallback and `--engine v4` names the
 * default explicitly. Each engine is imported lazily so help and offline
 * validation never load the other engine's storage or the viewer.
 */
type Engine = "v3" | "v4";

type EngineSelection =
  | { readonly _tag: "explicit"; readonly engine: Engine; readonly args: readonly string[] }
  | { readonly _tag: "default"; readonly args: readonly string[] }
  | { readonly _tag: "invalid"; readonly error: string };

type Route =
  | { readonly _tag: "engine"; readonly engine: Engine; readonly args: readonly string[] }
  | { readonly _tag: "usage-error"; readonly error: string };

const ORCHESTRATE_GUIDANCE = [
  "`workshop orchestrate` was the v3 daemon and is not part of the default v4 engine.",
  "  v4 runs schedules in its service: `workshop service start` (detached) or `workshop service serve` (foreground).",
  "  To keep running the legacy v3 daemon, use `workshop --engine v3 orchestrate`.",
].join("\n");

function selectEngine(argv: readonly string[]): EngineSelection {
  if (argv[0] === "--engine") {
    const engine = argv[1];
    if (engine === undefined) return { _tag: "invalid", error: "missing engine after --engine; expected v3 or v4" };
    if (engine !== "v3" && engine !== "v4") {
      return { _tag: "invalid", error: `unsupported engine ${JSON.stringify(engine)}; choose v3 or v4, or omit --engine for v4` };
    }
    const args = argv.slice(2);
    if (args.some(isEngineOption)) return { _tag: "invalid", error: "--engine may be specified only once and must lead the command" };
    return { _tag: "explicit", engine, args };
  }
  if (argv.some(isEngineOption)) return { _tag: "invalid", error: "--engine must lead the command, e.g. workshop --engine v3 <command>" };
  return { _tag: "default", args: argv };
}

/**
 * Two unqualified commands keep legacy meaning. Running v3 agents call back
 * through `"$WORKSHOP_CLI" runtime ...`, which carries no selector and has no
 * v4 equivalent, so it stays on v3. `orchestrate` would start the v3 daemon,
 * which must never happen implicitly.
 */
function routeCommand(selection: Exclude<EngineSelection, { readonly _tag: "invalid" }>): Route {
  if (selection._tag === "explicit") return { _tag: "engine", engine: selection.engine, args: selection.args };
  const command = selection.args[0];
  if (command === "runtime") return { _tag: "engine", engine: "v3", args: selection.args };
  if (command === "orchestrate") return { _tag: "usage-error", error: ORCHESTRATE_GUIDANCE };
  return { _tag: "engine", engine: "v4", args: selection.args };
}

function isEngineOption(value: string): boolean {
  return value === "--engine" || value.startsWith("--engine=");
}

async function main(): Promise<void> {
  const selection = selectEngine(process.argv.slice(2));
  if (selection._tag === "invalid") {
    console.error(`error: ${selection.error}`);
    process.exitCode = 64;
    return;
  }
  const route = routeCommand(selection);
  if (route._tag === "usage-error") {
    console.error(`error: ${route.error}`);
    process.exitCode = 64;
    return;
  }
  if (route.engine === "v4") {
    const { dispatchV4Command } = await import("./dispatch-v4-command.js");
    return dispatchV4Command(route.args);
  }
  const { dispatchV3Command } = await import("./dispatch-v3-command.js");
  return dispatchV3Command(route.args);
}

process.on("unhandledRejection", (e) => {
  die(errorText(e));
});

main().catch((e) => {
  die(errorText(e));
});

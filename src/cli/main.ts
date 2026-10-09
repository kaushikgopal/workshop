#!/usr/bin/env bun
import { dispatchCommand } from "./dispatch-command.js";
import { die, errorText } from "./errors.js";

/** Workshop entry point. The dispatcher loads the service client and the viewer only when a command needs them. */
process.on("unhandledRejection", (e) => {
  die(errorText(e));
});

dispatchCommand(process.argv.slice(2)).catch((e) => {
  die(errorText(e));
});

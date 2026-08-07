#!/usr/bin/env node
import { runCli } from "./cli/index.js";
import { renderError } from "./errors.js";
import { runServer } from "./server.js";

const VERSION = "0.1.0";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // No arguments means "be an MCP server on stdio" — that is how MCP clients
  // launch us. Anything else is a human at a terminal.
  if (argv.length === 0) {
    await runServer();
    return 0;
  }

  return runCli(argv);
}

main().then(
  (code) => {
    // The server path never resolves until the transport closes; exiting on
    // resolve is correct for the CLI path and harmless for the server path.
    if (code !== 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${renderError(err)}\n`);
    process.exitCode = 1;
  },
);

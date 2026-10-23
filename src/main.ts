#!/usr/bin/env node
import { runCli } from './cli/index.js';

// Explicit exit after bridge cleanup: its stdin handle may otherwise keep Node
// alive after B07's SIGTERM handler has closed the MCP transports.
process.exit(await runCli(process.argv.slice(2)));

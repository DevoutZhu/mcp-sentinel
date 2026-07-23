#!/usr/bin/env node

import { Command } from 'commander';
import { configureLogger, isTTY, CLIError } from './utils/logger.js';
import { registerTestCommand } from './commands/test.js';
import { registerScanCommand } from './commands/scan.js';
import { registerReportCommand } from './commands/report.js';
import { registerConfigCommand } from './commands/config.js';

// ---------------------------------------------------------------------------
// MCP Sentinel CLI — entry point
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('mcp-sentinel')
  .description('Postman for MCP — test, debug, and monitor MCP servers')
  .version('0.1.0')
  // Global options: these are available on every command and mean the
  // same thing everywhere — consistency is the contract.
  .option('-v, --verbose', 'Show verbose debug output')
  .option('-q, --quiet', 'Suppress non-error output')
  .option('--no-color', 'Disable colored output (auto-detected when piped)')
  .option('--json', 'Output as JSON (shorthand for --format json)')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();

    // Auto-detect: disable color when output is piped (respect NO_COLOR too).
    const noColor =
      opts.noColor === true ||
      !isTTY() ||
      process.env.NO_COLOR !== undefined;

    configureLogger({
      verbose: opts.verbose === true,
      quiet: opts.quiet === true,
      json: opts.json === true,
      noColor,
    });
  });

// --- Register subcommands --------------------------------------------------

registerTestCommand(program);
registerScanCommand(program);
registerReportCommand(program);
registerConfigCommand(program);

// --- Error boundary --------------------------------------------------------
// Catch Commander parse errors AND our own CLIErrors, print them nicely,
// and exit with a meaningful code. Raw stack traces are never shown to
// the user unless --verbose is set.

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CLIError) {
      err.print();
      process.exit(1);
    }

    // Commander's own errors (missing args, unknown options, etc.)
    if (err instanceof Error && err.message) {
      const opts = program.opts();
      if (opts.verbose) {
        console.error(err);
      } else {
        process.stderr.write(`Error: ${err.message}\n`);
        process.stderr.write(
          'Run with --help for usage, or --verbose to see the full trace.\n',
        );
      }
      process.exit(1);
    }

    // Completely unexpected — always show the trace
    console.error('Unexpected error:', err);
    process.exit(1);
  }
}

main();

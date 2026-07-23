import { Command } from 'commander';
import { ProtocolValidator, ALL_RULES } from '@mcp-sentinel/core';
import { probe, guessTransport, type ProbeResult, type TransportMode } from '../utils/probe.js';
import {
  configureLogger,
  success,
  fail,
  warn,
  info,
  debug,
  heading,
  divider,
  json as logJson,
  CLIError,
} from '../utils/logger.js';

// ---------------------------------------------------------------------------
// test — test a single MCP server
// ---------------------------------------------------------------------------

export function registerTestCommand(program: Command): void {
  program
    .command('test <target>')
    .description('Test a single MCP server at the given path or URL')
    .option('-t, --transport <mode>', 'Transport: stdio or sse (auto-detected if omitted)')
    .option('--timeout <ms>', 'Connection timeout in milliseconds', '10000')
    .option('--format <type>', 'Output format: terminal, json, or html', 'terminal')
    .option('-v, --verbose', 'Show verbose output including debug info')
    .addHelpText(
      'after',
      `
Examples:
  mcp-sentinel test ./my-server              Test a local stdio MCP server
  mcp-sentinel test https://mcp.example.com  Test a remote SSE endpoint
  mcp-sentinel test ./my-server --verbose    Verbose output with probe details
  mcp-sentinel test ./my-server --json       Machine-readable JSON output
  mcp-sentinel test ./my-server --timeout 15000`,
    )
    .action(async (target: string, options: Record<string, string>) => {
      const timeout = parseInt(options.timeout ?? '10000', 10);
      if (isNaN(timeout) || timeout < 1000) {
        throw new CLIError(
          `Invalid timeout "${options.timeout}". Must be a number >= 1000 (ms).`,
          'Example: --timeout 15000',
        );
      }

      const format = options.format as string;
      if (!['terminal', 'json', 'html'].includes(format)) {
        throw new CLIError(
          `Unknown format "${format}".`,
          'Valid formats: terminal, json, html.',
        );
      }

      configureLogger({
        verbose: Boolean(options.verbose),
        json: format === 'json',
      });

      // Determine transport
      let transport: TransportMode;
      if (options.transport) {
        const raw = options.transport.toLowerCase();
        if (raw !== 'stdio' && raw !== 'sse') {
          throw new CLIError(
            `Unknown transport "${options.transport}".`,
            'Valid transports: stdio, sse. Omit to auto-detect.',
          );
        }
        transport = raw;
      } else {
        transport = guessTransport(target);
        debug(`Auto-detected transport: ${transport}`);
      }

      // --- Run probe -------------------------------------------------------
      heading(`Testing MCP Server: ${target}`);

      debug(`Transport: ${transport}`);
      debug(`Timeout: ${timeout}ms`);

      const result = await probe(target, { transport, timeout });

      // --- Validate against rules -----------------------------------------
      const validator = new ProtocolValidator();
      for (const rule of ALL_RULES) {
        validator.register(rule);
      }

      const report = validator.validate(result.initResponse, result.toolListResponse);

      // --- Output ---------------------------------------------------------
      if (format === 'json') {
        logJson({ probe: sanitizeForJson(result), report });
        if (!result.connected) {
          process.exit(1);
        }
        return;
      }

      // Terminal output
      printProbeResult(result);
      divider();
      printReport(report);

      if (!result.connected || report.failedRules > 0) {
        process.exit(report.failedRules > 0 ? 2 : 1);
      }
    });
}

// --- terminal output helpers ----------------------------------------------

function printProbeResult(result: ProbeResult): void {
  if (result.connected) {
    success(`Connected (${result.latencyMs}ms) via ${result.transport}`);
    info(`Protocol: ${result.initResponse.protocolVersion}`);
    if (result.initResponse.serverInfo?.name) {
      info(`Server: ${result.initResponse.serverInfo.name} v${result.initResponse.serverInfo.version ?? '?'}`);
    }
  } else {
    fail(`Connection failed: ${result.error ?? 'Unknown error'}`);
  }
}

function printReport(report: { serverName: string; score: number; totalRules: number; passedRules: number; failedRules: number; results: Array<{ id: string; name: string; severity: string; passed: boolean; message: string }> }): void {
  info(`Score: ${report.score}/100`);
  info(`Rules: ${report.passedRules} passed, ${report.failedRules} failed, ${report.totalRules} total`);

  divider();

  for (const r of report.results) {
    if (r.passed) {
      success(`[${r.id}] ${r.name} — ${r.message}`);
    } else if (r.severity === 'error') {
      fail(`[${r.id}] ${r.name} — ${r.message}`);
    } else if (r.severity === 'warning') {
      warn(`[${r.id}] ${r.name} — ${r.message}`);
    } else {
      info(`[${r.id}] ${r.name} — ${r.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON sanitisation — Date / BigInt etc. are not valid JSON primitives
// ---------------------------------------------------------------------------

function sanitizeForJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeForJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForJson(v);
    }
    return out;
  }
  return value;
}

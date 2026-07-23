import { Command } from 'commander';
import * as path from 'node:path';
import { probeServer } from 'mcp-sentinel-core';
import type { MCPServerConfig, ProbeResult, DimensionResult } from 'mcp-sentinel-core';
import { guessTransport, type TransportMode } from '../utils/probe.js';
import {
  configureLogger,
  debug,
  CLIError,
} from '../utils/logger.js';
import { startSpinner, succeedSpinner, failSpinner } from '../utils/spinner.js';

// ---------------------------------------------------------------------------
// test — test a single MCP server (Postman-style experience)
// ---------------------------------------------------------------------------

export function registerTestCommand(program: Command): void {
  program
    .command('test <target>')
    .description('Test a single MCP server at the given path or URL')
    .option('-t, --transport <mode>', 'Transport: stdio or sse (auto-detected if omitted)')
    .option('--timeout <ms>', 'Connection timeout in milliseconds', '10000')
    .option('--format <type>', 'Output format: terminal, json, or html', 'terminal')
    .option('--perf-threshold <ms>', 'Performance latency threshold in ms', '3000')
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

      const perfThreshold = parseInt(options.perfThreshold ?? '3000', 10);
      if (isNaN(perfThreshold) || perfThreshold < 100) {
        throw new CLIError(
          `Invalid perf-threshold "${options.perfThreshold}". Must be a number >= 100 (ms).`,
          'Example: --perf-threshold 5000',
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

      // Build MCPServerConfig from raw target
      const config = buildServerConfig(target, transport);

      debug(`Transport: ${transport}`);
      debug(`Timeout: ${timeout}ms`);
      debug(`Perf threshold: ${perfThreshold}ms`);

      // --- JSON output path -------------------------------------------------
      if (format === 'json') {
        startSpinner(`Probing ${config.name}...`);
        try {
          const result = await probeServer(config, { timeout, performanceThreshold: perfThreshold });
          succeedSpinner(`Probe complete`);
          process.stdout.write(JSON.stringify(sanitizeForJson(result), null, 2) + '\n');
          process.exit(result.overallPassed ? 0 : 1);
        } catch (err) {
          failSpinner(`Probe failed`);
          process.stdout.write(JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }, null, 2) + '\n');
          process.exit(1);
        }
        return;
      }

      // --- Terminal output (Postman-style) ----------------------------------
      startSpinner(`Probing ${config.name}...`);

      let result: ProbeResult;
      try {
        result = await probeServer(config, { timeout, performanceThreshold: perfThreshold });
        succeedSpinner(`Probe complete`);
      } catch (err) {
        failSpinner(`Probe failed`);
        process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return; // unreachable, but satisfies TS
      }

      // Print Postman-style header
      printHeader(config);

      // Print each dimension result
      for (const dim of result.dimensions) {
        printDimension(dim);
      }

      // Print footer
      printFooter(result);

      // Exit with appropriate code
      process.exit(result.overallPassed ? 0 : 1);
    });
}

// ---------------------------------------------------------------------------
// Build MCPServerConfig from raw target
// ---------------------------------------------------------------------------

function buildServerConfig(target: string, transport: TransportMode): MCPServerConfig {
  const basename = target.split(/[/\\]/).pop()?.replace(/\.(js|ts|mjs)$/, '') ?? target;

  if (transport === 'stdio') {
    const resolved = path.resolve(target);
    return {
      name: basename,
      transport: 'stdio',
      command: 'node',
      args: [resolved],
    };
  }

  // SSE
  return {
    name: basename,
    transport: 'sse',
    url: target,
  };
}

// ---------------------------------------------------------------------------
// Postman-style terminal output
// ---------------------------------------------------------------------------

/** Box-drawing characters (use ASCII fallback when no-color). */
const BOX = {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  left: '│', right: '│',
};

const DIM_ICONS: Record<string, string> = {
  connectivity: '📡',
  protocol: '📋',
  tools: '🔧',
  performance: '⚡',
  security: '🔒',
};

const DIM_LABELS: Record<string, string> = {
  connectivity: 'Connectivity',
  protocol: 'Protocol',
  tools: 'Tools',
  performance: 'Performance',
  security: 'Security',
};

function padRight(str: string, len: number): string {
  // Count visual width (simplified: treat CJK/emoji as width 2, ASCII as 1)
  let visual = 0;
  for (const char of str) {
    const cp = char.codePointAt(0) ?? 0;
    visual += cp > 0x7f ? 2 : 1;
  }
  const pad = Math.max(0, len - visual);
  return str + ' '.repeat(pad);
}

function printHeader(config: MCPServerConfig): void {
  const width = 49;
  const lines = [
    `${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`,
    `${BOX.v}  MCP Sentinel — MCP Server Test${' '.repeat(width - 36)}${BOX.v}`,
    `${BOX.v}  Target: ${truncate(config.name, width - 14)}${' '.repeat(Math.max(0, width - 14 - config.name.length - 2))}${BOX.v}`,
    `${BOX.v}  Transport: ${truncate(config.transport, width - 15)}${' '.repeat(Math.max(0, width - 15 - config.transport.length - 2))}${BOX.v}`,
    `${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}`,
  ];

  process.stdout.write('\n' + lines.join('\n') + '\n\n');
}

function printDimension(dim: DimensionResult): void {
  const icon = DIM_ICONS[dim.dimension] ?? '  ';
  const label = DIM_LABELS[dim.dimension] ?? dim.dimension;
  // PASSED vs FAILED vs SKIPPED:
  // - PASSED:  dim.passed === true
  // - FAILED:  dim.passed === false AND ran (has durationMs)
  // - SKIPPED: dim.passed === false AND never ran (no durationMs, from skipped())
  const ran = dim.durationMs !== undefined;
  const statusIcon = dim.passed ? '✅' : (ran ? '❌' : '⏭️');
  const statusLabel = dim.passed ? 'PASSED' : (ran ? 'FAILED' : 'SKIPPED');
  const dur = dim.durationMs !== undefined ? `(${dim.durationMs}ms)` : '';

  // Main line
  const mainLine = `${icon} ${padRight(label, 14)}${statusIcon} ${statusLabel}  ${dur}`;
  process.stdout.write(`  ${mainLine}\n`);

  // Detail lines
  if (dim.passed && dim.details) {
    printDimensionDetails(dim);
  } else if (dim.error) {
    process.stdout.write(`     → ${dim.message}\n`);
  } else {
    process.stdout.write(`     → ${dim.message}\n`);
  }
}

function printDimensionDetails(dim: DimensionResult): void {
  const d = dim.details ?? {};

  switch (dim.dimension) {
    case 'connectivity': {
      const serverInfo = d.serverInfo as { name?: string; version?: string } | undefined;
      if (serverInfo?.name) {
        process.stdout.write(`     → Server: ${serverInfo.name} v${serverInfo.version ?? '?'}\n`);
      }
      process.stdout.write(`     → Protocol: ${d.protocolVersion ?? 'unknown'}\n`);
      break;
    }

    case 'protocol': {
      const score = d.score as number ?? 0;
      const passedRules = d.passedRules as number ?? 0;
      const totalRules = d.totalRules as number ?? 0;
      const failures = d.failures as Array<{ id: string; name: string; message: string }> | undefined;
      process.stdout.write(`     → Score: ${score}/100 (${passedRules}/${totalRules} rules)\n`);
      if (failures && failures.length > 0) {
        for (const f of failures) {
          process.stdout.write(`     → ${f.id}: ${f.message}\n`);
        }
      }
      break;
    }

    case 'tools': {
      const tools = d.tools as Array<{ name: string; description: string }> | undefined;
      const toolCallResults = d.toolCallResults as Array<{ name: string; passed: boolean; latencyMs: number; error?: string }> | undefined;
      if (tools && tools.length > 0) {
        for (const t of tools) {
          const callResult = toolCallResults?.find((r) => r.name === t.name);
          const desc = t.description ? ` — "${t.description}"` : '';
          const lat = callResult?.passed ? ` ${callResult.latencyMs}ms` : (callResult ? ' (call failed)' : '');
          process.stdout.write(`     → ${crop(t.name, 16)}${desc}${lat}\n`);
        }
      } else {
        process.stdout.write(`     → No tools discovered\n`);
      }
      break;
    }

    case 'performance': {
      const avgLatency = d.avgLatencyMs as number | undefined;
      const perTool = d.perToolLatency as Record<string, number> | undefined;
      if (avgLatency !== undefined) {
        process.stdout.write(`     → tools/list avg: ${avgLatency}ms\n`);
      }
      if (perTool) {
        for (const [name, lat] of Object.entries(perTool)) {
          process.stdout.write(`     → tools/call ${name}: ${lat}ms\n`);
        }
      }
      break;
    }

    case 'security': {
      const total = d.totalFindings as number ?? 0;
      const critical = d.criticalCount as number ?? 0;
      const high = d.highCount as number ?? 0;
      const findings = d.findings as Array<{ id: string; severity: string; category: string; description: string }> | undefined;
      if (total === 0) {
        process.stdout.write(`     → No issues detected\n`);
      } else {
        process.stdout.write(`     → ${total} finding(s): ${critical} critical, ${high} high\n`);
        if (findings) {
          for (const f of findings) {
            process.stdout.write(`     → [${f.severity.toUpperCase()}] ${f.id}: ${f.description}\n`);
          }
        }
      }
      break;
    }

    default:
      // Generic detail dump for unknown dimensions
      break;
  }
}

function printFooter(result: ProbeResult): void {
  const width = 49;
  const passed = result.dimensions.filter((d) => d.passed).length;
  const total = result.dimensions.length;

  const passedIcon = result.overallPassed ? '🎉' : '⚠️';
  const verdict = result.overallPassed ? 'ALL PASSED' : 'SOME FAILED';

  const lines = [
    `${BOX.h.repeat(width)}`,
    `${passedIcon} Overall: ${verdict} (${passed}/${total})`,
    `${BOX.h.repeat(width)}`,
  ];

  process.stdout.write('\n' + lines.join('\n') + '\n\n');
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

function crop(str: string, max: number): string {
  if (str.length <= max) return str.padEnd(max);
  return str.slice(0, max - 1) + '…';
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

import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ProtocolValidator, ALL_RULES } from 'mcp-sentinel-core';
import { probe, guessTransport, type ProbeResult } from '../utils/probe.js';
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
import { startSpinner, succeedSpinner, failSpinner } from '../utils/spinner.js';

// ---------------------------------------------------------------------------
// scan — recursively discover and test every mcp.json in a directory
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 5;

interface ScanTarget {
  configPath: string;
  serverPath: string;
}

interface ScanResult {
  target: ScanTarget;
  probe: ProbeResult;
  score: number;
  passed: number;
  failed: number;
}

export function registerScanCommand(program: Command): void {
  program
    .command('scan <directory>')
    .description('Scan a directory recursively for mcp.json files and test each server')
    .option('--concurrency <n>', 'Max concurrent tests', String(DEFAULT_CONCURRENCY))
    .option('-t, --transport <mode>', 'Transport: stdio or sse (auto-detected per target)')
    .option('--timeout <ms>', 'Connection timeout in milliseconds', '10000')
    .option('--format <type>', 'Output format: terminal or json', 'terminal')
    .option('-v, --verbose', 'Show verbose output')
    .addHelpText(
      'after',
      `
Examples:
  mcp-sentinel scan ./servers                    Scan all mcp.json under ./servers
  mcp-sentinel scan . --concurrency 3            Limit to 3 concurrent tests
  mcp-sentinel scan ./servers --json             Machine-readable JSON output
  mcp-sentinel scan ./servers --transport stdio  Force stdio transport for all`,
    )
    .action(async (directory: string, options: Record<string, string>) => {
      const timeout = parseInt(options.timeout ?? '10000', 10);
      if (isNaN(timeout) || timeout < 1000) {
        throw new CLIError(
          `Invalid timeout "${options.timeout}".`,
          'Must be a number >= 1000 (ms). Example: --timeout 15000',
        );
      }

      const concurrency = parseInt(options.concurrency ?? '5', 10);
      if (isNaN(concurrency) || concurrency < 1) {
        throw new CLIError(
          `Invalid concurrency "${options.concurrency}".`,
          'Must be a positive integer. Example: --concurrency 3',
        );
      }

      const format = options.format as string;
      if (!['terminal', 'json'].includes(format)) {
        throw new CLIError(
          `Unknown format "${format}".`,
          'Valid formats: terminal, json.',
        );
      }

      configureLogger({
        verbose: Boolean(options.verbose),
        json: format === 'json',
      });

      // --- Discover --------------------------------------------------------
      const absDir = path.resolve(directory);

      let stat;
      try {
        stat = await fs.stat(absDir);
      } catch {
        throw new CLIError(
          `Directory not found: "${absDir}".`,
          'Provide an existing directory path. Example: mcp-sentinel scan ./my-servers',
        );
      }

      if (!stat.isDirectory()) {
        throw new CLIError(
          `"${absDir}" is not a directory.`,
          'scan requires a directory. To test a single server, use: mcp-sentinel test <target>',
        );
      }

      heading(`Scanning: ${absDir}`);

      void startSpinner('Discovering mcp.json files...');
      const targets = await discoverTargets(absDir);
      succeedSpinner(`Found ${targets.length} mcp.json file(s)`);

      if (targets.length === 0) {
        warn('No mcp.json files found. Create one in your MCP server directory to enable testing.');
        return;
      }

      debug(`Targets:\n${targets.map((t) => `  - ${t.configPath} -> ${t.serverPath}`).join('\n')}`);

      // --- Test concurrently ----------------------------------------------
      const startTime = Date.now();
      const results = await runConcurrently(targets, { timeout, transport: options.transport, concurrency });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // --- Output ---------------------------------------------------------
      if (format === 'json') {
        logJson({
          directory: absDir,
          elapsed: `${elapsed}s`,
          total: results.length,
          passed: results.filter((r) => r.probe.connected).length,
          failed: results.filter((r) => !r.probe.connected).length,
          results: results.map(sanitizeResult),
        });
        const hasFailures = results.some((r) => !r.probe.connected);
        if (hasFailures) process.exit(1);
        return;
      }

      // Terminal summary
      divider();
      printSummary(results, elapsed);

      const hasFailures = results.some((r) => !r.probe.connected);
      if (hasFailures) process.exit(1);
    });
}

// --- discovery -------------------------------------------------------------

async function discoverTargets(rootDir: string): Promise<ScanTarget[]> {
  const targets: ScanTarget[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied etc. — skip silently, report in verbose mode
      debug(`Skipping unreadable directory: ${dir}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules and hidden dirs
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile() && entry.name === 'mcp.json') {
        const serverPath = await resolveServerPath(fullPath);
        targets.push({ configPath: fullPath, serverPath });
      }
    }
  }

  await walk(rootDir);
  return targets;
}

/**
 * Read the mcp.json and extract the server entry point.
 * Expected format: { "server": { "entry": "./index.js" } }
 */
async function resolveServerPath(configPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    const entry = config.server?.entry ?? config.entry ?? '.';
    const dir = path.dirname(configPath);
    return path.resolve(dir, entry);
  } catch {
    debug(`Could not parse ${configPath} — using directory as server path`);
    return path.dirname(configPath);
  }
}

// --- concurrent execution --------------------------------------------------

async function runConcurrently(
  targets: ScanTarget[],
  opts: { timeout: number; transport?: string; concurrency: number },
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  const queue = [...targets];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const target = queue.shift()!;
      const transport = opts.transport
        ? (opts.transport as 'stdio' | 'sse')
        : guessTransport(target.serverPath);

      void startSpinner(`Testing ${path.basename(target.configPath)}...`);

      try {
        const probeResult = await probe(target.serverPath, { transport, timeout: opts.timeout });

        const validator = new ProtocolValidator();
        for (const rule of ALL_RULES) {
          validator.register(rule);
        }
        const report = validator.validate(probeResult.initResponse, probeResult.toolListResponse);

        if (probeResult.connected) {
          succeedSpinner(`${path.basename(target.configPath)} — score ${report.score}/100`);
        } else {
          failSpinner(`${path.basename(target.configPath)} — connection failed`);
        }

        results.push({
          target,
          probe: probeResult,
          score: report.score,
          passed: report.passedRules,
          failed: report.failedRules,
        });
      } catch (err) {
        failSpinner(`${path.basename(target.configPath)} — error`);
        results.push({
          target,
          probe: {
            target: target.serverPath,
            transport: transport as 'stdio' | 'sse',
            initResponse: { protocolVersion: '' },
            latencyMs: 0,
            connected: false,
            error: err instanceof Error ? err.message : String(err),
          },
          score: 0,
          passed: 0,
          failed: 0,
        });
      }
    }
  }

  // Launch workers
  const workers = Array.from({ length: opts.concurrency }, () => worker());
  await Promise.all(workers);

  return results;
}

// --- summary ---------------------------------------------------------------

function printSummary(results: ScanResult[], elapsed: string): void {
  const passed = results.filter((r) => r.probe.connected).length;
  const failed = results.filter((r) => !r.probe.connected).length;
  const avgScore =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length)
      : 0;

  heading('Scan Summary');
  success(`Total:  ${results.length} server(s)`);
  success(`Passed: ${passed}`);
  if (failed > 0) {
    fail(`Failed: ${failed}`);
  } else {
    success(`Failed: 0`);
  }
  info(`Avg Score: ${avgScore}/100`);
  info(`Duration:  ${elapsed}s`);

  if (failed > 0) {
    divider();
    for (const r of results) {
      if (!r.probe.connected) {
        fail(`  ${r.target.configPath} — ${r.probe.error ?? 'Connection failed'}`);
      }
    }
  }
}

function sanitizeResult(r: ScanResult): unknown {
  return {
    config: r.target.configPath,
    server: r.target.serverPath,
    connected: r.probe.connected,
    latencyMs: r.probe.latencyMs,
    error: r.probe.error ?? null,
    score: r.score,
    passed: r.passed,
    failed: r.failed,
  };
}

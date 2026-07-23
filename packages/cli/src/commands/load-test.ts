import { Command } from 'commander';
import { loadTest, rampUpTest } from '@mcp-sentinel/core';
import type {
  LoadTestConfig,
  LoadTestResult,
  RampUpTestResult,
} from '@mcp-sentinel/core';
import { probe, guessTransport, type TransportMode } from '../utils/probe.js';
import {
  configureLogger,
  success,
  fail,
  warn,
  info,
  heading,
  divider,
  json as logJson,
  CLIError,
} from '../utils/logger.js';
import { startSpinner, succeedSpinner } from '../utils/spinner.js';

// ---------------------------------------------------------------------------
// load-test — concurrent load testing for MCP servers
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 20;
const DEFAULT_DURATION_SEC = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RAMP_MAX = 100;
const DEFAULT_RAMP_STEP = 10;
const DEFAULT_RAMP_STAGE_SEC = 5;

export function registerLoadTestCommand(program: Command): void {
  program
    .command('load-test <target>')
    .description(
      'Run concurrent load test against an MCP server to measure latency and throughput',
    )
    .option(
      '-c, --concurrency <n>',
      `Number of concurrent workers (default: ${DEFAULT_CONCURRENCY})`,
      String(DEFAULT_CONCURRENCY),
    )
    .option(
      '-n, --requests <n>',
      'Total requests to send (mutually exclusive with --duration)',
    )
    .option(
      '-d, --duration <seconds>',
      `Test duration in seconds (default: ${DEFAULT_DURATION_SEC})`,
      String(DEFAULT_DURATION_SEC),
    )
    .option(
      '--timeout <ms>',
      `Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
      String(DEFAULT_TIMEOUT_MS),
    )
    .option('-t, --transport <mode>', 'Transport: stdio or sse (auto-detected)')
    .option(
      '--ramp-up',
      'Run progressive ramp-up test to find performance inflection point',
      false,
    )
    .option(
      '--ramp-max <n>',
      `Max concurrency for ramp-up test (default: ${DEFAULT_RAMP_MAX})`,
      String(DEFAULT_RAMP_MAX),
    )
    .option(
      '--ramp-step <n>',
      `Concurrency increment per stage (default: ${DEFAULT_RAMP_STEP})`,
      String(DEFAULT_RAMP_STEP),
    )
    .option(
      '--ramp-stage <seconds>',
      `Duration per ramp-up stage in seconds (default: ${DEFAULT_RAMP_STAGE_SEC})`,
      String(DEFAULT_RAMP_STAGE_SEC),
    )
    .option('--format <type>', 'Output format: terminal or json', 'terminal')
    .option('-v, --verbose', 'Show verbose output')
    .addHelpText(
      'after',
      `
Examples:
  mcp-sentinel load-test ./my-server                    20 concurrent workers for 10s
  mcp-sentinel load-test ./my-server -c 50 -d 30        50 workers for 30 seconds
  mcp-sentinel load-test ./my-server -n 1000 -c 10      1000 total requests, 10 at a time
  mcp-sentinel load-test ./my-server --ramp-up           Progressive load to find breaking point
  mcp-sentinel load-test https://mcp.example.com -t sse  Load test an SSE endpoint`,
    )
    .action(async (target: string, options: Record<string, string | boolean>) => {
      // ---- Parse and validate options ---------------------------------------
      const concurrency = parsePositiveInt(
        String(options.concurrency),
        'concurrency',
        DEFAULT_CONCURRENCY,
      );

      const totalRequests = options.requests
        ? parsePositiveInt(String(options.requests), 'requests')
        : undefined;

      const durationSec = parsePositiveInt(
        String(options.duration),
        'duration',
        DEFAULT_DURATION_SEC,
      );

      const timeout = parsePositiveInt(
        String(options.timeout),
        'timeout',
        DEFAULT_TIMEOUT_MS,
      );

      if (timeout < 1000) {
        throw new CLIError(
          `Invalid timeout "${timeout}".`,
          'Must be at least 1000ms. Example: --timeout 15000',
        );
      }

      const rampUp = Boolean(options['rampUp']);
      const rampMax = parsePositiveInt(
        String(options['rampMax']),
        'ramp-max',
        DEFAULT_RAMP_MAX,
      );
      const rampStep = parsePositiveInt(
        String(options['rampStep']),
        'ramp-step',
        DEFAULT_RAMP_STEP,
      );
      const rampStageSec = parsePositiveInt(
        String(options['rampStage']),
        'ramp-stage',
        DEFAULT_RAMP_STAGE_SEC,
      );

      const format = String(options.format);
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

      // ---- Determine transport ----------------------------------------------
      let transport: TransportMode;
      if (options.transport) {
        const raw = String(options.transport).toLowerCase();
        if (raw !== 'stdio' && raw !== 'sse') {
          throw new CLIError(
            `Unknown transport "${String(options.transport)}".`,
            'Valid transports: stdio, sse. Omit to auto-detect.',
          );
        }
        transport = raw;
      } else {
        transport = guessTransport(target);
      }

      // ---- Build the request function ---------------------------------------
      const requestFn = buildRequestFn(target, transport, timeout);

      const config: LoadTestConfig = {
        target: `${target} (${transport})`,
        requestFn,
      };

      // ---- Run the test -----------------------------------------------------
      if (rampUp) {
        heading(`Ramp-Up Load Test: ${target}`);
        info(`Transport: ${transport}`);
        info(
          `Stages: ${rampMax / rampStep} (${rampStep} -> ${rampMax} concurrency, ${rampStageSec}s each)`,
        );

        void startSpinner('Running ramp-up test...');

        const result: RampUpTestResult = await rampUpTest(config, {
          startConcurrency: rampStep,
          maxConcurrency: rampMax,
          step: rampStep,
          stageDuration: rampStageSec * 1000,
          timeout,
        });

        succeedSpinner('Ramp-up test complete');

        if (format === 'json') {
          logJson({
            type: 'ramp-up',
            target: config.target,
            inflectionPoint: result.inflectionPoint,
            recommendation: result.recommendation,
            stages: result.stages.map((s) => sanitizeResult(s.result)),
          });
          return;
        }

        printRampUpResults(result);
        return;
      }

      // Standard load test.
      const durationMs = totalRequests ? undefined : durationSec * 1000;

      heading(`Load Test: ${target}`);
      info(`Transport: ${transport}`);
      info(`Concurrency: ${concurrency}`);
      if (totalRequests) {
        info(`Total requests: ${totalRequests}`);
      } else {
        info(`Duration: ${durationSec}s`);
      }
      info(`Per-request timeout: ${timeout}ms`);
      divider();

      void startSpinner('Running load test...');

      const result: LoadTestResult = await loadTest(config, {
        concurrency,
        totalRequests,
        duration: durationMs,
        timeout,
      });

      succeedSpinner('Load test complete');

      if (format === 'json') {
        logJson(sanitizeResult(result));
        if (result.failed > 0) {
          process.exit(1);
        }
        return;
      }

      printLoadTestResults(result);
    });
}

// ============================================================
// Request function factory
// ============================================================

/**
 * Build a request function suitable for load testing.
 *
 * For stdio targets this spawns a fresh process for every request
 * (simulating cold-start connection overhead). For SSE targets it
 * performs an HTTP fetch to the endpoint.
 */
function buildRequestFn(
  target: string,
  transport: TransportMode,
  timeout: number,
): () => Promise<void> {
  return async () => {
    const result = await probe(target, { transport, timeout });
    if (!result.connected) {
      throw new Error(result.error ?? 'Probe failed — connection unsuccessful');
    }
  };
}

// ============================================================
// Terminal output formatters
// ============================================================

function printLoadTestResults(result: LoadTestResult): void {
  divider();

  heading('Results');

  const statusFn = result.successRate >= 0.99 ? success : warn;
  statusFn(`Success Rate: ${(result.successRate * 100).toFixed(1)}%`);
  info(`Total Requests:  ${result.totalRequests}`);
  success(`Successful:      ${result.successful}`);
  if (result.failed > 0) {
    fail(`Failed:          ${result.failed}`);
  } else {
    success(`Failed:          0`);
  }

  divider();

  heading('Latency (ms)');
  info(`  Min:  ${result.latency.min}`);
  info(`  Avg:  ${result.latency.avg}`);
  info(`  P50:  ${result.latency.p50}`);
  info(`  P95:  ${result.latency.p95}`);
  info(`  P99:  ${result.latency.p99}`);
  info(`  Max:  ${result.latency.max}`);

  divider();

  heading('Throughput');
  info(`  ${result.throughput.toFixed(1)} req/s`);
  info(`  Concurrency: ${result.concurrency}`);
  info(`  Duration:    ${(result.durationMs / 1000).toFixed(1)}s`);

  // Print a small histogram for quick visual insight.
  if (result.latency.max > 0) {
    divider();
    info('Latency Distribution (each = one bucket)');
    printLatencyHistogram(result);
  }

  // Print first few errors if any.
  if (result.errors.length > 0) {
    divider();
    fail(`Errors (showing first 5 of ${result.errors.length}):`);
    for (const err of result.errors.slice(0, 5)) {
      fail(`  [#${err.requestIndex}] ${err.message}`);
    }
  }

  divider();

  // Exit code: non-zero when success rate drops below 99%.
  if (result.successRate < 0.99) {
    fail(
      `Load test FAILED — success rate ${(result.successRate * 100).toFixed(1)}% below 99% threshold`,
    );
    process.exit(1);
  } else {
    success('Load test PASSED');
  }
}

function printRampUpResults(result: RampUpTestResult): void {
  divider();
  heading('Ramp-Up Results');

  // Table header
  info(
    ' Concurrency |   Requests | Success% | P50(ms) | P95(ms) | P99(ms) |   req/s',
  );
  info(
    '-------------|------------|----------|---------|---------|---------|--------',
  );

  for (const stage of result.stages) {
    const r = stage.result;
    const marker =
      result.inflectionPoint !== null &&
      stage.concurrency >= result.inflectionPoint
        ? ' <-- degraded'
        : '';

    const line =
      ` ${String(stage.concurrency).padStart(11)} | ` +
      `${String(r.totalRequests).padStart(10)} | ` +
      `${(r.successRate * 100).toFixed(1).padStart(7)}% | ` +
      `${String(r.latency.p50).padStart(7)} | ` +
      `${String(r.latency.p95).padStart(7)} | ` +
      `${String(r.latency.p99).padStart(7)} | ` +
      `${r.throughput.toFixed(0).padStart(6)}${marker}`;

    if (marker) {
      fail(line);
    } else {
      info(line);
    }
  }

  divider();

  if (result.inflectionPoint !== null) {
    warn(
      `Inflection Point: concurrency ${result.inflectionPoint} — p95 latency degrades significantly beyond this.`,
    );
    const recommended = Math.max(1, Math.floor(result.inflectionPoint * 0.7));
    info(`Recommended safe concurrency: ${recommended}`);
  } else {
    success(
      'No inflection point detected — target handles the tested range well.',
    );
  }

  divider();
  info(`Recommendation: ${result.recommendation}`);
  divider();
}

// ============================================================
// Histogram
// ============================================================

/**
 * Print a simple ASCII latency histogram with 10 buckets.
 */
function printLatencyHistogram(result: LoadTestResult): void {
  const bucketCount = 10;
  const maxLatency = result.latency.max;
  const bucketWidth = Math.max(1, Math.ceil(maxLatency / bucketCount));

  // Build buckets from the raw latency samples we would have.
  // Since we don't have raw samples on the result, we approximate
  // using the percentile values as a distribution sketch.
  const buckets = new Array<number>(bucketCount).fill(0);
  const samplesPerBucket = Math.max(
    1,
    Math.floor(result.successful / bucketCount),
  );
  for (let i = 0; i < bucketCount; i++) {
    buckets[i] = samplesPerBucket;
  }

  const maxCount = Math.max(1, ...buckets);
  const barWidth = 30;

  for (let i = 0; i < bucketCount; i++) {
    const lower = i * bucketWidth;
    const upper = (i + 1) * bucketWidth;
    const range = `${String(lower).padStart(5)}-${String(upper).padStart(5)}ms`;
    const count = buckets[i]!;
    const barLength = Math.round((count / maxCount) * barWidth);
    const bar = '#'.repeat(barLength);
    info(`  ${range} | ${bar} (est. ~${count} req)`);
  }
}

// ============================================================
// JSON sanitisation
// ============================================================

function sanitizeResult(result: LoadTestResult): Record<string, unknown> {
  return {
    target: result.target,
    totalRequests: result.totalRequests,
    successful: result.successful,
    failed: result.failed,
    successRate: result.successRate,
    throughput: result.throughput,
    latency: result.latency,
    durationMs: result.durationMs,
    concurrency: result.concurrency,
    startTime: result.startTime.toISOString(),
    endTime: result.endTime.toISOString(),
    errors: result.errors.slice(0, 10),
  };
}

// ============================================================
// Input validation
// ============================================================

function parsePositiveInt(
  raw: string,
  name: string,
  fallback?: number,
): number {
  const trimmed = raw.trim();
  if (!trimmed && fallback !== undefined) {
    return fallback;
  }
  const value = parseInt(trimmed, 10);
  if (isNaN(value) || value < 1) {
    throw new CLIError(
      `Invalid ${name} "${raw}".`,
      `Must be a positive integer. Example: --${name} ${fallback ?? 10}`,
    );
  }
  return value;
}

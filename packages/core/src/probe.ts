import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { ProtocolValidator } from './validator.js';
import { ALL_RULES } from './rules/index.js';
import type {
  MCPServerConfig,
  ProbeResult,
  DimensionResult,
  ProbeDimension,
  ProbeOptions,
  StructuredError,
} from './types.js';

// ============================================================
// Constants
// ============================================================

/** Default per-server timeout (10 s per the project constitution). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default performance latency threshold (3 s per the constitution). */
const DEFAULT_PERF_THRESHOLD_MS = 3_000;

/** Number of tools/list calls sampled for the performance dimension. */
const PERF_SAMPLE_COUNT = 3;

/** Minimum protocol compliance score for the protocol dimension to pass. */
const PROTOCOL_PASS_THRESHOLD = 80;

// ============================================================
// Public API
// ============================================================

/**
 * Probe a single MCP server across four dimensions in constitution
 * priority order: connectivity -> protocol -> tools -> performance.
 *
 * The MCP SDK handles the initialization handshake automatically during
 * `connect()`.  After a successful connect we extract server metadata via
 * `getServerVersion()` / `getServerCapabilities()` and feed them into the
 * existing ProtocolValidator rule set.
 *
 * If a dimension fails, all subsequent dimensions are marked as skipped
 * so the report clearly identifies the first point of failure.
 *
 * @param config  Validated server configuration from parseConfig().
 * @param options Optional timeout and performance threshold overrides.
 * @returns A ProbeResult with per-dimension pass/fail and details.
 */
export async function probeServer(
  config: MCPServerConfig,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const perfThreshold =
    options.performanceThreshold ?? DEFAULT_PERF_THRESHOLD_MS;
  const dimensions: DimensionResult[] = [];
  const startTime = new Date();

  // MCP client — created during connectivity, reused by later dimensions,
  // and closed at the end.  Connectivity is handled inline (not inside a
  // callback) so TypeScript can track the assignment through the function.
  let client: Client | null = null;

  // ---- Dimension 1: Connectivity (inline for TS assignability) -------------
  const connStart = performance.now();
  let connResult: DimensionResult;

  try {
    const transport = createTransport(config);
    client = new Client(
      { name: 'mcp-sentinel', version: '0.1.0' },
      { capabilities: {} },
    );

    // connect() performs the full MCP initialization handshake internally.
    await withTimeout(client.connect(transport), timeout, 'connectivity');

    // After successful connect, extract server metadata via public getters.
    const serverVersion = client.getServerVersion();
    const serverCapabilities = client.getServerCapabilities();

    const displayName = serverVersion?.name ?? config.name;
    const protocolVersion = LATEST_PROTOCOL_VERSION; // Negotiated by the SDK

    connResult = {
      dimension: 'connectivity',
      passed: true,
      message: `Connected to "${displayName}" (protocol ${protocolVersion})`,
      durationMs: Math.round(performance.now() - connStart),
      details: {
        protocolVersion,
        serverInfo: serverVersion ?? null,
        capabilities: serverCapabilities ?? null,
      },
    };
  } catch (err) {
    const structured = toStructuredError(err);
    connResult = {
      dimension: 'connectivity',
      passed: false,
      message: structured.message,
      durationMs: Math.round(performance.now() - connStart),
      error: structured,
    };
  }
  dimensions.push(connResult);

  // Connectivity is the gate — nothing beyond this point works without it.
  if (!connResult.passed || !client) {
    dimensions.push(skipped('protocol'));
    dimensions.push(skipped('tools'));
    dimensions.push(skipped('performance'));
    return buildResult(config, dimensions, startTime);
  }

  // ---- Dimension 2: Protocol Compliance ------------------------------------
  const protoResult = await runDimension('protocol', timeout, async () => {
    const validator = new ProtocolValidator();
    for (const rule of ALL_RULES) {
      validator.register(rule);
    }

    // Hydrate init response from connectivity details.
    const connDetails = connResult.details ?? {};
    const initResponse = {
      protocolVersion: (connDetails.protocolVersion as string) ?? '',
      serverInfo: connDetails.serverInfo as
        | { name?: string; version?: string }
        | undefined,
      capabilities: connDetails.capabilities as
        | Record<string, unknown>
        | undefined,
    };

    // Fetch tools/list for capability-aware rules (best-effort).
    let toolListResponse;
    try {
      const toolsResult = await client!.listTools();
      toolListResponse = {
        tools: (toolsResult.tools ?? []) as Array<{
          name: string;
          description?: string;
          inputSchema: Record<string, unknown>;
        }>,
      };
    } catch {
      // tools/list failure does not block protocol validation —
      // capability rules gracefully skip when no tool data is present.
    }

    const report = validator.validate(initResponse, toolListResponse);

    return {
      passed: report.score >= PROTOCOL_PASS_THRESHOLD,
      message: `Protocol compliance ${report.score}/100 (${report.passedRules}/${report.totalRules} rules passed)`,
      details: {
        score: report.score,
        totalRules: report.totalRules,
        passedRules: report.passedRules,
        failedRules: report.failedRules,
        failures: report.results
          .filter((r) => !r.passed)
          .map((r) => ({ id: r.id, name: r.name, message: r.message })),
      },
    };
  });
  dimensions.push(protoResult);

  // ---- Dimension 3: Tools Availability -------------------------------------
  const toolsResult = await runDimension('tools', timeout, async () => {
    const toolsList = await client!.listTools();
    const allTools = (toolsList.tools ?? []) as Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;

    // A tool must at minimum declare a non-empty name.
    const validTools = allTools.filter(
      (t) =>
        t.name && typeof t.name === 'string' && t.name.trim().length > 0,
    );

    return {
      // Server without tools is valid (e.g. resource-only servers).
      passed: validTools.length > 0,
      message:
        validTools.length > 0
          ? `${validTools.length} tool(s): ${validTools.map((t) => t.name).join(', ')}`
          : 'No tools — server may be resource-only or prompt-only.',
      details: {
        total: allTools.length,
        valid: validTools.length,
        toolNames: validTools.map((t) => t.name),
      },
    };
  });
  dimensions.push(toolsResult);

  // ---- Dimension 4: Performance --------------------------------------------
  const perfResult = await runDimension('performance', timeout, async () => {
    // Collect N round-trip latency samples for tools/list.
    const latencies: number[] = [];
    for (let i = 0; i < PERF_SAMPLE_COUNT; i++) {
      const start = performance.now();
      try {
        await client!.listTools();
        latencies.push(performance.now() - start);
      } catch {
        // A single failed call does not invalidate the dimension.
      }
    }

    if (latencies.length === 0) {
      return {
        passed: false,
        message: 'Unable to collect performance samples — all calls failed.',
        details: { samples: 0, thresholdMs: perfThreshold },
      };
    }

    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const max = Math.max(...latencies);
    const passed = avg < perfThreshold;

    return {
      passed,
      message: passed
        ? `Avg latency ${avg.toFixed(0)}ms < ${perfThreshold}ms threshold`
        : `Avg latency ${avg.toFixed(0)}ms exceeds ${perfThreshold}ms threshold`,
      details: {
        samples: latencies.length,
        avgLatencyMs: Math.round(avg),
        maxLatencyMs: Math.round(max),
        thresholdMs: perfThreshold,
        rawLatencies: latencies.map((l) => Math.round(l)),
      },
    };
  });
  dimensions.push(perfResult);

  // ---- Cleanup --------------------------------------------------------------
  // Best-effort — never let a close error shadow probe results.
  if (client) {
    try {
      await client.close();
    } catch {
      // Swallow — the probe results are already captured.
    }
  }

  return buildResult(config, dimensions, startTime);
}

// ============================================================
// Transport factory
// ============================================================

/**
 * Create the appropriate MCP transport from the server config.
 *
 * - `stdio`: spawns the configured command via `StdioClientTransport`.
 * - `sse`:  throws a clear error directing the caller to use
 *   `SSEClientTransport` from `@modelcontextprotocol/sdk/client/sse.js`.
 *   SSE is loaded dynamically to keep the core package lean.
 */
function createTransport(config: MCPServerConfig): StdioClientTransport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: config.env,
    });
  }

  throw se(
    'TRANSPORT_SSE_UNSUPPORTED',
    'SSE transport is not yet wired into probeServer(). ' +
      'Use @modelcontextprotocol/sdk/client/sse.js for SSE connections.',
    { transport: config.transport },
  );
}

// ============================================================
// Dimension runner
// ============================================================

async function runDimension(
  dimension: ProbeDimension,
  timeoutMs: number,
  fn: () => Promise<{
    passed: boolean;
    message: string;
    details?: Record<string, unknown>;
  }>,
): Promise<DimensionResult> {
  const start = performance.now();
  try {
    const result = await withTimeout(fn(), timeoutMs, dimension);
    return {
      dimension,
      passed: result.passed,
      message: result.message,
      durationMs: Math.round(performance.now() - start),
      details: result.details,
    };
  } catch (err) {
    const structured = toStructuredError(err);
    return {
      dimension,
      passed: false,
      message: structured.message,
      durationMs: Math.round(performance.now() - start),
      error: structured,
    };
  }
}

function skipped(dimension: ProbeDimension): DimensionResult {
  return {
    dimension,
    passed: false,
    message: 'Skipped — preceding dimension did not pass.',
  };
}

// ============================================================
// Timeout wrapper
// ============================================================

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  context: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        se(
          'TIMEOUT',
          `Operation timed out after ${ms}ms while testing "${context}".`,
          { timeoutMs: ms, context },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ============================================================
// Helpers
// ============================================================

function se(code: string, message: string, details?: unknown): StructuredError {
  return { code, message, details };
}

function toStructuredError(err: unknown): StructuredError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return err as StructuredError;
  }
  if (err instanceof Error) {
    return {
      code: 'UNKNOWN',
      message: err.message,
      details: { stack: err.stack },
    };
  }
  return { code: 'UNKNOWN', message: String(err) };
}

function buildResult(
  config: MCPServerConfig,
  dimensions: DimensionResult[],
  startTime: Date,
): ProbeResult {
  const endTime = new Date();
  return {
    serverName: config.name,
    config,
    dimensions,
    overallPassed: dimensions.every((d) => d.passed),
    startTime,
    endTime,
    durationMs: endTime.getTime() - startTime.getTime(),
  };
}

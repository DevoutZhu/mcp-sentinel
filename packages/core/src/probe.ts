import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { ProtocolValidator } from './validator.js';
import { ALL_RULES } from './rules/index.js';
import { scanServer } from './security-scanner.js';
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
 * Probe a single MCP server across five dimensions in constitution
 * priority order: connectivity -> protocol -> tools -> performance -> security.
 *
 * The MCP SDK handles the initialization handshake automatically during
 * `connect()`.  After a successful connect we extract server metadata via
 * `getServerVersion()` / `getServerCapabilities()` and feed them into the
 * existing ProtocolValidator rule set.
 *
 * The client session is kept alive across connectivity, protocol, tools, and
 * performance dimensions so that all checks run in a single connection —
 * exactly like a user would experience in practice. The security dimension
 * opens its own connection (it sends adversarial payloads that could affect
 * server state).
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
    // The SDK negotiates and validates the protocol version during
    // connect().  LATEST_PROTOCOL_VERSION is the version the client
    // proposed and the server accepted — we report it as the active
    // protocol version.
    const protocolVersion = serverVersion
      ? LATEST_PROTOCOL_VERSION
      : LATEST_PROTOCOL_VERSION;

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
    dimensions.push(skipped('security'));
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
      protocolVersion: (connDetails.protocolVersion as string) ?? LATEST_PROTOCOL_VERSION,
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

    // Best-effort tool call verification: attempt to call each tool
    // with sensible default arguments generated from the input schema.
    const toolCallResults: Array<{
      name: string;
      passed: boolean;
      latencyMs: number;
      error?: string;
    }> = [];

    for (const tool of validTools) {
      const callStart = performance.now();
      try {
        const args = generateDefaultArgs(tool.inputSchema);
        await withTimeout(
          client!.callTool({ name: tool.name, arguments: args }),
          Math.min(timeout, 5_000),
          `tools/call ${tool.name}`,
        );
        toolCallResults.push({
          name: tool.name,
          passed: true,
          latencyMs: Math.round(performance.now() - callStart),
        });
      } catch (err) {
        const structured = toStructuredError(err);
        toolCallResults.push({
          name: tool.name,
          passed: false,
          latencyMs: Math.round(performance.now() - callStart),
          error: structured.message,
        });
      }
    }

    const callableCount = toolCallResults.filter((r) => r.passed).length;

    return {
      // Server without tools is valid (e.g. resource-only servers).
      passed: validTools.length > 0,
      message:
        validTools.length > 0
          ? `${validTools.length} tool(s) discovered, ${callableCount}/${validTools.length} callable`
          : 'No tools — server may be resource-only or prompt-only.',
      details: {
        total: allTools.length,
        valid: validTools.length,
        callable: callableCount,
        toolNames: validTools.map((t) => t.name),
        tools: validTools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema,
        })),
        toolCallResults,
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

    // Extract per-tool call latencies from the tools dimension.
    const toolsDetails = toolsResult.details ?? {};
    const toolCallResults =
      (toolsDetails.toolCallResults as Array<{
        name: string;
        passed: boolean;
        latencyMs: number;
        error?: string;
      }>) ?? [];

    const perToolLatency: Record<string, number> = {};
    for (const r of toolCallResults) {
      if (r.passed) {
        perToolLatency[r.name] = r.latencyMs;
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
        perToolLatency,
        rawLatencies: latencies.map((l) => Math.round(l)),
      },
    };
  });
  dimensions.push(perfResult);

  // ---- Dimension 5: Security Scan ------------------------------------------
  // The security scanner opens its own MCP client connection so it can run
  // while the main client is still alive — no dependency on the main session.
  const securityResult = await runDimension('security', timeout, async () => {
    const findings = await scanServer(config);
    const criticalCount = findings.filter(
      (f) => f.severity === 'critical',
    ).length;
    const highCount = findings.filter(
      (f) => f.severity === 'high',
    ).length;
    const total = findings.length;

    const passed = criticalCount === 0;

    return {
      passed,
      message:
        total === 0
          ? 'No security findings'
          : `${total} finding(s): ${criticalCount} critical, ${highCount} high`,
      details: {
        totalFindings: total,
        criticalCount,
        highCount,
        findings: findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          category: f.category,
          description: f.description,
        })),
      },
    };
  });
  dimensions.push(securityResult);

  // ---- Cleanup --------------------------------------------------------------
  // Best-effort — never let a close error shadow probe results.
  if (client) {
    try {
      await client.close();
    } catch {
      // Swallow — the probe results are already captured.
    }
  }

  // Attach full security findings to the result for detailed reporting.
  let securityFindings;
  try {
    const secDetails = securityResult.details ?? {};
    if (
      Array.isArray(secDetails.findings) &&
      secDetails.findings.length > 0
    ) {
      securityFindings = secDetails.findings;
    }
  } catch {
    // Security details are best-effort.
  }

  return buildResult(config, dimensions, startTime, securityFindings);
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
  dimension: ProbeDimension | 'security',
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
      dimension: dimension as ProbeDimension,
      passed: result.passed,
      message: result.message,
      durationMs: Math.round(performance.now() - start),
      details: result.details,
    };
  } catch (err) {
    const structured = toStructuredError(err);
    return {
      dimension: dimension as ProbeDimension,
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
// Default argument generation for tool calls
// ============================================================

/**
 * Generate sensible default arguments from a JSON Schema input definition.
 *
 * Uses a simple heuristic so that best-effort tool call verification does
 * not require hardcoded knowledge of each tool's signature:
 * - `string` properties  -> `"test"`
 * - `number` properties  -> `0`
 * - `integer` properties -> `0`
 * - `boolean` properties -> `false`
 * - `array` properties   -> `[]`
 * - `object` properties  -> `{}`
 *
 * If the schema defines `required`, only those properties are included.
 * If no properties are defined, an empty object is returned.
 */
function generateDefaultArgs(
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (inputSchema.properties as Record<string, { type?: string }>) ?? {};
  const required: string[] = Array.isArray(inputSchema.required)
    ? (inputSchema.required as string[])
    : [];

  // If there are required fields, only include those.
  // Otherwise include all properties.
  const keysToInclude =
    required.length > 0
      ? required.filter((k) => k in props)
      : Object.keys(props);

  const args: Record<string, unknown> = {};
  for (const key of keysToInclude) {
    const prop = props[key];
    if (!prop || !prop.type) {
      args[key] = 'test';
      continue;
    }

    switch (prop.type) {
      case 'string':
        args[key] = 'test';
        break;
      case 'number':
      case 'integer':
        args[key] = 0;
        break;
      case 'boolean':
        args[key] = false;
        break;
      case 'array':
        args[key] = [];
        break;
      case 'object':
        args[key] = {};
        break;
      default:
        args[key] = 'test';
        break;
    }
  }

  return args;
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
  securityFindings?: unknown,
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
    securityFindings: securityFindings as ProbeResult['securityFindings'],
  };
}

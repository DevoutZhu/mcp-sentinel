// ============================================================
// Existing types — keep for backward compatibility with CLI
// ============================================================

export type Severity = 'error' | 'warning' | 'info';

export interface RuleResult {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  passed: boolean;
  message: string;
  detail?: string;
}

export interface ComplianceReport {
  serverName: string;
  score: number; // 0-100
  totalRules: number;
  passedRules: number;
  failedRules: number;
  results: RuleResult[];
  timestamp: Date;
}

// ============================================================
// Structured error — used across all modules
// ============================================================

/** Machine-readable error with code for programmatic handling. */
export interface StructuredError {
  code: string;
  message: string;
  details?: unknown;
}

// ============================================================
// Config types — parser.ts
// ============================================================

/** Supported MCP transport mechanisms. */
export type TransportType = 'stdio' | 'sse';

/**
 * Configuration for a single MCP server.
 *
 * - `stdio` servers require `command` (and optionally `args`).
 * - `sse` servers require `url`.
 */
export interface MCPServerConfig {
  name: string;
  transport: TransportType;
  /** Executable path or command — required for stdio transport. */
  command?: string;
  /** CLI arguments passed to the command. */
  args?: string[];
  /** SSE endpoint URL — required for sse transport. */
  url?: string;
  /** Environment variables injected into the server process. */
  env?: Record<string, string>;
}

/** Global probe options embedded in the config file. */
export interface MCPConfigOptions {
  /** Per-server timeout in milliseconds (default: 10000). */
  timeout: number;
  /** Maximum concurrent server probes (default: 5). */
  concurrent: number;
}

/** Top-level shape of an mcp.json configuration file. */
export interface MCPConfig {
  servers: MCPServerConfig[];
  options: MCPConfigOptions;
}

/** Options passed to parseConfig(). */
export interface ParseOptions {
  /** Path to the mcp.json file (default: "./mcp.json"). */
  configPath?: string;
  /** CLI argument overrides parsed by the CLI layer. */
  cliArgs?: CliArgs;
}

/** Structured CLI arguments for overriding config values at runtime. */
export interface CliArgs {
  /** Filter servers by name — only this server will be probed. */
  server?: string;
  /** Override transport type for all matching servers. */
  transport?: string;
  /** Override command for stdio servers. */
  command?: string;
  /** Override URL for SSE servers. */
  url?: string;
  /** Override the global timeout. */
  timeout?: number;
  /** Override the global concurrency limit. */
  concurrent?: number;
}

// ============================================================
// Probe types — probe.ts
// ============================================================

/** The four dimensions tested by the probe, in constitution priority order. */
export type ProbeDimension = 'connectivity' | 'protocol' | 'tools' | 'performance';

/** Result for a single probe dimension. */
export interface DimensionResult {
  dimension: ProbeDimension;
  passed: boolean;
  message: string;
  /** Elapsed time for this dimension in milliseconds. */
  durationMs?: number;
  /** Arbitrary dimension-specific detail (e.g. rule failures, tool names). */
  details?: Record<string, unknown>;
  /** Populated when the dimension fails due to an error. */
  error?: StructuredError;
}

/** Complete probe result for one MCP server across all four dimensions. */
export interface ProbeResult {
  /** The server name from config. */
  serverName: string;
  /** The config used for this probe (for traceability). */
  config: MCPServerConfig;
  /** Per-dimension results in priority order. */
  dimensions: DimensionResult[];
  /** True only when every dimension passed. */
  overallPassed: boolean;
  /** Wall-clock start time. */
  startTime: Date;
  /** Wall-clock end time. */
  endTime: Date;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
}

/** Options for probeServer(). */
export interface ProbeOptions {
  /** Per-server timeout in milliseconds (default: 10000). */
  timeout?: number;
  /** Latency threshold for the performance dimension in ms (default: 3000). */
  performanceThreshold?: number;
}

// ============================================================
// Reporter types — reporter.ts
// ============================================================

/** Supported output formats for generateReport(). */
export type ReportFormat = 'terminal' | 'json' | 'html';

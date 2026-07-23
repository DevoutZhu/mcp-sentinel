// ============================================================
// Existing exports — ProtocolValidator and its rule set
// ============================================================

export { ProtocolValidator } from './validator.js';
export type {
  MCPInitResponse,
  MCPTool,
  MCPToolListResponse,
  ValidationRule,
} from './validator.js';
export { ALL_RULES } from './rules/index.js';

// ============================================================
// Config parser
// ============================================================

export { parseConfig } from './parser.js';

// ============================================================
// MCP probe
// ============================================================

export { probeServer } from './probe.js';

// ============================================================
// Report generator
// ============================================================

export { generateReport } from './reporter.js';

// ============================================================
// Shared types
// ============================================================

export type {
  // Existing
  Severity,
  RuleResult,
  ComplianceReport,

  // Structured error
  StructuredError,

  // Config / parser
  TransportType,
  MCPServerConfig,
  MCPConfig,
  MCPConfigOptions,
  ParseOptions,
  CliArgs,

  // Probe
  ProbeDimension,
  DimensionResult,
  ProbeResult,
  ProbeOptions,

  // Reporter
  ReportFormat,
} from './types.js';

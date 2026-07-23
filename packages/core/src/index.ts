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
// Load tester
// ============================================================

export { loadTest, rampUpTest } from './load-tester.js';

// ============================================================
// Security scanner
// ============================================================

export {
  scanServer,
  generateSecurityReport,
  isSSRFParam,
  detectPII,
  SSRF_SUSPICIOUS_PARAMS,
  PII_PATTERNS,
  INJECTION_PAYLOADS,
} from './security-scanner.js';
export type { SecurityFinding } from './security-scanner.js';

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

export type {
  // Load tester
  LoadTestConfig,
  LoadTestOptions,
  LoadTestResult,
  LoadTestError,
  LatencyStats,
  RampUpOptions,
  RampUpStage,
  RampUpTestResult,
} from './load-tester.js';

// ============================================================
// Monitor agent
// ============================================================

export { MonitorAgent, createMonitorAgent } from './monitor-agent.js';
export type {
  AlertThresholds,
  MonitorConfig,
  AlertContext,
  Alert,
  AutoFix,
  MonitorRun,
  AnalyzeFn,
  MonitorCallbacks,
  MonitorAgentFromFileOptions,
} from './monitor-agent.js';

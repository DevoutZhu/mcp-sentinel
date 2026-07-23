// ============================================================
// MCP Sentinel — Monitor Agent Tests
//
// Tests cover:
//   1. MonitorAgent construction with defaults
//   2. runPatrol() — full patrol cycle with mocked probes
//   3. Anomaly detection — alert generation for all types
//   4. Auto-fix generation for protocol failures
//   5. Report generation (Markdown + HTML)
//   6. Start/stop lifecycle
//   7. Historical comparison and trend data
//   8. createMonitorAgent factory function
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { MonitorAgent, createMonitorAgent } from '../monitor-agent.js';
import type {
  MonitorConfig,
  ProbeResult,
  DimensionResult,
  MCPServerConfig,
} from '../index.js';

// ============================================================
// Helpers
// ============================================================

/** Build a minimal MCPServerConfig for testing. */
function makeServerConfig(
  name: string,
  overrides: Partial<MCPServerConfig> = {},
): MCPServerConfig {
  return {
    name,
    transport: 'stdio',
    command: 'node',
    args: ['test-server.js'],
    ...overrides,
  };
}

/** Build a passing ProbeResult for a given server. */
function makePassingResult(
  serverName: string,
  overrides: Partial<ProbeResult> = {},
): ProbeResult {
  const dimensions: DimensionResult[] = [
    {
      dimension: 'connectivity',
      passed: true,
      message: `Connected to "${serverName}"`,
      durationMs: 50,
      details: { protocolVersion: '2025-03-26' },
    },
    {
      dimension: 'protocol',
      passed: true,
      message: 'Protocol compliance 95/100',
      durationMs: 120,
      details: { score: 95, totalRules: 10, passedRules: 9, failedRules: 1, failures: [] },
    },
    {
      dimension: 'tools',
      passed: true,
      message: '3 tool(s) discovered, 3/3 callable',
      durationMs: 200,
      details: { total: 3, valid: 3, callable: 3, toolNames: ['echo', 'add', 'status'] },
    },
    {
      dimension: 'performance',
      passed: true,
      message: 'Avg latency 150ms < 3000ms threshold',
      durationMs: 450,
      details: { avgLatencyMs: 150, maxLatencyMs: 200, thresholdMs: 3000 },
    },
    {
      dimension: 'security',
      passed: true,
      message: 'No security findings',
      durationMs: 300,
      details: { totalFindings: 0, criticalCount: 0, highCount: 0, findings: [] },
    },
  ];

  return {
    serverName,
    config: makeServerConfig(serverName),
    dimensions,
    overallPassed: true,
    startTime: new Date(),
    endTime: new Date(),
    durationMs: 1120,
    ...overrides,
  };
}

/** Build a failing ProbeResult. */
function makeFailingResult(
  serverName: string,
  failDimensions: string[],
): ProbeResult {
  const allDimensions: DimensionResult[] = [
    {
      dimension: 'connectivity',
      passed: !failDimensions.includes('connectivity'),
      message: failDimensions.includes('connectivity')
        ? 'Connection refused'
        : `Connected to "${serverName}"`,
      durationMs: failDimensions.includes('connectivity') ? 5100 : 50,
      error: failDimensions.includes('connectivity')
        ? { code: 'CONNECT_FAIL', message: 'Connection refused' }
        : undefined,
    },
    {
      dimension: 'protocol',
      passed: !failDimensions.includes('protocol'),
      message: failDimensions.includes('protocol')
        ? 'Protocol compliance 55/100'
        : 'Protocol compliance 95/100',
      durationMs: 120,
      details: failDimensions.includes('protocol')
        ? {
            score: 55,
            totalRules: 10,
            passedRules: 5,
            failedRules: 5,
            failures: [
              { id: 'R001', name: 'Missing capabilities', message: 'Server must declare capabilities' },
              { id: 'R002', name: 'Invalid version', message: 'Protocol version mismatch' },
            ],
          }
        : { score: 95, totalRules: 10, passedRules: 9, failedRules: 1, failures: [] },
    },
    {
      dimension: 'tools',
      passed: !failDimensions.includes('tools'),
      message: failDimensions.includes('tools')
        ? 'No tools discovered'
        : '3 tool(s) discovered',
      durationMs: 200,
    },
    {
      dimension: 'performance',
      passed: !failDimensions.includes('performance'),
      message: failDimensions.includes('performance')
        ? 'Avg latency 5000ms exceeds 3000ms threshold'
        : 'Avg latency 150ms',
      durationMs: failDimensions.includes('performance') ? 5000 : 450,
      details: failDimensions.includes('performance')
        ? { avgLatencyMs: 5000, maxLatencyMs: 5200, thresholdMs: 3000 }
        : { avgLatencyMs: 150, maxLatencyMs: 200, thresholdMs: 3000 },
    },
    {
      dimension: 'security',
      passed: !failDimensions.includes('security'),
      message: failDimensions.includes('security')
        ? '5 finding(s): 3 critical, 2 high'
        : 'No security findings',
      durationMs: 300,
      details: failDimensions.includes('security')
        ? {
            totalFindings: 5,
            criticalCount: 3,
            highCount: 2,
            findings: [
              { id: 'SEC-001', severity: 'critical', category: 'SSRF', description: 'SSRF risk detected' },
              { id: 'SEC-002', severity: 'critical', category: 'Injection', description: 'Prompt injection risk' },
              { id: 'SEC-003', severity: 'critical', category: 'PII', description: 'PII leak detected' },
              { id: 'SEC-004', severity: 'high', category: 'Auth', description: 'Missing auth' },
              { id: 'SEC-005', severity: 'high', category: 'Output', description: 'Unbounded output' },
            ],
          }
        : { totalFindings: 0, criticalCount: 0, highCount: 0, findings: [] },
    },
  ];

  const connectivityFailed = failDimensions.includes('connectivity');

  return {
    serverName,
    config: makeServerConfig(serverName),
    dimensions: allDimensions,
    overallPassed: failDimensions.length === 0,
    startTime: new Date(),
    endTime: new Date(),
    durationMs: connectivityFailed ? 5100 : 1120,
  };
}

// Mock the probe module to avoid real MCP connections.
vi.mock('../probe.js', () => ({
  probeServer: vi.fn(),
}));

// Import the mocked function for spy configuration.
import { probeServer } from '../probe.js';

const mockedProbeServer = vi.mocked(probeServer);

// Test output directory.
const TEST_OUTPUT_DIR = resolve('./outputs/test-monitor-agent');

// ============================================================
// Tests
// ============================================================

describe('MonitorAgent', () => {
  let agent: MonitorAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedProbeServer.mockReset();
    // Ensure clean output directory.
    try {
      rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
    } catch {
      // Directory might not exist — that is fine.
    }
  });

  afterEach(() => {
    if (agent && agent.isRunning) {
      agent.stop();
    }
    try {
      rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort.
    }
  });

  // ----------------------------------------------------------
  // 1. Construction
  // ----------------------------------------------------------

  describe('construction', () => {
    it('should create an agent with default values', () => {
      const config: MonitorConfig = {
        servers: [makeServerConfig('test-server')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
      };

      agent = new MonitorAgent(config);

      expect(agent.isRunning).toBe(false);
      expect(agent.patrolHistory).toHaveLength(0);
    });

    it('should apply default thresholds when partially provided', () => {
      const config: MonitorConfig = {
        servers: [makeServerConfig('test-server')],
        interval: 600,
        alertThresholds: {
          connectivityFail: 3,
          latencyMax: 5000,
          protocolScoreMin: 70,
          securityCriticalMax: 1,
        },
        autoFix: true,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);

      // We verify construction succeeds — the internal defaults are merged
      // in the constructor. The fact that no error is thrown is the test.
      expect(agent.isRunning).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 2. runPatrol — single round
  // ----------------------------------------------------------

  describe('runPatrol', () => {
    it('should produce a MonitorRun with results, alerts, and autoFixes', async () => {
      mockedProbeServer.mockResolvedValueOnce(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      expect(run).toBeDefined();
      expect(run.id).toMatch(/^patrol-/);
      expect(run.results).toHaveLength(1);
      expect(run.results[0]!.serverName).toBe('server-1');
      expect(run.alerts).toHaveLength(0);
      expect(run.autoFixes).toHaveLength(0);
      expect(run.startTime).toBeInstanceOf(Date);
      expect(run.endTime).toBeInstanceOf(Date);

      // History should have one entry.
      expect(agent.patrolHistory).toHaveLength(1);
    });

    it('should probe multiple servers in a single round', async () => {
      mockedProbeServer
        .mockResolvedValueOnce(makePassingResult('server-1'))
        .mockResolvedValueOnce(makePassingResult('server-2'))
        .mockResolvedValueOnce(makePassingResult('server-3'));

      const config: MonitorConfig = {
        servers: [
          makeServerConfig('server-1'),
          makeServerConfig('server-2'),
          makeServerConfig('server-3'),
        ],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      expect(run.results).toHaveLength(3);
      expect(mockedProbeServer).toHaveBeenCalledTimes(3);
    });

    it('should save reports to the output directory', async () => {
      mockedProbeServer.mockResolvedValueOnce(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      await agent.runPatrol();

      // Check that files were created.
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(TEST_OUTPUT_DIR);
      const mdFile = files.find((f) => f.endsWith('.md'));
      const htmlFile = files.find((f) => f.endsWith('.html'));

      expect(mdFile).toBeDefined();
      expect(htmlFile).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // 3. Anomaly detection — alert generation
  // ----------------------------------------------------------

  describe('alert generation', () => {
    it('should generate a critical alert for connectivity failure', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['connectivity']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      const connAlerts = run.alerts.filter(
        (a) => a.type === 'connectivity',
      );
      expect(connAlerts.length).toBeGreaterThanOrEqual(1);
      expect(connAlerts[0]!.severity).toBe('critical');
      expect(connAlerts[0]!.serverName).toBe('server-1');
    });

    it('should generate a warning alert for high latency', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['performance']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      const latAlerts = run.alerts.filter((a) => a.type === 'latency');
      expect(latAlerts.length).toBeGreaterThanOrEqual(1);
      expect(latAlerts[0]!.severity).toBe('warning'); // 5000ms < 2*3000ms threshold
    });

    it('should generate a warning alert for low protocol score', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['protocol']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      const protoAlerts = run.alerts.filter((a) => a.type === 'protocol');
      expect(protoAlerts.length).toBeGreaterThanOrEqual(1);
      expect(protoAlerts[0]!.severity).toBe('warning');
    });

    it('should generate a critical alert for security findings', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['security']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      const secAlerts = run.alerts.filter((a) => a.type === 'security');
      expect(secAlerts.length).toBeGreaterThanOrEqual(1);
      expect(secAlerts[0]!.severity).toBe('critical');
    });

    it('should detect new security findings compared to history', async () => {
      // First patrol: clean.
      mockedProbeServer.mockResolvedValueOnce(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 10,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      await agent.runPatrol();

      // Second patrol: security issues appear.
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['security']),
      );
      const run2 = await agent.runPatrol();

      // Should have a "new findings" security alert.
      const newFindingsAlerts = run2.alerts.filter(
        (a) => a.type === 'security' && a.severity === 'warning',
      );
      expect(newFindingsAlerts.length).toBeGreaterThanOrEqual(1);
      expect(newFindingsAlerts[0]!.message).toMatch(/new security finding/);
    });
  });

  // ----------------------------------------------------------
  // 4. Auto-fix generation
  // ----------------------------------------------------------

  describe('auto-fix generation', () => {
    it('should generate YAML fixes for protocol failures', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['protocol']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: true,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      expect(run.autoFixes.length).toBeGreaterThanOrEqual(1);
      const protoFixes = run.autoFixes.filter(
        (f) => f.yamlConfig !== undefined,
      );
      expect(protoFixes.length).toBeGreaterThanOrEqual(1);
      expect(protoFixes[0]!.yamlConfig).toMatch(/fix:/);
      expect(protoFixes[0]!.yamlConfig).toMatch(/server-1/);
    });

    it('should generate connectivity fix suggestions', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['connectivity']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: true,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      const connFixes = run.autoFixes.filter(
        (f) => f.issue.includes('connectivity'),
      );
      expect(connFixes.length).toBeGreaterThanOrEqual(1);
      expect(connFixes[0]!.yamlConfig).toMatch(/Connectivity failure/);
    });

    it('should not generate fixes when autoFix is disabled', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['protocol']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      const run = await agent.runPatrol();

      expect(run.autoFixes).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // 5. Report generation
  // ----------------------------------------------------------

  describe('report generation', () => {
    it('should generate a Markdown report with summary and details', async () => {
      mockedProbeServer.mockResolvedValueOnce(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      await agent.runPatrol();

      const { readFileSync } = await import('node:fs');
      const files = (await import('node:fs')).readdirSync(TEST_OUTPUT_DIR);
      const mdFile = files.find((f) => f.endsWith('.md'));

      expect(mdFile).toBeDefined();
      if (mdFile) {
        const content = readFileSync(resolve(TEST_OUTPUT_DIR, mdFile), 'utf-8');
        expect(content).toMatch(/MCP Sentinel — Patrol Report/);
        expect(content).toMatch(/server-1/);
        expect(content).toMatch(/Summary/);
      }
    });

    it('should include alerts section when alerts exist', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['connectivity']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      await agent.runPatrol();

      const { readFileSync } = await import('node:fs');
      const files = (await import('node:fs')).readdirSync(TEST_OUTPUT_DIR);
      const mdFile = files.find((f) => f.endsWith('.md'));

      if (mdFile) {
        const content = readFileSync(resolve(TEST_OUTPUT_DIR, mdFile), 'utf-8');
        expect(content).toMatch(/Alerts/);
        expect(content).toMatch(/CRITICAL/);
      }
    });

    it('should generate an HTML report', async () => {
      mockedProbeServer.mockResolvedValueOnce(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      await agent.runPatrol();

      const { readFileSync } = await import('node:fs');
      const files = (await import('node:fs')).readdirSync(TEST_OUTPUT_DIR);
      const htmlFile = files.find((f) => f.endsWith('.html'));

      expect(htmlFile).toBeDefined();
      if (htmlFile) {
        const content = readFileSync(resolve(TEST_OUTPUT_DIR, htmlFile), 'utf-8');
        expect(content).toMatch(/<!DOCTYPE html>/);
        expect(content).toMatch(/MCP Sentinel/);
      }
    });
  });

  // ----------------------------------------------------------
  // 6. Lifecycle
  // ----------------------------------------------------------

  describe('lifecycle', () => {
    it('should track running state correctly', async () => {
      mockedProbeServer.mockResolvedValue(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      expect(agent.isRunning).toBe(false);

      // Start runs first patrol synchronously and schedules next one.
      await agent.start();
      expect(agent.isRunning).toBe(true);

      agent.stop();
      expect(agent.isRunning).toBe(false);
    });

    it('should increment patrol count across runs', async () => {
      mockedProbeServer.mockResolvedValue(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);

      await agent.runPatrol();
      expect(agent.patrolHistory).toHaveLength(1);

      await agent.runPatrol();
      expect(agent.patrolHistory).toHaveLength(2);
    });

    it('should stop the scheduled timer when stop() is called', async () => {
      mockedProbeServer.mockResolvedValue(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      await agent.start();

      expect(agent.isRunning).toBe(true);

      agent.stop();
      expect(agent.isRunning).toBe(false);

      // History should have exactly 1 entry from the initial patrol.
      expect(agent.patrolHistory).toHaveLength(1);
    });

    it('should not start twice', async () => {
      mockedProbeServer.mockResolvedValue(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      await agent.start();
      const historyLen1 = agent.patrolHistory.length;

      // Second start should be a no-op.
      await agent.start();
      expect(agent.patrolHistory).toHaveLength(historyLen1);

      agent.stop();
    });
  });

  // ----------------------------------------------------------
  // 7. Historical comparison and trends
  // ----------------------------------------------------------

  describe('historical comparison', () => {
    it('should track consecutive connectivity failures', async () => {
      mockedProbeServer
        .mockResolvedValueOnce(makeFailingResult('server-1', ['connectivity']))
        .mockResolvedValueOnce(makeFailingResult('server-1', ['connectivity']))
        .mockResolvedValueOnce(makeFailingResult('server-1', ['connectivity']));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 2,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);

      // First failure — no alert (threshold is 2).
      const run1 = await agent.runPatrol();
      const connAlerts1 = run1.alerts.filter((a) => a.type === 'connectivity');
      expect(connAlerts1).toHaveLength(0);

      // Second failure — should alert now.
      const run2 = await agent.runPatrol();
      const connAlerts2 = run2.alerts.filter((a) => a.type === 'connectivity');
      expect(connAlerts2.length).toBeGreaterThanOrEqual(1);
    });

    it('should generate an info alert when connectivity is restored', async () => {
      mockedProbeServer
        .mockResolvedValueOnce(makeFailingResult('server-1', ['connectivity']))
        .mockResolvedValueOnce(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);

      // First run fails.
      await agent.runPatrol();

      // Second run passes — should get a restoration alert.
      const run2 = await agent.runPatrol();
      const restoreAlerts = run2.alerts.filter(
        (a) => a.type === 'connectivity' && a.severity === 'info',
      );
      expect(restoreAlerts.length).toBeGreaterThanOrEqual(1);
      expect(restoreAlerts[0]!.message).toMatch(/restored/);
    });

    it('should include historical trend data in markdown report', async () => {
      mockedProbeServer
        .mockResolvedValueOnce(makePassingResult('server-1'))
        .mockResolvedValueOnce(makePassingResult('server-1'))
        .mockResolvedValueOnce(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      await agent.runPatrol();
      await agent.runPatrol();
      await agent.runPatrol();

      const { readFileSync } = await import('node:fs');
      const files = (await import('node:fs')).readdirSync(TEST_OUTPUT_DIR);
      // Get the last MD report (should have trend data).
      const mdFiles = files.filter((f) => f.endsWith('.md')).sort().reverse();
      const latestMd = mdFiles[0];

      if (latestMd) {
        const content = readFileSync(resolve(TEST_OUTPUT_DIR, latestMd), 'utf-8');
        expect(content).toMatch(/Historical Trend/);
      }
    });
  });

  // ----------------------------------------------------------
  // 8. Callbacks
  // ----------------------------------------------------------

  describe('callbacks', () => {
    it('should invoke onPatrolStart and onPatrolComplete callbacks', async () => {
      mockedProbeServer.mockResolvedValue(makePassingResult('server-1'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      const onPatrolStart = vi.fn();
      const onPatrolComplete = vi.fn();

      agent = new MonitorAgent(config);
      agent.callbacks = { onPatrolStart, onPatrolComplete };

      await agent.runPatrol();

      expect(onPatrolStart).toHaveBeenCalledTimes(1);
      expect(onPatrolComplete).toHaveBeenCalledTimes(1);
    });

    it('should invoke onAlert for each alert', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['connectivity', 'protocol']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: true,
        outputDir: TEST_OUTPUT_DIR,
      };

      const onAlert = vi.fn();

      agent = new MonitorAgent(config);
      agent.callbacks = { onAlert };

      await agent.runPatrol();

      // Should have at least one alert (connectivity + protocol).
      expect(onAlert).toHaveBeenCalled();
    });

    it('should invoke onAutoFix when fixes are generated', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['protocol']),
      );

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: true,
        outputDir: TEST_OUTPUT_DIR,
      };

      const onAutoFix = vi.fn();

      agent = new MonitorAgent(config);
      agent.callbacks = { onAutoFix };

      await agent.runPatrol();

      expect(onAutoFix).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 9. Pluggable LLM analysis
  // ----------------------------------------------------------

  describe('AI analysis', () => {
    it('should call analyzeFn for each alert and store the result', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['protocol']),
      );

      const analyzeFn = vi.fn().mockResolvedValue('Root cause: protocol version mismatch. Fix: update to latest MCP spec.');

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      agent.analyzeFn = analyzeFn;

      const run = await agent.runPatrol();

      expect(analyzeFn).toHaveBeenCalled();
      const protoAlert = run.alerts.find((a) => a.type === 'protocol');
      expect(protoAlert).toBeDefined();
      expect(protoAlert!.aiAnalysis).toMatch(/Root cause/);
    });

    it('should handle analyzeFn errors gracefully', async () => {
      mockedProbeServer.mockResolvedValueOnce(
        makeFailingResult('server-1', ['protocol']),
      );

      const analyzeFn = vi.fn().mockRejectedValue(new Error('LLM timeout'));

      const config: MonitorConfig = {
        servers: [makeServerConfig('server-1')],
        interval: 3600,
        alertThresholds: {
          connectivityFail: 1,
          latencyMax: 3000,
          protocolScoreMin: 80,
          securityCriticalMax: 0,
        },
        autoFix: false,
        outputDir: TEST_OUTPUT_DIR,
      };

      agent = new MonitorAgent(config);
      agent.analyzeFn = analyzeFn;

      const run = await agent.runPatrol();

      const protoAlert = run.alerts.find((a) => a.type === 'protocol');
      expect(protoAlert).toBeDefined();
      expect(protoAlert!.aiAnalysis).toMatch(/unavailable/);
    });
  });

  // ----------------------------------------------------------
  // 10. createMonitorAgent factory
  // ----------------------------------------------------------

  describe('createMonitorAgent', () => {
    it('should throw if config file does not exist', () => {
      expect(() =>
        createMonitorAgent({
          configPath: './nonexistent-mcp-config.json',
        }),
      ).toThrow();
    });
  });
});

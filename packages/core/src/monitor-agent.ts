// ============================================================
// MCP Sentinel — AI Agent Autonomous Patrol Engine
//
// A 7x24 autonomous inspection agent that monitors MCP server
// clusters. Runs a continuous agentic loop:
//
//   1. Reads mcp.json for all server configurations
//   2. Runs a timer that cycles at the configured interval
//   3. Each patrol round:
//      a. Probes all servers in parallel
//      b. Compares against historical data to detect anomalies
//      c. For each alert, optionally calls an LLM for root-cause
//         analysis and remediation suggestions
//      d. If autoFix is enabled, applies known fixes
//      e. Generates patrol reports (Markdown + HTML)
//      f. Saves reports to the outputs/ directory
//   4. Runs continuously until manually stopped
// ============================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfig } from './parser.js';
import { probeServer } from './probe.js';
import { generateReport } from './reporter.js';
import type {
  MCPServerConfig,
  MCPConfig,
  ProbeResult,
  ProbeOptions,
  ReportFormat,
} from './types.js';

// ============================================================
// Public interfaces
// ============================================================

/** Thresholds that control when alerts are raised during patrol. */
export interface AlertThresholds {
  /** Number of consecutive connectivity failures before alerting. */
  connectivityFail: number;
  /** Latency in ms above which a warning alert is raised. */
  latencyMax: number;
  /** Protocol score below which a warning alert is raised. */
  protocolScoreMin: number;
  /** Number of critical security findings above which a critical alert is raised. */
  securityCriticalMax: number;
}

/** Top-level configuration for the monitor agent. */
export interface MonitorConfig {
  /** MCP servers to patrol. */
  servers: MCPServerConfig[];
  /** Patrol interval in seconds (default: 3600 = 1 hour). */
  interval: number;
  /** Thresholds that trigger alerts. */
  alertThresholds: AlertThresholds;
  /** Whether to attempt automatic fixes for known issues. */
  autoFix: boolean;
  /** Directory to write patrol reports (default: "./outputs"). */
  outputDir?: string;
  /** Per-probe timeout in milliseconds. */
  probeTimeout?: number;
}

/** Context passed to the LLM analysis callback so it has full visibility. */
export interface AlertContext {
  /** The current probe result for the server that raised the alert. */
  currentResult: ProbeResult;
  /** The previous probe result for the same server (undefined on first patrol). */
  previousResult?: ProbeResult;
  /** The full current patrol run. */
  currentRun: MonitorRun;
  /** All historical runs (oldest first). */
  history: MonitorRun[];
}

/** A single alert raised during patrol. */
export interface Alert {
  /** Server that triggered the alert. */
  serverName: string;
  /** Alert severity. */
  severity: 'critical' | 'warning' | 'info';
  /** Alert category. */
  type: 'connectivity' | 'latency' | 'protocol' | 'security' | 'tools';
  /** Human-readable alert message. */
  message: string;
  /** When the alert was raised. */
  timestamp: Date;
  /** Optional LLM-generated root-cause analysis and remediation advice. */
  aiAnalysis?: string;
  /** Dimension-level details for context. */
  details?: Record<string, unknown>;
}

/** An automatic fix attempted during patrol. */
export interface AutoFix {
  /** Server the fix applies to. */
  serverName: string;
  /** The issue being addressed. */
  issue: string;
  /** Description of the action taken. */
  action: string;
  /** Whether the fix was successfully applied. */
  success: boolean;
  /** YAML configuration snippet for the fix (advisory). */
  yamlConfig?: string;
}

/** Result of a single patrol round. */
export interface MonitorRun {
  /** Unique run identifier. */
  id: string;
  /** When the patrol started. */
  startTime: Date;
  /** When the patrol ended. */
  endTime: Date;
  /** Probe results for every server. */
  results: ProbeResult[];
  /** Alerts raised during this patrol. */
  alerts: Alert[];
  /** Auto-fixes applied during this patrol. */
  autoFixes: AutoFix[];
}

/** Signature for a pluggable LLM analysis function. */
export type AnalyzeFn = (
  alert: Alert,
  context: AlertContext,
) => Promise<string>;

/** Callbacks the monitor agent invokes for lifecycle events. */
export interface MonitorCallbacks {
  /** Called at the start of every patrol round. */
  onPatrolStart?: (run: MonitorRun) => void;
  /** Called when a patrol round completes. */
  onPatrolComplete?: (run: MonitorRun) => void;
  /** Called when an alert is raised. */
  onAlert?: (alert: Alert) => void;
  /** Called when an auto-fix is applied. */
  onAutoFix?: (fix: AutoFix) => void;
  /** Called when reports are saved. */
  onReportSaved?: (paths: { md: string; html: string }) => void;
}

// ============================================================
// Defaults
// ============================================================

const DEFAULT_INTERVAL_SEC = 3600;
const DEFAULT_OUTPUT_DIR = './outputs';
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const DEFAULT_THRESHOLDS: AlertThresholds = {
  connectivityFail: 1,
  latencyMax: 3_000,
  protocolScoreMin: 80,
  securityCriticalMax: 0,
};

// ============================================================
// MonitorAgent
// ============================================================

/**
 * A 7x24 autonomous inspection agent for MCP server clusters.
 *
 * Usage:
 * ```ts
 * const agent = new MonitorAgent({
 *   servers: [...],
 *   interval: 3600,
 *   alertThresholds: { connectivityFail: 2, latencyMax: 5000, protocolScoreMin: 70, securityCriticalMax: 1 },
 *   autoFix: true,
 * });
 *
 * agent.onAlert = (alert) => console.error(alert.message);
 * await agent.start();
 * // ... later ...
 * agent.stop();
 * ```
 */
export class MonitorAgent {
  private _monitorConfig: MonitorConfig;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: MonitorRun[] = [];
  private patrolCount = 0;
  private consecutiveFailures: Map<string, number> = new Map();

  /** Pluggable LLM analysis function. Set before calling start(). */
  public analyzeFn?: AnalyzeFn;

  /** Lifecycle callbacks. */
  public callbacks: MonitorCallbacks = {};

  constructor(config: MonitorConfig) {
    this._monitorConfig = {
      ...config,
      interval: config.interval ?? DEFAULT_INTERVAL_SEC,
      alertThresholds: {
        ...DEFAULT_THRESHOLDS,
        ...config.alertThresholds,
      },
      outputDir: config.outputDir ?? DEFAULT_OUTPUT_DIR,
      probeTimeout: config.probeTimeout ?? DEFAULT_PROBE_TIMEOUT_MS,
    };
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  /**
   * Start the autonomous patrol loop.
   *
   * Runs one patrol immediately, then schedules subsequent patrols
   * at the configured interval. Returns after the first patrol completes.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.patrolCount = 0;

    // Run first patrol immediately.
    await this.runPatrol();

    // Schedule subsequent patrols.
    const intervalMs = this._monitorConfig.interval * 1000;
    this.timer = setInterval(() => {
      void this.runPatrol();
    }, intervalMs);
  }

  /**
   * Stop the autonomous patrol loop.
   *
   * Clears the interval timer. The current patrol (if any) will
   * complete naturally — this does not abort an in-flight patrol.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the agent is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Number of servers under patrol. */
  get serverCount(): number {
    return this._monitorConfig.servers.length;
  }

  /** The parsed MCP configuration (servers + options). */
  get config(): { servers: MCPServerConfig[]; options: { timeout: number; concurrent: number } } {
    return {
      servers: this._monitorConfig.servers,
      options: { timeout: 10000, concurrent: 5 },
    };
  }

  /** The patrol history (oldest first). */
  get patrolHistory(): ReadonlyArray<MonitorRun> {
    return this.history;
  }

  // ----------------------------------------------------------
  // Patrol logic
  // ----------------------------------------------------------

  /**
   * Execute a single patrol round across all configured servers.
   *
   * This is the core agentic loop iteration. It is also exposed as
   * a public method so callers can trigger manual patrols.
   */
  async runPatrol(): Promise<MonitorRun> {
    this.patrolCount++;
    const startTime = new Date();
    const id = `patrol-${toSafeTimestamp(startTime)}`;

    // Phase 1: Probe all servers in parallel.
    const results = await this.probeAllServers();

    // Phase 2: Detect anomalies by comparing against history.
    const previousRun =
      this.history.length > 0
        ? this.history[this.history.length - 1]
        : undefined;
    const alerts = this.detectAnomalies(results, previousRun);

    // Phase 3: AI analysis for each alert (optional, pluggable).
    if (this.analyzeFn && alerts.length > 0) {
      await this.analyzeAlerts(alerts, results, previousRun, id, startTime);
    }

    // Phase 4: Auto-fix known issues.
    let autoFixes: AutoFix[] = [];
    if (this._monitorConfig.autoFix) {
      autoFixes = this.generateAutoFixes(alerts, results);
    }

    const endTime = new Date();
    const run: MonitorRun = {
      id,
      startTime,
      endTime,
      results,
      alerts,
      autoFixes,
    };

    // Store in history.
    this.history.push(run);

    // Phase 5: Generate and save reports.
    const { md, html } = this.generateReports(run);
    const savedPaths = this.saveReports(run, md, html);

    // Phase 6: Invoke callbacks.
    this.callbacks.onPatrolStart?.(run);
    this.callbacks.onPatrolComplete?.(run);
    for (const alert of alerts) {
      this.callbacks.onAlert?.(alert);
    }
    for (const fix of autoFixes) {
      this.callbacks.onAutoFix?.(fix);
    }
    this.callbacks.onReportSaved?.(savedPaths);

    // Update consecutive failure tracking.
    for (const result of results) {
      const connDim = result.dimensions.find(
        (d) => d.dimension === 'connectivity',
      );
      if (connDim && !connDim.passed) {
        const current = this.consecutiveFailures.get(result.serverName) ?? 0;
        this.consecutiveFailures.set(result.serverName, current + 1);
      } else {
        this.consecutiveFailures.set(result.serverName, 0);
      }
    }

    return run;
  }

  // ----------------------------------------------------------
  // Phase 1: Parallel probing
  // ----------------------------------------------------------

  /** Probe all configured servers in parallel. */
  private async probeAllServers(): Promise<ProbeResult[]> {
    const probeOptions: ProbeOptions = {
      timeout: this._monitorConfig.probeTimeout,
    };

    const promises = this._monitorConfig.servers.map((server) =>
      probeServer(server, probeOptions),
    );

    return Promise.all(promises);
  }

  // ----------------------------------------------------------
  // Phase 2: Anomaly detection
  // ----------------------------------------------------------

  /**
   * Compare current probe results against historical data and
   * the configured thresholds to generate alerts.
   */
  private detectAnomalies(
    current: ProbeResult[],
    previous?: MonitorRun,
  ): Alert[] {
    const alerts: Alert[] = [];
    const now = new Date();

    // Build a lookup of previous results keyed by server name.
    const prevMap = new Map<string, ProbeResult>();
    if (previous) {
      for (const r of previous.results) {
        prevMap.set(r.serverName, r);
      }
    }

    for (const result of current) {
      const prevResult = prevMap.get(result.serverName);
      const thresholds = this._monitorConfig.alertThresholds;

      // --- Connectivity checks ---
      const connDim = result.dimensions.find(
        (d) => d.dimension === 'connectivity',
      );
      if (connDim && !connDim.passed) {
        const failCount =
          (this.consecutiveFailures.get(result.serverName) ?? 0) + 1;
        if (failCount >= thresholds.connectivityFail) {
          alerts.push({
            serverName: result.serverName,
            severity: 'critical',
            type: 'connectivity',
            message: `Server unreachable — ${failCount} consecutive failure(s). ${connDim.message}`,
            timestamp: now,
            details: {
              consecutiveFailures: failCount,
              error: connDim.error ?? null,
            },
          });
        }
      } else if (connDim && connDim.passed && prevResult) {
        const prevConn = prevResult.dimensions.find(
          (d) => d.dimension === 'connectivity',
        );
        if (prevConn && !prevConn.passed) {
          alerts.push({
            serverName: result.serverName,
            severity: 'info',
            type: 'connectivity',
            message: `Connectivity restored after previous failure.`,
            timestamp: now,
          });
        }
      }

      // --- Latency checks ---
      const perfDim = result.dimensions.find(
        (d) => d.dimension === 'performance',
      );
      if (perfDim) {
        const avgLatency = (perfDim.details?.avgLatencyMs as number) ?? 0;
        if (avgLatency > thresholds.latencyMax) {
          const prevPerf = prevResult?.dimensions.find(
            (d) => d.dimension === 'performance',
          );
          const prevAvg = (prevPerf?.details?.avgLatencyMs as number) ?? null;
          const changeMsg =
            prevAvg !== null
              ? ` (was ${prevAvg}ms, +${Math.round(avgLatency - prevAvg)}ms)`
              : '';

          alerts.push({
            serverName: result.serverName,
            severity: avgLatency > thresholds.latencyMax * 2 ? 'critical' : 'warning',
            type: 'latency',
            message: `Average latency ${Math.round(avgLatency)}ms exceeds ${thresholds.latencyMax}ms threshold${changeMsg}.`,
            timestamp: now,
            details: {
              avgLatencyMs: avgLatency,
              thresholdMs: thresholds.latencyMax,
              previousAvgMs: prevAvg,
            },
          });
        }
      }

      // --- Protocol score checks ---
      const protoDim = result.dimensions.find(
        (d) => d.dimension === 'protocol',
      );
      if (protoDim) {
        const score = (protoDim.details?.score as number) ?? 100;
        if (score < thresholds.protocolScoreMin) {
          const prevProto = prevResult?.dimensions.find(
            (d) => d.dimension === 'protocol',
          );
          const prevScore = (prevProto?.details?.score as number) ?? null;
          const trendMsg =
            prevScore !== null
              ? ` (was ${prevScore}, dropped ${prevScore - score} points)`
              : '';

          alerts.push({
            serverName: result.serverName,
            severity: score < thresholds.protocolScoreMin / 2 ? 'critical' : 'warning',
            type: 'protocol',
            message: `Protocol score ${score}/100 below minimum ${thresholds.protocolScoreMin}${trendMsg}.`,
            timestamp: now,
            details: {
              score,
              threshold: thresholds.protocolScoreMin,
              previousScore: prevScore,
              failures: protoDim.details?.failures ?? [],
            },
          });
        }
      }

      // --- Security checks ---
      const secDim = result.dimensions.find(
        (d) => d.dimension === 'security',
      );
      if (secDim) {
        const criticalCount =
          (secDim.details?.criticalCount as number) ?? 0;
        const totalFindings =
          (secDim.details?.totalFindings as number) ?? 0;

        if (criticalCount > thresholds.securityCriticalMax) {
          alerts.push({
            serverName: result.serverName,
            severity: 'critical',
            type: 'security',
            message: `${criticalCount} critical security finding(s) detected (max allowed: ${thresholds.securityCriticalMax}).`,
            timestamp: now,
            details: {
              criticalCount,
              totalFindings,
              maxAllowed: thresholds.securityCriticalMax,
              findings: secDim.details?.findings ?? [],
            },
          });
        }

        // Also alert on new security findings vs previous run.
        if (prevResult) {
          const prevSec = prevResult.dimensions.find(
            (d) => d.dimension === 'security',
          );
          const prevTotal =
            (prevSec?.details?.totalFindings as number) ?? 0;
          if (totalFindings > prevTotal) {
            const newCount = totalFindings - prevTotal;
            alerts.push({
              serverName: result.serverName,
              severity: 'warning',
              type: 'security',
              message: `${newCount} new security finding(s) since last patrol (${prevTotal} → ${totalFindings}).`,
              timestamp: now,
              details: {
                previousTotal: prevTotal,
                currentTotal: totalFindings,
                newFindings: newCount,
              },
            });
          }
        }
      }

      // --- Tools availability checks ---
      const toolsDim = result.dimensions.find(
        (d) => d.dimension === 'tools',
      );
      if (toolsDim && !toolsDim.passed && prevResult) {
        const prevTools = prevResult.dimensions.find(
          (d) => d.dimension === 'tools',
        );
        if (prevTools && prevTools.passed) {
          alerts.push({
            serverName: result.serverName,
            severity: 'warning',
            type: 'tools',
            message: `Tools unavailable — were available in previous patrol.`,
            timestamp: now,
            details: {
              current: toolsDim.details ?? null,
              previous: prevTools.details ?? null,
            },
          });
        }
      }
    }

    return alerts;
  }

  // ----------------------------------------------------------
  // Phase 3: AI analysis
  // ----------------------------------------------------------

  /**
   * Run the pluggable LLM analysis function against each alert.
   * The analysis result is stored directly on the alert object.
   */
  private async analyzeAlerts(
    alerts: Alert[],
    currentResults: ProbeResult[],
    previousRun: MonitorRun | undefined,
    runId: string,
    runStartTime: Date,
  ): Promise<void> {
    if (!this.analyzeFn) return;

    for (const alert of alerts) {
      const currentResult = currentResults.find(
        (r) => r.serverName === alert.serverName,
      );
      if (!currentResult) continue;

      const previousResult = previousRun?.results.find(
        (r) => r.serverName === alert.serverName,
      );

      const context: AlertContext = {
        currentResult,
        previousResult,
        currentRun: {
          id: runId,
          startTime: runStartTime,
          endTime: new Date(),
          results: currentResults,
          alerts,
          autoFixes: [],
        },
        history: this.history,
      };

      try {
        alert.aiAnalysis = await this.analyzeFn(alert, context);
      } catch {
        alert.aiAnalysis = 'LLM analysis unavailable — analysis function threw an error.';
      }
    }
  }

  // ----------------------------------------------------------
  // Phase 4: Auto-fix generation
  // ----------------------------------------------------------

  /**
   * Generate automatic fixes for known issues.
   *
   * Currently focuses on protocol compliance failures — produces
   * YAML configuration snippets that describe the required changes.
   * These are advisory (saved in the report) rather than applied
   * to live servers.
   */
  private generateAutoFixes(
    alerts: Alert[],
    results: ProbeResult[],
  ): AutoFix[] {
    const fixes: AutoFix[] = [];

    for (const alert of alerts) {
      if (alert.type === 'protocol') {
        const result = results.find(
          (r) => r.serverName === alert.serverName,
        );
        if (!result) continue;

        const protoDim = result.dimensions.find(
          (d) => d.dimension === 'protocol',
        );
        if (!protoDim?.details?.failures) continue;

        const failures = protoDim.details.failures as Array<{
          id: string;
          name: string;
          message: string;
        }>;

        for (const failure of failures) {
          const fix = this.buildProtocolFix(
            result.serverName,
            failure,
          );
          fixes.push(fix);
        }
      }

      if (alert.type === 'connectivity') {
        fixes.push({
          serverName: alert.serverName,
          issue: 'Server connectivity failure',
          action:
            'Recommended: check server process status, verify command path and arguments in mcp.json, ensure network access for SSE servers.',
          success: false,
          yamlConfig: `# Connectivity failure — manual intervention required
# Check:
#   1. Server process is running
#   2. Command path in mcp.json is correct
#   3. Port/URL is accessible (for SSE transport)
#   4. Firewall rules allow the connection
`,
        });
      }
    }

    return fixes;
  }

  /**
   * Build a YAML fix configuration for a protocol compliance failure.
   */
  private buildProtocolFix(
    serverName: string,
    failure: { id: string; name: string; message: string },
  ): AutoFix {
    const yamlConfig = `# Auto-fix suggestion for server: ${serverName}
# Rule: ${failure.id} — ${failure.name}
# Issue: ${failure.message}
#
# Apply the following changes to your MCP server implementation:
fix:
  server: ${serverName}
  rule_id: ${failure.id}
  rule_name: ${failure.name}
  description: "${failure.message.replace(/"/g, '\\"')}"
  actions:
    - review: "Consult the MCP specification for the ${failure.id} requirement."
    - implement: "Update server implementation to comply with the rule."
    - verify: "Re-run 'mcp-sentinel test' to confirm the fix."
`;

    return {
      serverName,
      issue: `${failure.id}: ${failure.message}`,
      action: `Generated YAML fix config for rule "${failure.id}". Apply changes to the MCP server implementation and re-validate.`,
      success: true,
      yamlConfig,
    };
  }

  // ----------------------------------------------------------
  // Phase 5: Report generation
  // ----------------------------------------------------------

  /**
   * Generate both Markdown and HTML reports for a patrol run.
   */
  private generateReports(run: MonitorRun): { md: string; html: string } {
    const md = this.renderMarkdownReport(run);
    const html = generateReport(run.results, 'html' as ReportFormat);
    return { md, html };
  }

  /**
   * Render a comprehensive Markdown patrol report.
   */
  private renderMarkdownReport(run: MonitorRun): string {
    const lines: string[] = [];

    lines.push(`# MCP Sentinel — Patrol Report`);
    lines.push('');
    lines.push(`**Run ID:** \`${run.id}\``);
    lines.push(`**Started:** ${run.startTime.toISOString()}`);
    lines.push(`**Completed:** ${run.endTime.toISOString()}`);
    lines.push(
      `**Duration:** ${run.endTime.getTime() - run.startTime.getTime()}ms`,
    );
    lines.push(`**Patrol #:** ${this.patrolCount}`);
    lines.push('');

    // Summary
    const passedCount = run.results.filter((r) => r.overallPassed).length;
    const failedCount = run.results.length - passedCount;
    const totalDuration = run.results.reduce((s, r) => s + r.durationMs, 0);

    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`| ------ | ----- |`);
    lines.push(`| Servers probed | ${run.results.length} |`);
    lines.push(`| Passed | ${passedCount} |`);
    if (failedCount > 0) {
      lines.push(`| **Failed** | **${failedCount}** |`);
    }
    lines.push(`| Total duration | ${totalDuration}ms |`);
    lines.push(`| Alerts raised | ${run.alerts.length} |`);
    lines.push(`| Auto-fixes applied | ${run.autoFixes.length} |`);
    lines.push('');

    // Per-server results
    lines.push('## Server Results');
    lines.push('');

    for (const result of run.results) {
      const status = result.overallPassed ? 'PASS' : 'FAIL';
      lines.push(
        `### ${status === 'PASS' ? ':white_check_mark:' : ':x:'} ${result.serverName} — ${status}`,
      );
      lines.push('');
      lines.push(`- **Transport:** ${result.config.transport}`);
      lines.push(`- **Duration:** ${result.durationMs}ms`);
      lines.push('');

      for (const dim of result.dimensions) {
        const icon = dim.passed ? '✓' : dim.error ? '✗' : '─';
        const durStr =
          dim.durationMs !== undefined ? ` (${dim.durationMs}ms)` : '';
        lines.push(
          `- ${icon} **${dim.dimension}**: ${dim.message}${durStr}`,
        );

        // Show key details for failing dimensions.
        if (!dim.passed && dim.details) {
          const detailKeys = Object.keys(dim.details);
          if (detailKeys.length > 0) {
            lines.push(`  - Details: \`${JSON.stringify(dim.details)}\``);
          }
        }
      }
      lines.push('');
    }

    // Alerts
    if (run.alerts.length > 0) {
      lines.push('## Alerts');
      lines.push('');

      for (const alert of run.alerts) {
        const sevEmoji =
          alert.severity === 'critical'
            ? ':rotating_light:'
            : alert.severity === 'warning'
              ? ':warning:'
              : ':information_source:';
        lines.push(
          `### ${sevEmoji} [${alert.severity.toUpperCase()}] ${alert.type} — ${alert.serverName}`,
        );
        lines.push('');
        lines.push(`- **Time:** ${alert.timestamp.toISOString()}`);
        lines.push(`- **Message:** ${alert.message}`);
        if (alert.aiAnalysis) {
          lines.push(`- **AI Analysis:**`);
          lines.push('');
          // Indent multi-line AI analysis.
          for (const analysisLine of alert.aiAnalysis.split('\n')) {
            lines.push(`  ${analysisLine}`);
          }
          lines.push('');
        }
        lines.push('');
      }
    }

    // Auto-fixes
    if (run.autoFixes.length > 0) {
      lines.push('## Auto-Fixes');
      lines.push('');

      for (const fix of run.autoFixes) {
        lines.push(`### ${fix.serverName}: ${fix.issue}`);
        lines.push('');
        lines.push(`- **Action:** ${fix.action}`);
        lines.push(`- **Success:** ${fix.success ? 'Yes' : 'No'}`);
        if (fix.yamlConfig) {
          lines.push('');
          lines.push('```yaml');
          lines.push(fix.yamlConfig.trimEnd());
          lines.push('```');
        }
        lines.push('');
      }
    }

    // Historical trend (if we have enough history)
    if (this.history.length > 1) {
      lines.push('## Historical Trend');
      lines.push('');
      lines.push(
        `Total patrols in memory: ${this.history.length}`,
      );
      lines.push('');

      for (const result of run.results) {
        const trendData = this.buildTrendData(result.serverName);
        if (trendData.length > 1) {
          lines.push(`### ${result.serverName} — Score Trend`);
          lines.push('');
          lines.push(`| Patrol | Score | Passed |`);
          lines.push(`| ------ | ----- | ------ |`);
          for (const point of trendData) {
            lines.push(
              `| ${point.id} | ${point.score}/100 | ${point.passed ? 'Yes' : 'No'} |`,
            );
          }
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  }

  /** Build a trend dataset for a server across all historical runs. */
  private buildTrendData(
    serverName: string,
  ): Array<{ id: string; score: number; passed: boolean }> {
    const data: Array<{ id: string; score: number; passed: boolean }> = [];

    for (const run of this.history) {
      const result = run.results.find((r) => r.serverName === serverName);
      if (!result) continue;

      const protoDim = result.dimensions.find(
        (d) => d.dimension === 'protocol',
      );
      const score = (protoDim?.details?.score as number) ?? 0;

      data.push({
        id: run.id,
        score,
        passed: result.overallPassed,
      });
    }

    return data;
  }

  // ----------------------------------------------------------
  // Phase 6: Report persistence
  // ----------------------------------------------------------

  /**
   * Save patrol reports to the configured output directory.
   * Returns the paths that were written.
   */
  private saveReports(
    run: MonitorRun,
    md: string,
    html: string,
  ): { md: string; html: string } {
    const outputDir = resolve(this._monitorConfig.outputDir ?? DEFAULT_OUTPUT_DIR);
    mkdirSync(outputDir, { recursive: true });

    const mdPath = resolve(outputDir, `${run.id}.md`);
    const htmlPath = resolve(outputDir, `${run.id}.html`);

    writeFileSync(mdPath, md, 'utf-8');
    writeFileSync(htmlPath, html, 'utf-8');

    return { md: mdPath, html: htmlPath };
  }
}

// ============================================================
// Factory: create MonitorAgent from an mcp.json file
// ============================================================

/** Options for creating a MonitorAgent from a config file. */
export interface MonitorAgentFromFileOptions {
  /** Path to the mcp.json file (default: "./mcp.json"). */
  configPath?: string;
  /** Patrol interval in seconds. */
  interval?: number;
  /** Alert thresholds (merged with defaults). */
  alertThresholds?: Partial<AlertThresholds>;
  /** Whether to enable auto-fix. */
  autoFix?: boolean;
  /** Output directory for reports. */
  outputDir?: string;
  /** Per-probe timeout in milliseconds. */
  probeTimeout?: number;
}

/**
 * Create a MonitorAgent by reading server configurations from an
 * mcp.json file. This is the recommended entry point for CLI usage.
 */
export function createMonitorAgent(
  options: MonitorAgentFromFileOptions = {},
): MonitorAgent {
  const configPath = options.configPath ?? './mcp.json';

  let mcpConfig: MCPConfig;
  try {
    mcpConfig = parseConfig({ configPath });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
      throw err;
    }
    throw new Error(
      `Failed to parse config at "${configPath}": ${String(err)}`,
    );
  }

  return new MonitorAgent({
    servers: mcpConfig.servers,
    interval: options.interval ?? DEFAULT_INTERVAL_SEC,
    alertThresholds: {
      connectivityFail:
        options.alertThresholds?.connectivityFail ??
        DEFAULT_THRESHOLDS.connectivityFail,
      latencyMax:
        options.alertThresholds?.latencyMax ?? DEFAULT_THRESHOLDS.latencyMax,
      protocolScoreMin:
        options.alertThresholds?.protocolScoreMin ??
        DEFAULT_THRESHOLDS.protocolScoreMin,
      securityCriticalMax:
        options.alertThresholds?.securityCriticalMax ??
        DEFAULT_THRESHOLDS.securityCriticalMax,
    },
    autoFix: options.autoFix ?? false,
    outputDir: options.outputDir,
    probeTimeout: options.probeTimeout,
  });
}

// ============================================================
// Helpers
// ============================================================

/** Convert a Date to a filesystem-safe timestamp string. */
function toSafeTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\..+/, '');
}

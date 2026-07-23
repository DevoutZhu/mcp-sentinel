// ---------------------------------------------------------------------------
// monitor — 7x24 autonomous MCP server patrol
// ---------------------------------------------------------------------------

import { Command } from 'commander';
import {
  createMonitorAgent,
  type MonitorAgent,
  type MonitorRun,
  type Alert,
  type AutoFix,
} from 'mcp-sentinel-core';
import {
  info,
  success,
  fail,
  warn,
  debug,
  heading,
  divider,
  getLoggerOptions,
  CLIError,
} from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function registerMonitorCommand(program: Command): void {
  program
    .command('monitor')
    .description('Start 7x24 autonomous MCP server patrol')
    .option('-c, --config <path>', 'Path to mcp.json config file', 'mcp.json')
    .option(
      '-i, --interval <seconds>',
      'Patrol interval in seconds (default: 3600 = 1 hour)',
      '3600',
    )
    .option('--no-autofix', 'Disable automatic fixes for known issues')
    .option('--once', 'Run a single patrol and exit')
    .option(
      '-o, --output <dir>',
      'Directory for patrol reports',
      './outputs',
    )
    .option('--timeout <ms>', 'Per-probe timeout in milliseconds', '10000')
    .addHelpText(
      'after',
      `
Examples:
  mcp-sentinel monitor                         Use mcp.json, patrol every hour
  mcp-sentinel monitor --once                  Run a single patrol and exit
  mcp-sentinel monitor --interval 600          Patrol every 10 minutes
  mcp-sentinel monitor --config prod.json      Use a different config file
  mcp-sentinel monitor --no-autofix            Disable automatic fixes
  mcp-sentinel monitor --output ./reports      Custom output directory`,
    )
    .action(async (options: Record<string, unknown>) => {
      const configPath = String(options.config ?? 'mcp.json');
      const interval = parseInt(String(options.interval ?? '3600'), 10);
      const autoFix = options.autofix !== false;
      const once = Boolean(options.once);
      const outputDir = String(options.output ?? './outputs');
      const probeTimeout = parseInt(String(options.timeout ?? '10000'), 10);

      // --- Validate inputs ---------------------------------------------------
      if (isNaN(interval) || interval < 10) {
        throw new CLIError(
          `Invalid interval "${options.interval}". Must be >= 10 seconds.`,
          'Example: --interval 3600 (1 hour)',
        );
      }

      if (isNaN(probeTimeout) || probeTimeout < 1000) {
        throw new CLIError(
          `Invalid timeout "${options.timeout}". Must be >= 1000ms.`,
          'Example: --timeout 15000',
        );
      }

      // --- Create agent from config file -------------------------------------
      let agent: MonitorAgent;
      try {
        agent = createMonitorAgent({
          configPath,
          interval,
          autoFix,
          outputDir,
          probeTimeout,
        });
      } catch (err) {
        throw new CLIError(
          `Failed to load config: ${String(err)}`,
          'Check that the config file exists and is valid JSON.',
        );
      }

      const serverCount = agent.serverCount;

      // --- Wire up callbacks for terminal output -----------------------------
      const noColor = getLoggerOptions().noColor;

      agent.callbacks = {
        onPatrolStart: (run: MonitorRun) => {
          if (noColor) {
            process.stdout.write(`\n=== Patrol ${run.id} ===\n\n`);
          } else {
            heading(
              `\u{1F916} MCP Monitor Agent — Patrol ${run.id}`,
            );
          }
          info(`Servers: ${run.results.length} | Interval: ${interval}s | Auto-fix: ${autoFix ? 'ON' : 'OFF'}`);
          divider();
        },

        onPatrolComplete: (run: MonitorRun) => {
          const passedCount = run.results.filter((r) => r.overallPassed).length;
          const failedCount = run.results.length - passedCount;

          process.stdout.write('\n');

          // Per-server one-line status.
          for (const result of run.results) {
            if (result.overallPassed) {
              success(`${result.serverName} — ALL PASSED (${result.durationMs}ms)`);
            } else {
              const failDims = result.dimensions
                .filter((d) => !d.passed)
                .map((d) => d.dimension);
              fail(
                `${result.serverName} — ${failDims.length}/${result.dimensions.length} FAILED (${failDims.join(', ')}) [${result.durationMs}ms]`,
              );
            }
          }

          divider();

          // Summary.
          if (failedCount > 0) {
            warn(
              `Patrol complete — ${passedCount}/${run.results.length} passed, ${failedCount} failed, ${run.alerts.length} alert(s)`,
            );
          } else {
            success(
              `Patrol complete — ${passedCount}/${run.results.length} passed, ${run.alerts.length} alert(s)`,
            );
          }

          // Alerts detail.
          if (run.alerts.length > 0) {
            process.stdout.write('\n');
            for (const alert of run.alerts) {
              printAlert(alert);
            }
          }

          // Auto-fix summary.
          if (run.autoFixes.length > 0) {
            process.stdout.write('\n');
            info(`Auto-fixes generated: ${run.autoFixes.length}`);
          }

          divider();
          if (!once) {
            info(`Next patrol in ${interval}s (Ctrl+C to stop)`);
          }
          process.stdout.write('\n');
        },

        onAlert: (alert: Alert) => {
          debug(`[${alert.severity.toUpperCase()}] ${alert.type} — ${alert.serverName}: ${alert.message}`);
        },

        onAutoFix: (fix: AutoFix) => {
          debug(`Auto-fix: ${fix.serverName} — ${fix.issue}`);
        },

        onReportSaved: (paths: { md: string; html: string }) => {
          debug(`Report: ${paths.md}`);
          debug(`Report: ${paths.html}`);
        },
      };

      // --- Signal handling for graceful shutdown -----------------------------
      let shuttingDown = false;

      const shutdown = (signal: string) => {
        if (shuttingDown) {
          process.exit(1);
        }
        shuttingDown = true;

        process.stdout.write('\n');
        info(`Received ${signal} — shutting down monitor...`);
        agent.stop();

        const history = agent.patrolHistory;
        info(`${history.length} patrol(s) completed. Reports saved to: ${outputDir}`);
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

      // --- Start -------------------------------------------------------------
      info(`${serverCount} server(s), patrol every ${interval}s`);
      info('Press Ctrl+C to stop.');
      process.stdout.write('\n');

      if (once) {
        // Single patrol and exit.
        const run = await agent.runPatrol();
        const hasAlerts = run.alerts.length > 0;
        const hasFailures = run.results.some((r) => !r.overallPassed);
        const exitCode = hasAlerts || hasFailures ? 1 : 0;

        // Print report paths.
        const history = agent.patrolHistory;
        if (history.length > 0) {
          info(`Reports saved to: ${outputDir}`);
        }
        process.exit(exitCode);
      }

      await agent.start();
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Print a single alert to the terminal with appropriate coloring. */
function printAlert(alert: Alert): void {
  const sevLabel = alert.severity.toUpperCase();
  const prefix = `[${sevLabel}] ${alert.type} — ${alert.serverName}`;

  if (alert.severity === 'critical') {
    fail(`${prefix}: ${alert.message}`);
  } else if (alert.severity === 'warning') {
    warn(`${prefix}: ${alert.message}`);
  } else {
    info(`${prefix}: ${alert.message}`);
  }

  if (alert.aiAnalysis) {
    const analysisLines = alert.aiAnalysis.split('\n').slice(0, 3);
    for (const line of analysisLines) {
      debug(`  ${line}`);
    }
    if (alert.aiAnalysis.split('\n').length > 3) {
      debug('  ... (see report for full analysis)');
    }
  }
}

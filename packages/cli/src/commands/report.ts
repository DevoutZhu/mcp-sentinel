import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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

// ---------------------------------------------------------------------------
// report — view / export test reports
// ---------------------------------------------------------------------------

const REPORT_DIR = path.resolve(process.cwd(), '.mcp-sentinel');

export function registerReportCommand(program: Command): void {
  program
    .command('report [file]')
    .description('View or export a test report (defaults to the most recent run)')
    .option('-f, --format <type>', 'Output format: terminal, json, or html', 'terminal')
    .option('-o, --output <path>', 'Write output to a file instead of stdout')
    .option('-v, --verbose', 'Show verbose output')
    .addHelpText(
      'after',
      `
Examples:
  mcp-sentinel report                        View the most recent report in terminal
  mcp-sentinel report --json                 Output the most recent report as JSON
  mcp-sentinel report --format html -o rpt   Export as HTML to ./report.html
  mcp-sentinel report ./my-report.json       View a specific saved report`,
    )
    .action(async (file: string | undefined, options: Record<string, string>) => {
      configureLogger({
        verbose: Boolean(options.verbose),
        json: options.format === 'json',
      });

      const format = options.format as string;
      if (!['terminal', 'json', 'html'].includes(format)) {
        throw new CLIError(
          `Unknown format "${format}".`,
          'Valid formats: terminal, json, html.',
        );
      }

      // Resolve the report file
      let reportPath: string;
      if (file) {
        reportPath = path.resolve(file);
      } else {
        reportPath = await findLatestReport();
      }

      let raw: string;
      try {
        raw = await fs.readFile(reportPath, 'utf-8');
      } catch {
        throw new CLIError(
          `Report file not found: "${reportPath}".`,
          'Run a test first: mcp-sentinel test <target> or mcp-sentinel scan <dir>',
        );
      }

      let report: unknown;
      try {
        report = JSON.parse(raw);
      } catch {
        throw new CLIError(
          `Report file "${reportPath}" is not valid JSON.`,
          'The file may be corrupted. Run a new test to generate a fresh report.',
        );
      }

      // --- Output ---------------------------------------------------------
      if (format === 'json') {
        const outPath = options.output ? path.resolve(options.output) : undefined;
        const jsonStr = JSON.stringify(report, null, 2);
        if (outPath) {
          const finalPath = outPath.endsWith('.json') ? outPath : `${outPath}.json`;
          await fs.writeFile(finalPath, jsonStr, 'utf-8');
          success(`Report written to ${finalPath}`);
        } else {
          logJson(report);
        }
        return;
      }

      if (format === 'html') {
        const outPath = options.output
          ? path.resolve(options.output)
          : path.resolve(process.cwd(), 'report.html');
        const finalPath = outPath.endsWith('.html') ? outPath : `${outPath}.html`;
        const html = generateHtmlReport(report);
        await fs.writeFile(finalPath, html, 'utf-8');
        success(`HTML report written to ${finalPath}`);
        return;
      }

      // Terminal view
      printTerminalReport(report as Record<string, unknown>, reportPath);
    });
}

// --- report discovery ------------------------------------------------------

async function findLatestReport(): Promise<string> {
  try {
    const entries = await fs.readdir(REPORT_DIR);
    const jsonFiles = entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(REPORT_DIR, f))
      .sort(); // alphabetical sort approximates chronological (timestamp-named)

    if (jsonFiles.length === 0) {
      throw new CLIError(
        'No reports found.',
        'Run a test first: mcp-sentinel test <target> or mcp-sentinel scan <dir>',
      );
    }

    return jsonFiles[jsonFiles.length - 1]!; // most recent
  } catch (err) {
    if (err instanceof CLIError) throw err;
    throw new CLIError(
      `No reports directory found at "${REPORT_DIR}".`,
      'Run a test first: mcp-sentinel test <target> or mcp-sentinel scan <dir>',
    );
  }
}

// --- terminal report -------------------------------------------------------

function printTerminalReport(report: Record<string, unknown>, sourcePath: string): void {
  heading(`Report: ${path.basename(sourcePath)}`);

  const results = (report.results ?? []) as Array<Record<string, unknown>>;
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const score = typeof report.score === 'number' ? report.score : '-';

  info(`Score:     ${score}/100`);
  info(`Total:     ${total} rule(s)`);
  success(`Passed:    ${passed}`);
  if (failed > 0) {
    fail(`Failed:    ${failed}`);
  } else {
    success(`Failed:    0`);
  }
  info(`Timestamp: ${report.timestamp ?? 'unknown'}`);

  if (total > 0) {
    divider();
    for (const r of results) {
      const id = r.id ?? '?';
      const name = r.name ?? 'Unknown';
      const msg = r.message ?? '';
      const passedFlag = r.passed;

      if (passedFlag) {
        success(`[${id}] ${name} — ${msg}`);
      } else if (r.severity === 'error') {
        fail(`[${id}] ${name} — ${msg}`);
      } else if (r.severity === 'warning') {
        warn(`[${id}] ${name} — ${msg}`);
      } else {
        info(`[${id}] ${name} — ${msg}`);
      }
    }
  }
}

// --- HTML report generator ------------------------------------------------

function generateHtmlReport(report: unknown): string {
  const r = report as Record<string, unknown>;
  const results = (r.results ?? []) as Array<Record<string, unknown>>;
  const score = r.score ?? '-';
  const timestamp = r.timestamp ?? 'unknown';

  const rows = results
    .map(
      (item) => `
    <tr class="${item.passed ? 'pass' : item.severity === 'error' ? 'fail' : 'warn'}">
      <td><code>${item.id ?? '?'}</code></td>
      <td>${item.name ?? 'Unknown'}</td>
      <td>${item.severity ?? '-'}</td>
      <td>${item.passed ? 'PASS' : 'FAIL'}</td>
      <td>${item.message ?? ''}</td>
    </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>MCP Sentinel Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #222; background: #fff; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; }
    th { background: #f5f5f5; font-weight: 600; }
    .pass { border-left: 3px solid #22c55e; }
    .fail { border-left: 3px solid #ef4444; }
    .warn { border-left: 3px solid #f59e0b; }
    .meta { color: #666; margin: 20px 0; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>MCP Sentinel — Test Report</h1>
  <div class="meta">
    <p><strong>Score:</strong> ${score}/100</p>
    <p><strong>Timestamp:</strong> ${timestamp}</p>
  </div>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Name</th>
        <th>Severity</th>
        <th>Result</th>
        <th>Message</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>
</body>
</html>`;
}

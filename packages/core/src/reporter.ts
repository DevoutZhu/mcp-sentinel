import chalk from 'chalk';
import type { ProbeResult, DimensionResult, ReportFormat } from './types.js';

// ============================================================
// Public API
// ============================================================

/**
 * Generate a human- or machine-readable report from probe results.
 *
 * @param results  One or more ProbeResult entries.
 * @param format   Output format: terminal (ANSI-coloured), json, or html.
 * @returns A string ready to write to stdout or a file.
 */
export function generateReport(
  results: ProbeResult[],
  format: ReportFormat,
): string {
  switch (format) {
    case 'terminal':
      return renderTerminal(results);
    case 'json':
      return renderJson(results);
    case 'html':
      return renderHtml(results);
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown report format: ${String(_exhaustive)}`);
    }
  }
}

// ============================================================
// Terminal renderer
// ============================================================

function renderTerminal(results: ProbeResult[]): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(chalk.bold.cyan('═══ MCP Sentinel — Probe Results ═══'));
  lines.push('');

  const passedCount = results.filter((r) => r.overallPassed).length;
  const failedCount = results.length - passedCount;

  // Per-server results
  for (const r of results) {
    // Server header
    const icon = r.overallPassed
      ? chalk.green('✓')
      : chalk.red('✗');
    const duration = `(${r.durationMs}ms)`;
    lines.push(`  ${icon} ${chalk.bold(r.serverName)} ${chalk.gray(duration)}`);

    // Dimension details
    for (const d of r.dimensions) {
      lines.push(`    ${dimIcon(d)} ${dimLabel(d)}`);
    }

    lines.push('');
  }

  lines.push('');

  // Summary footer
  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
  lines.push(chalk.bold('Summary:'));
  lines.push(`  Total:   ${results.length} server(s)`);
  lines.push(`  Passed:  ${chalk.green(String(passedCount))}`);
  if (failedCount > 0) {
    lines.push(`  Failed:  ${chalk.red(String(failedCount))}`);
  } else {
    lines.push(`  Failed:  0`);
  }
  lines.push(`  Elapsed: ${totalDuration}ms`);
  lines.push('');

  return lines.join('\n');
}

/** Choose the icon for a dimension result. */
function dimIcon(d: DimensionResult): string {
  if (d.passed) return chalk.green('✓');
  if (d.error) return chalk.red('✗');
  return chalk.yellow('─'); // Skipped
}

/** Build the coloured label for a dimension row. */
function dimLabel(d: DimensionResult): string {
  const name = d.dimension.padEnd(14);
  if (d.passed) {
    const dur = d.durationMs !== undefined ? chalk.gray(` ${d.durationMs}ms`) : '';
    return `${chalk.white(name)} ${chalk.green(d.message)}${dur}`;
  }
  if (d.error) {
    return `${chalk.white(name)} ${chalk.red(d.message)}`;
  }
  // Skipped
  return `${chalk.white(name)} ${chalk.yellow(d.message)}`;
}

// ============================================================
// JSON renderer
// ============================================================

function renderJson(results: ProbeResult[]): string {
  const sanitized = results.map(sanitizeForJson);
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.overallPassed).length,
    failed: results.filter((r) => !r.overallPassed).length,
    results: sanitized,
  };
  return JSON.stringify(summary, null, 2);
}

/** Convert Date objects and other non-JSON-safe values to primitives. */
function sanitizeForJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeForJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForJson(v);
    }
    return out;
  }
  return value;
}

// ============================================================
// HTML renderer
// ============================================================

function renderHtml(results: ProbeResult[]): string {
  const passedCount = results.filter((r) => r.overallPassed).length;
  const failedCount = results.length - passedCount;
  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);

  const serverCards = results.map((r) => renderServerCard(r)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Sentinel — Probe Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      color: #1a1a1a;
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 900px; margin: 0 auto; }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 0.25rem;
      color: #0891b2;
    }
    .timestamp { color: #6b7280; font-size: 0.85rem; margin-bottom: 1.5rem; }
    .summary {
      display: flex; gap: 1.5rem; margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .stat {
      background: #fff; border-radius: 8px; padding: 1rem 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1); min-width: 120px;
    }
    .stat-value { font-size: 2rem; font-weight: 700; }
    .stat-label { font-size: 0.8rem; color: #6b7280; text-transform: uppercase; }
    .stat-passed .stat-value { color: #16a34a; }
    .stat-failed .stat-value { color: #dc2626; }
    .card {
      background: #fff; border-radius: 8px; padding: 1.25rem 1.5rem;
      margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      border-left: 4px solid #d1d5db;
    }
    .card.passed { border-left-color: #16a34a; }
    .card.failed { border-left-color: #dc2626; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
    .card-name { font-weight: 600; font-size: 1.1rem; }
    .card-badge {
      font-size: 0.75rem; font-weight: 600; padding: 2px 10px;
      border-radius: 12px; text-transform: uppercase;
    }
    .badge-pass { background: #dcfce7; color: #16a34a; }
    .badge-fail { background: #fee2e2; color: #dc2626; }
    .dim-row {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.35rem 0; font-size: 0.9rem;
    }
    .dim-icon { width: 20px; text-align: center; font-weight: 700; }
    .dim-name { width: 110px; color: #6b7280; flex-shrink: 0; }
    .dim-msg { flex: 1; }
    .dim-dur { color: #9ca3af; font-size: 0.8rem; font-variant-numeric: tabular-nums; }
    .pass { color: #16a34a; }
    .fail { color: #dc2626; }
    .skip { color: #d97706; }
    .detail-box {
      margin-top: 0.5rem; background: #f9fafb; border-radius: 6px;
      padding: 0.75rem 1rem; font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.8rem; white-space: pre-wrap; overflow-x: auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>MCP Sentinel — Probe Report</h1>
    <p class="timestamp">Generated ${new Date().toISOString()}</p>

    <div class="summary">
      <div class="stat stat-passed">
        <div class="stat-value">${passedCount}</div>
        <div class="stat-label">Passed</div>
      </div>
      <div class="stat stat-failed">
        <div class="stat-value">${failedCount}</div>
        <div class="stat-label">Failed</div>
      </div>
      <div class="stat">
        <div class="stat-value">${results.length}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat">
        <div class="stat-value">${totalDuration}ms</div>
        <div class="stat-label">Elapsed</div>
      </div>
    </div>

    ${serverCards}
  </div>
</body>
</html>`;
}

function renderServerCard(r: ProbeResult): string {
  const cardClass = r.overallPassed ? 'passed' : 'failed';
  const badgeClass = r.overallPassed ? 'badge-pass' : 'badge-fail';
  const badgeText = r.overallPassed ? 'PASS' : 'FAIL';

  const dimRows = r.dimensions
    .map((d) => renderDimRow(d))
    .join('\n');

  return `
    <div class="card ${cardClass}">
      <div class="card-header">
        <span class="card-name">${escapeHtml(r.serverName)}</span>
        <span class="card-badge ${badgeClass}">${badgeText}</span>
      </div>
      ${dimRows}
      <div style="margin-top:0.5rem;color:#9ca3af;font-size:0.8rem">
        Transport: ${escapeHtml(r.config.transport)} &middot; ${r.durationMs}ms
      </div>
    </div>`;
}

function renderDimRow(d: DimensionResult): string {
  let icon: string;
  let cssClass: string;
  if (d.passed) {
    icon = '✓';
    cssClass = 'pass';
  } else if (d.error) {
    icon = '✗';
    cssClass = 'fail';
  } else {
    icon = '─';
    cssClass = 'skip';
  }

  const dur =
    d.durationMs !== undefined
      ? ` <span class="dim-dur">${d.durationMs}ms</span>`
      : '';

  // If there are detail objects, include them in a collapsed section.
  const detailHtml = d.details
    ? `\n      <details class="detail-box"><summary>Details</summary>${escapeHtml(JSON.stringify(d.details, null, 2))}</details>`
    : '';

  return `
      <div class="dim-row">
        <span class="dim-icon ${cssClass}">${icon}</span>
        <span class="dim-name">${d.dimension}</span>
        <span class="dim-msg ${cssClass}">${escapeHtml(d.message)}${dur}</span>
      </div>${detailHtml}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

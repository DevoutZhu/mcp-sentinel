import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Logger — structured coloured output for TTY; plain text for pipes
// ---------------------------------------------------------------------------

export interface LogOptions {
  /** Suppress all non-error output (--quiet) */
  quiet: boolean;
  /** Emit verbose detail (--verbose) */
  verbose: boolean;
  /** Use JSON output (--json / --format json) */
  json: boolean;
  /** Disable colour (--no-color or piped) */
  noColor: boolean;
}

const DEFAULT_OPTIONS: LogOptions = {
  quiet: false,
  verbose: false,
  json: false,
  noColor: false,
};

let _opts: LogOptions = { ...DEFAULT_OPTIONS };

export function configureLogger(opts: Partial<LogOptions>): void {
  _opts = { ..._opts, ...opts };
  if (_opts.noColor) {
    chalk.level = 0;
  }
}

export function getLoggerOptions(): Readonly<LogOptions> {
  return _opts;
}

// --- terminal detection ---------------------------------------------------

export function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

// --- formatted log helpers ------------------------------------------------

export function success(msg: string): void {
  if (_opts.quiet) return;
  const prefix = _opts.noColor ? '[PASS]' : chalk.green('✔');
  process.stdout.write(`${prefix} ${msg}\n`);
}

export function fail(msg: string): void {
  const prefix = _opts.noColor ? '[FAIL]' : chalk.red('✘');
  process.stderr.write(`${prefix} ${msg}\n`);
}

export function warn(msg: string): void {
  if (_opts.quiet) return;
  const prefix = _opts.noColor ? '[WARN]' : chalk.yellow('⚠');
  process.stdout.write(`${prefix} ${msg}\n`);
}

export function info(msg: string): void {
  if (_opts.quiet) return;
  const prefix = _opts.noColor ? '[INFO]' : chalk.blue('ℹ');
  process.stdout.write(`${prefix} ${msg}\n`);
}

export function debug(msg: string): void {
  if (!_opts.verbose) return;
  const prefix = _opts.noColor ? '[DEBUG]' : chalk.gray('  …');
  process.stderr.write(`${prefix} ${msg}\n`);
}

export function heading(text: string): void {
  if (_opts.quiet) return;
  const line = _opts.noColor ? text : chalk.bold.underline(text);
  process.stdout.write(`\n${line}\n\n`);
}

export function divider(): void {
  if (_opts.quiet) return;
  const line = _opts.noColor ? '─'.repeat(50) : chalk.gray('─'.repeat(50));
  process.stdout.write(`${line}\n`);
}

export function json(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

// --- structured error -----------------------------------------------------

/**
 * A user-actionable error: always names the cause AND the fix.
 * Stack traces are only shown with --verbose.
 */
export class CLIError extends Error {
  /** Suggested fix the user can act on. */
  public readonly fix: string;

  constructor(message: string, fix: string) {
    super(message);
    this.name = 'CLIError';
    this.fix = fix;
  }

  print(): void {
    const label = _opts.noColor ? 'Error:' : chalk.red.bold('Error:');
    process.stderr.write(`${label} ${this.message}\n`);

    if (this.fix) {
      const fixLabel = _opts.noColor ? 'Fix:' : chalk.cyan('Fix:');
      process.stderr.write(`  ${fixLabel} ${this.fix}\n`);
    }

    if (_opts.verbose && this.stack) {
      const traceLabel = _opts.noColor ? 'Stack:' : chalk.gray('Stack:');
      process.stderr.write(`  ${traceLabel}\n`);
      process.stderr.write(
        this.stack
          .split('\n')
          .slice(1)
          .map((l) => `    ${l}`)
          .join('\n') + '\n',
      );
    }
  }
}

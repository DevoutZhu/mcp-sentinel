import ora, { Ora } from 'ora';
import { isTTY } from './logger.js';

// ---------------------------------------------------------------------------
// Spinner — progress indicator that degrades gracefully in non-TTY contexts
// ---------------------------------------------------------------------------

let _current: Ora | null = null;

/**
 * Start a spinner with the given text.
 * In non-TTY contexts (pipe, CI) the spinner is silently a no-op so we never
 * emit ANSI codes into a redirected stream.
 */
export function startSpinner(text: string): Ora {
  if (!isTTY()) {
    // Return a fake spinner that just swallows calls — keeps scripts clean.
    return createNoopSpinner();
  }
  _current = ora({ text, spinner: 'dots' }).start();
  return _current;
}

/**
 * Stop the current spinner (success state).
 */
export function succeedSpinner(text?: string): void {
  if (_current) {
    _current.succeed(text);
    _current = null;
  }
}

/**
 * Stop the current spinner (failure state).
 */
export function failSpinner(text?: string): void {
  if (_current) {
    _current.fail(text);
    _current = null;
  }
}

/**
 * Update the current spinner text without stopping it.
 */
export function updateSpinner(text: string): void {
  if (_current) {
    _current.text = text;
  }
}

/**
 * Stop the current spinner (neutral, no symbol).
 */
export function stopSpinner(): void {
  if (_current) {
    _current.stop();
    _current = null;
  }
}

// --- no-op spinner for pipes / CI -----------------------------------------

function createNoopSpinner(): Ora {
  const noop = {
    start: () => noop,
    stop: () => noop,
    succeed: () => noop,
    fail: () => noop,
    warn: () => noop,
    info: () => noop,
    stopAndPersist: () => noop,
    clear: () => noop,
    render: () => noop,
    frame: () => '',
    get isSpinning() {
      return false;
    },
    set text(_: string) {},
    get text() {
      return '';
    },
    set prefixText(_: string) {},
    get prefixText() {
      return '';
    },
    set suffixText(_: string) {},
    get suffixText() {
      return '';
    },
    get color() {
      return 'white' as const;
    },
    set color(_: string) {},
    get spinner() {
      return { frames: [''], interval: 0 };
    },
    set spinner(_: unknown) {},
    get indent() {
      return 0;
    },
    set indent(_: number) {},
  } as unknown as Ora;
  return noop;
}

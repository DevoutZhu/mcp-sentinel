// ============================================================
// load-tester.ts — concurrent load testing engine
//
// Zero external dependencies beyond the standard library.
// Uses Promise.all + AbortController for concurrency control
// and cancellation.
// ============================================================

// ============================================================
// Types
// ============================================================

/** Configuration identifying the target and the operation to benchmark. */
export interface LoadTestConfig {
  /** Human-readable target identifier used in result summaries. */
  target: string;
  /**
   * Async function that performs a single request or operation.
   * The load tester calls this repeatedly from concurrent workers.
   * Throw on failure — errors are captured and counted.
   */
  requestFn: () => Promise<void>;
}

/** Options controlling how the load test executes. */
export interface LoadTestOptions {
  /**
   * Number of concurrent workers (default: 10).
   * Each worker issues requests in a loop until the stop condition is met.
   */
  concurrency?: number;
  /**
   * Exact number of requests to send across all workers.
   * Mutually exclusive with `duration` — if both are set, `totalRequests` wins.
   */
  totalRequests?: number;
  /**
   * How long to run the test in milliseconds (default: 10000).
   * Ignored when `totalRequests` is set.
   */
  duration?: number;
  /** Per-request timeout in milliseconds (default: 10000). */
  timeout?: number;
  /** External AbortSignal to cancel the test early. */
  signal?: AbortSignal;
}

/** Latency statistics computed from all collected samples. */
export interface LatencyStats {
  /** Minimum observed latency in milliseconds. */
  min: number;
  /** Maximum observed latency in milliseconds. */
  max: number;
  /** Arithmetic mean latency in milliseconds. */
  avg: number;
  /** 50th percentile (median) latency in milliseconds. */
  p50: number;
  /** 95th percentile latency in milliseconds. */
  p95: number;
  /** 99th percentile latency in milliseconds. */
  p99: number;
}

/** A recorded failure during load testing. */
export interface LoadTestError {
  /** Monotonic request index at which the error occurred. */
  requestIndex: number;
  /** Error message. */
  message: string;
}

/** Complete result of a load test run. */
export interface LoadTestResult {
  /** The target identifier from the config. */
  target: string;
  /** Total requests attempted (successful + failed). */
  totalRequests: number;
  /** Number of requests that completed without throwing. */
  successful: number;
  /** Number of requests that threw or timed out. */
  failed: number;
  /** Ratio of successful requests (0–1). */
  successRate: number;
  /** Requests completed per second. */
  throughput: number;
  /** Latency distribution across all successful requests. */
  latency: LatencyStats;
  /** Wall-clock duration of the test in milliseconds. */
  durationMs: number;
  /** Concurrency level used for this test. */
  concurrency: number;
  /** Wall-clock start time. */
  startTime: Date;
  /** Wall-clock end time. */
  endTime: Date;
  /**
   * Captured error details.
   * Capped at 100 entries to prevent huge payloads on catastrophic failures.
   */
  errors: LoadTestError[];
}

/** Options controlling a ramp-up (progressive load) test. */
export interface RampUpOptions {
  /** Starting concurrency for the first stage (default: 1). */
  startConcurrency?: number;
  /** Maximum concurrency to reach (default: 100). */
  maxConcurrency?: number;
  /** Concurrency increment between stages (default: 10). */
  step?: number;
  /** Duration in milliseconds for each ramp-up stage (default: 5000). */
  stageDuration?: number;
  /** Per-request timeout in milliseconds (default: 10000). */
  timeout?: number;
  /** External AbortSignal to cancel the test between stages. */
  signal?: AbortSignal;
}

/** A single stage within a ramp-up test. */
export interface RampUpStage {
  /** The concurrency level for this stage. */
  concurrency: number;
  /** The full load test result for this stage. */
  result: LoadTestResult;
}

/** Result of a ramp-up test that finds the performance inflection point. */
export interface RampUpTestResult {
  /**
   * The concurrency level at which performance began to degrade significantly.
   * `null` means no inflection point was found within the tested range.
   */
  inflectionPoint: number | null;
  /** Per-stage results in order of increasing concurrency. */
  stages: RampUpStage[];
  /** Human-readable recommendation based on the collected data. */
  recommendation: string;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DURATION_MS = 10_000;
const DEFAULT_RAMP_START = 1;
const DEFAULT_RAMP_MAX = 100;
const DEFAULT_RAMP_STEP = 10;
const DEFAULT_RAMP_STAGE_DURATION = 5_000;

/** p95 must increase by at least this multiplier over the previous stage. */
const INFLECTION_P95_MULTIPLIER = 1.5;

/** Error rate exceeding this value also signals an inflection point. */
const INFLECTION_ERROR_RATE_THRESHOLD = 0.05;

/** Minimum absolute p95 increase in ms to qualify as a real degradation. */
const INFLECTION_MIN_P95_INCREASE_MS = 100;

/** Maximum number of error entries kept in LoadTestResult.errors. */
const MAX_ERROR_ENTRIES = 100;

// ============================================================
// Core: loadTest
// ============================================================

/**
 * Run a concurrent load test against a target.
 *
 * Spawns `concurrency` workers, each looping to invoke `config.requestFn()`
 * until a stop condition is reached (totalRequests or duration). Latency of
 * every successful call is recorded; failures are captured in the errors array.
 *
 * Cancellation is handled through a composite `AbortController` that merges
 * the per-request timeout, an optional external signal, and a duration timer.
 *
 * @param config  Target descriptor and the async function to benchmark.
 * @param options Concurrency, request count / duration, timeout, signal.
 * @returns       Aggregated statistics including latency percentiles.
 */
export async function loadTest(
  config: LoadTestConfig,
  options: LoadTestOptions = {},
): Promise<LoadTestResult> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const useRequestLimit = options.totalRequests !== undefined;
  const maxRequests = options.totalRequests ?? Infinity;
  const durationMs = options.duration ?? DEFAULT_DURATION_MS;

  // ---- Composite abort controller -------------------------------------------
  const internalController = new AbortController();
  const { signal: internalSignal } = internalController;

  // Forward external signal aborts to our internal controller.
  wireExternalSignal(options.signal, internalController);

  // Duration-based stop: schedule an abort after `durationMs`.
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  if (!useRequestLimit) {
    durationTimer = setTimeout(() => {
      internalController.abort();
    }, durationMs);
  }

  // ---- Shared state (safe to mutate without locks in single-threaded JS) ----
  const latencies: number[] = [];
  const errors: LoadTestError[] = [];
  let completedRequests = 0;

  const startTime = new Date();
  const startHr = performance.now();

  // ---- Worker ---------------------------------------------------------------
  async function worker(): Promise<void> {
    while (true) {
      // Stop if the test has been cancelled.
      if (internalSignal.aborted) {
        return;
      }

      // In request-limited mode, atomically claim a slot before issuing
      // the request.  Because no `await` intervenes between the read,
      // the bounds check, and the write, this is safe in single-threaded JS.
      if (useRequestLimit) {
        const claimed = completedRequests;
        if (claimed >= maxRequests) {
          return;
        }
        completedRequests = claimed + 1;
      }

      const requestIndex = useRequestLimit
        ? completedRequests - 1
        : completedRequests;

      if (!useRequestLimit) {
        completedRequests++;
      }

      const reqStart = performance.now();

      try {
        await withTimeout(config.requestFn(), timeout, internalSignal);
        const latency = performance.now() - reqStart;
        latencies.push(latency);
      } catch (err: unknown) {
        // If the test was aborted (duration elapsed or external signal),
        // stop immediately without recording a spurious error.
        if (internalSignal.aborted) {
          return;
        }

        const message =
          err instanceof Error ? err.message : String(err);
        errors.push({ requestIndex, message });
      }
    }
  }

  // Launch all workers and wait for them to settle.
  const workers = Array.from({ length: concurrency }, () => worker());

  try {
    await Promise.all(workers);
  } catch {
    // Workers are designed to never throw — all errors go into `errors`.
    // A catch here guards against unexpected runtime exceptions.
  }

  // ---- Cleanup --------------------------------------------------------------
  if (durationTimer !== undefined) {
    clearTimeout(durationTimer);
  }

  const endTime = new Date();
  const elapsedMs = performance.now() - startHr;

  // ---- Compute statistics ---------------------------------------------------
  const sorted = latencies.slice().sort((a, b) => a - b);
  const totalRequests = completedRequests;
  const failed = errors.length;
  const successful = totalRequests - failed;

  return {
    target: config.target,
    totalRequests,
    successful,
    failed,
    successRate: totalRequests > 0 ? successful / totalRequests : 0,
    throughput: elapsedMs > 0 ? (totalRequests / elapsedMs) * 1000 : 0,
    latency: computeLatencyStats(sorted),
    durationMs: Math.round(elapsedMs),
    concurrency,
    startTime,
    endTime,
    errors: errors.slice(0, MAX_ERROR_ENTRIES),
  };
}

// ============================================================
// Core: rampUpTest
// ============================================================

/**
 * Gradually increase concurrency to find the performance inflection point.
 *
 * Runs `loadTest` at increasing concurrency levels (start -> max, stepping
 * by `step`). After each stage the p95 latency and error rate are compared
 * against the previous stage to detect when the server begins to degrade.
 *
 * @param config  Target descriptor and the async function to benchmark.
 * @param options Ramp-up parameters (start, max, step, stage duration).
 * @returns       Per-stage results, the inflection point (if found), and a
 *                human-readable recommendation.
 */
export async function rampUpTest(
  config: LoadTestConfig,
  options: RampUpOptions = {},
): Promise<RampUpTestResult> {
  const startConcurrency = options.startConcurrency ?? DEFAULT_RAMP_START;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_RAMP_MAX;
  const step = options.step ?? DEFAULT_RAMP_STEP;
  const stageDuration = options.stageDuration ?? DEFAULT_RAMP_STAGE_DURATION;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  const stages: RampUpStage[] = [];
  let inflectionPoint: number | null = null;

  for (let c = startConcurrency; c <= maxConcurrency; c += step) {
    // Honour external cancellation between stages.
    if (options.signal?.aborted) {
      break;
    }

    const result = await loadTest(config, {
      concurrency: c,
      duration: stageDuration,
      timeout,
      signal: options.signal,
    });

    stages.push({ concurrency: c, result });

    // Detect inflection point: significant p95 jump OR rising error rate.
    if (stages.length >= 2 && inflectionPoint === null) {
      const prev = stages[stages.length - 2]!.result;
      const curr = result;

      const prevP95 = prev.latency.p95;
      const currP95 = curr.latency.p95;
      const p95Increase = currP95 - prevP95;

      const p95Spiked =
        currP95 > prevP95 * INFLECTION_P95_MULTIPLIER &&
        p95Increase >= INFLECTION_MIN_P95_INCREASE_MS;

      const highErrorRate =
        curr.successRate < 1 - INFLECTION_ERROR_RATE_THRESHOLD;

      if (p95Spiked || highErrorRate) {
        inflectionPoint = c;
      }
    }
  }

  const recommendation = buildRampUpRecommendation(stages, inflectionPoint);

  return { inflectionPoint, stages, recommendation };
}

// ============================================================
// Helpers: timeout with abort signal
// ============================================================

/**
 * Race a promise against a timeout AND an AbortSignal.
 *
 * Returns the promise's resolved value, or rejects with a descriptive
 * Error if the timeout fires or the signal is aborted.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T> {
  // Fail fast when already aborted.
  if (signal.aborted) {
    throw new Error(
      signal.reason ? String(signal.reason) : 'Request aborted',
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${ms}ms`));
    }, ms);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      reject(
        new Error(
          signal.reason ? String(signal.reason) : 'Request aborted',
        ),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// ============================================================
// Helpers: statistics
// ============================================================

/**
 * Compute min, max, avg, p50, p95, and p99 from a **sorted** latency array.
 * Returns zeroes when no samples are available.
 */
function computeLatencyStats(sorted: number[]): LatencyStats {
  if (sorted.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }

  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;

  return {
    min: Math.round(min),
    max: Math.round(max),
    avg: Math.round(avg),
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
  };
}

/**
 * Compute the p-th percentile from a sorted array using linear interpolation.
 *
 * Uses the "percentile rank" formula: index = (p/100) * (N - 1).
 * When the index falls between two elements, linear interpolation is applied.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0]!;
  }

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower]!;
  }

  const fraction = index - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

// ============================================================
// Helpers: external signal wiring
// ============================================================

/**
 * If an external AbortSignal is provided, forward its abort event to the
 * internal AbortController so that external cancellation cleanly stops
 * all in-flight workers.
 */
function wireExternalSignal(
  external: AbortSignal | undefined,
  internal: AbortController,
): void {
  if (!external) {
    return;
  }
  if (external.aborted) {
    internal.abort(external.reason);
    return;
  }
  external.addEventListener(
    'abort',
    () => internal.abort(external.reason),
    { once: true },
  );
}

// ============================================================
// Helpers: ramp-up recommendation
// ============================================================

/**
 * Build a human-readable recommendation from the ramp-up stage data.
 */
function buildRampUpRecommendation(
  stages: RampUpStage[],
  inflectionPoint: number | null,
): string {
  if (stages.length === 0) {
    return 'No ramp-up stages were executed. Check the configuration and try again.';
  }

  const lastStage = stages[stages.length - 1]!;
  const maxConcurrency = lastStage.concurrency;
  const finalP95 = lastStage.result.latency.p95;
  const finalSuccessRate = lastStage.result.successRate;

  if (inflectionPoint !== null) {
    const recommended = Math.max(1, Math.floor(inflectionPoint * 0.7));
    return [
      `Performance inflection detected at concurrency ${inflectionPoint}.`,
      `Recommended safe operating concurrency: ${recommended} (70% of inflection point).`,
      `At max tested concurrency ${maxConcurrency}:`,
      `  p95 latency = ${finalP95}ms,`,
      `  success rate = ${(finalSuccessRate * 100).toFixed(1)}%.`,
    ].join(' ');
  }

  return [
    `No clear inflection point found up to concurrency ${maxConcurrency}.`,
    `The target handled the load well:`,
    `p95 = ${finalP95}ms,`,
    `success rate = ${(finalSuccessRate * 100).toFixed(1)}%.`,
    `Consider increasing --max-concurrency to find the breaking point.`,
  ].join(' ');
}

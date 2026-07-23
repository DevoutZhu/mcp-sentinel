import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  MCPConfig,
  MCPServerConfig,
  ParseOptions,
  TransportType,
  StructuredError,
} from './types.js';

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONFIG_PATH = 'mcp.json';
const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_CONCURRENCY = 5;
const VALID_TRANSPORTS: ReadonlySet<string> = new Set(['stdio', 'sse']);

// ============================================================
// Helpers
// ============================================================

/** Build a structured error with a machine-readable code. */
function se(code: string, message: string, details?: unknown): StructuredError {
  return { code, message, details };
}

// ============================================================
// Public API
// ============================================================

/**
 * Parse an mcp.json configuration file and return a validated MCPConfig.
 *
 * Supports CLI argument overrides for server filtering and field-level
 * patching so that runtime flags can adjust the static configuration
 * without modifying the file.
 *
 * @throws {StructuredError} When the file is missing, malformed, or
 *   contains invalid server definitions.
 */
export function parseConfig(options: ParseOptions = {}): MCPConfig {
  const configPath = resolve(options.configPath ?? DEFAULT_CONFIG_PATH);

  // --- 1. File existence ----------------------------------------------------
  if (!existsSync(configPath)) {
    throw se(
      'CONFIG_FILE_NOT_FOUND',
      `Configuration file not found: ${configPath}`,
      { path: configPath },
    );
  }

  // --- 2. JSON parsing ------------------------------------------------------
  let raw: unknown;
  try {
    const content = readFileSync(configPath, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw se(
        'CONFIG_PARSE_ERROR',
        `Invalid JSON in ${configPath}: ${err.message}`,
        { path: configPath },
      );
    }
    throw se(
      'CONFIG_READ_ERROR',
      `Failed to read ${configPath}: ${String(err)}`,
      { path: configPath },
    );
  }

  // --- 3. Root structure validation -----------------------------------------
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw se(
      'CONFIG_INVALID_FORMAT',
      'Config root must be a JSON object with a "servers" array.',
      { received: typeof raw },
    );
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.servers)) {
    throw se(
      'CONFIG_MISSING_SERVERS',
      'Config must contain a "servers" array.',
      {},
    );
  }

  // --- 4. Validate each server entry ----------------------------------------
  const rawServers = obj.servers as unknown[];
  if (rawServers.length === 0) {
    throw se(
      'CONFIG_EMPTY_SERVERS',
      'The "servers" array is empty — at least one server is required.',
      {},
    );
  }

  const servers = rawServers.map((s, i) => validateServer(s, i));

  // --- 5. Parse global options ----------------------------------------------
  const options_ = {
    timeout:
      typeof obj.timeout === 'number' && obj.timeout > 0
        ? obj.timeout
        : DEFAULT_TIMEOUT,
    concurrent:
      typeof obj.concurrent === 'number' && obj.concurrent > 0
        ? obj.concurrent
        : DEFAULT_CONCURRENCY,
  };

  // --- 6. Apply CLI overrides -----------------------------------------------
  let finalServers = servers;
  const cli = options.cliArgs;

  if (cli) {
    // 6a. Filter by server name
    if (cli.server !== undefined) {
      finalServers = finalServers.filter((s) => s.name === cli.server);
      if (finalServers.length === 0) {
        throw se(
          'CONFIG_SERVER_NOT_FOUND',
          `Server "${cli.server}" not found in config. Available: ${servers.map((s) => s.name).join(', ')}`,
          { serverName: cli.server, available: servers.map((s) => s.name) },
        );
      }
    }

    // 6b. Field-level overrides (applied to all matching servers)
    const hasFieldOverride =
      cli.transport !== undefined ||
      cli.command !== undefined ||
      cli.url !== undefined;
    if (hasFieldOverride) {
      finalServers = finalServers.map((s) => ({
        ...s,
        transport: cli.transport !== undefined
          ? validateTransport(cli.transport)
          : s.transport,
        command: cli.command ?? s.command,
        url: cli.url ?? s.url,
      }));
    }

    // 6c. Global option overrides
    if (cli.timeout !== undefined) {
      if (cli.timeout < 1000) {
        throw se(
          'CONFIG_INVALID_TIMEOUT',
          `Timeout must be >= 1000ms, got ${cli.timeout}.`,
          { timeout: cli.timeout },
        );
      }
      options_.timeout = cli.timeout;
    }
    if (cli.concurrent !== undefined) {
      if (cli.concurrent < 1) {
        throw se(
          'CONFIG_INVALID_CONCURRENT',
          `Concurrency must be >= 1, got ${cli.concurrent}.`,
          { concurrent: cli.concurrent },
        );
      }
      options_.concurrent = cli.concurrent;
    }
  }

  return { servers: finalServers, options: options_ };
}

// ============================================================
// Internal validators
// ============================================================

function validateTransport(raw: string): TransportType {
  if (!VALID_TRANSPORTS.has(raw)) {
    throw se(
      'CONFIG_INVALID_TRANSPORT',
      `Transport must be "stdio" or "sse", got "${raw}".`,
      { received: raw },
    );
  }
  return raw as TransportType;
}

/**
 * Validate a single server entry from the config array.
 * Throws structured errors with the server index for precise location.
 */
function validateServer(raw: unknown, index: number): MCPServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw se(
      'CONFIG_INVALID_SERVER',
      `servers[${index}] must be an object.`,
      { index },
    );
  }

  const s = raw as Record<string, unknown>;
  const label = `servers[${index}]`;

  // --- name (required) ------------------------------------------------------
  if (typeof s.name !== 'string' || s.name.trim().length === 0) {
    throw se(
      'CONFIG_MISSING_NAME',
      `${label}: "name" is required and must be a non-empty string.`,
      { index },
    );
  }

  // --- transport (required) -------------------------------------------------
  if (typeof s.transport !== 'string') {
    throw se(
      'CONFIG_MISSING_TRANSPORT',
      `${label} ("${s.name}"): "transport" is required ("stdio" or "sse").`,
      { index, serverName: s.name },
    );
  }
  const transport = validateTransport(s.transport);

  // --- Transport-specific required fields -----------------------------------
  if (transport === 'stdio' && typeof s.command !== 'string') {
    throw se(
      'CONFIG_MISSING_COMMAND',
      `${label} ("${s.name}"): "command" is required for stdio transport.`,
      { index, serverName: s.name },
    );
  }

  if (transport === 'sse' && typeof s.url !== 'string') {
    throw se(
      'CONFIG_MISSING_URL',
      `${label} ("${s.name}"): "url" is required for SSE transport.`,
      { index, serverName: s.name },
    );
  }

  if (transport === 'sse' && s.url !== undefined && typeof s.url === 'string') {
    try {
      new URL(s.url);
    } catch {
      throw se(
        'CONFIG_INVALID_URL',
        `${label} ("${s.name}"): "url" is not a valid URL: "${s.url}".`,
        { index, serverName: s.name, url: s.url },
      );
    }
  }

  // --- Optional fields validation -------------------------------------------
  if (s.args !== undefined) {
    if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string')) {
      throw se(
        'CONFIG_INVALID_ARGS',
        `${label} ("${s.name}"): "args" must be an array of strings.`,
        { index, serverName: s.name },
      );
    }
  }

  if (s.env !== undefined) {
    if (typeof s.env !== 'object' || Array.isArray(s.env) || s.env === null) {
      throw se(
        'CONFIG_INVALID_ENV',
        `${label} ("${s.name}"): "env" must be a string→string object.`,
        { index, serverName: s.name },
      );
    }
    for (const [key, value] of Object.entries(
      s.env as Record<string, unknown>,
    )) {
      if (typeof value !== 'string') {
        throw se(
          'CONFIG_INVALID_ENV_VALUE',
          `${label} ("${s.name}"): env.${key} must be a string.`,
          { index, serverName: s.name, key },
        );
      }
    }
  }

  return {
    name: s.name,
    transport,
    command: typeof s.command === 'string' ? s.command : undefined,
    args:
      Array.isArray(s.args) && s.args.every((a) => typeof a === 'string')
        ? (s.args as string[])
        : undefined,
    url: typeof s.url === 'string' ? s.url : undefined,
    env: s.env as Record<string, string> | undefined,
  };
}

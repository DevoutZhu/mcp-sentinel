import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  success,
  info,
  heading,
  json as logJson,
  CLIError,
} from '../utils/logger.js';

// ---------------------------------------------------------------------------
// config — read / write CLI configuration
//
// Precedence (highest first):
//   1. CLI flags (--timeout etc.)
//   2. Environment variables (MCP_SENTINEL_*)
//   3. Config file (~/.mcp-sentinel/config.json)
//   4. Built-in defaults
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.resolve(
  process.env.MCP_SENTINEL_HOME ?? path.join(homeDir(), '.mcp-sentinel'),
);
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export interface CLIConfig {
  timeout: number;
  concurrency: number;
  transport: 'stdio' | 'sse';
}

const DEFAULT_CONFIG: CLIConfig = {
  timeout: 10000,
  concurrency: 5,
  transport: 'stdio',
};

// --- public API for other modules -----------------------------------------

export async function loadConfig(): Promise<CLIConfig> {
  const config = { ...DEFAULT_CONFIG };

  // Layer: config file
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const fileConfig = JSON.parse(raw);
    Object.assign(config, fileConfig);
  } catch {
    // No config file yet — use defaults
  }

  // Layer: environment variables (override file)
  if (process.env.MCP_SENTINEL_TIMEOUT) {
    const envTimeout = parseInt(process.env.MCP_SENTINEL_TIMEOUT, 10);
    if (!isNaN(envTimeout)) config.timeout = envTimeout;
  }
  if (process.env.MCP_SENTINEL_CONCURRENCY) {
    const envConc = parseInt(process.env.MCP_SENTINEL_CONCURRENCY, 10);
    if (!isNaN(envConc)) config.concurrency = envConc;
  }
  if (
    process.env.MCP_SENTINEL_TRANSPORT === 'stdio' ||
    process.env.MCP_SENTINEL_TRANSPORT === 'sse'
  ) {
    config.transport = process.env.MCP_SENTINEL_TRANSPORT;
  }

  return config;
}

export async function saveConfig(config: CLIConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// --- command registration --------------------------------------------------

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('View or manage mcp-sentinel configuration');

  // config set <key> <value>
  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action(async (key: string, value: string) => {
      const allowedKeys: (keyof CLIConfig)[] = ['timeout', 'concurrency', 'transport'];
      if (!allowedKeys.includes(key as keyof CLIConfig)) {
        throw new CLIError(
          `Unknown config key "${key}".`,
          `Valid keys: ${allowedKeys.join(', ')}`,
        );
      }

      const config = await loadConfig();

      switch (key) {
        case 'timeout': {
          const ms = parseInt(value, 10);
          if (isNaN(ms) || ms < 1000) {
            throw new CLIError(
              `Invalid timeout "${value}".`,
              'Must be a number >= 1000 (ms). Example: mcp-sentinel config set timeout 15000',
            );
          }
          config.timeout = ms;
          break;
        }
        case 'concurrency': {
          const n = parseInt(value, 10);
          if (isNaN(n) || n < 1) {
            throw new CLIError(
              `Invalid concurrency "${value}".`,
              'Must be a positive integer. Example: mcp-sentinel config set concurrency 5',
            );
          }
          config.concurrency = n;
          break;
        }
        case 'transport': {
          const t = value.toLowerCase();
          if (t !== 'stdio' && t !== 'sse') {
            throw new CLIError(
              `Invalid transport "${value}".`,
              'Valid values: stdio, sse.',
            );
          }
          config.transport = t;
          break;
        }
      }

      await saveConfig(config);
      success(`Set ${key} = ${value}`);
    });

  // config get <key>
  configCmd
    .command('get <key>')
    .description('Get a configuration value')
    .action(async (key: string) => {
      const config = await loadConfig();
      if (!(key in config)) {
        throw new CLIError(
          `Unknown config key "${key}".`,
          'Use "mcp-sentinel config list" to see all keys.',
        );
      }
      process.stdout.write(`${(config as unknown as Record<string, unknown>)[key]}\n`);
    });

  // config list
  configCmd
    .command('list')
    .description('List all configuration values')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const config = await loadConfig();

      if (options.json) {
        logJson(config);
        return;
      }

      heading('Configuration');
      info(`Config file: ${CONFIG_PATH}`);
      info('');
      for (const [key, value] of Object.entries(config)) {
        const envVar = `MCP_SENTINEL_${key.toUpperCase()}`;
        const envMarker = process.env[envVar] ? ' [from env]' : '';
        info(`  ${key}: ${value}${envMarker}`);
      }
    });

  // Default: show config when no subcommand given
  configCmd.action(async () => {
    const config = await loadConfig();
    heading('Configuration');
    info(`Config file: ${CONFIG_PATH}`);
    info('');
    for (const [key, value] of Object.entries(config)) {
      const envVar = `MCP_SENTINEL_${key.toUpperCase()}`;
      const envMarker = process.env[envVar] ? ' [from env]' : '';
      info(`  ${key}: ${value}${envMarker}`);
    }
  });
}

// --- helpers ---------------------------------------------------------------

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}

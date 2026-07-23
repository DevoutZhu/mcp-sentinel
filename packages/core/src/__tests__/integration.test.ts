// ============================================================
// MCP Sentinel — Integration Tests
//
// End-to-end tests that exercise every module in the core
// package: parser, probe (connectivity / protocol / tools /
// performance), and reporter.  A real MCP server over stdio
// is spawned as a child process for the probe and tool-call
// tests.
// ============================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseConfig } from '../parser.js';
import { probeServer } from '../probe.js';
import { generateReport } from '../reporter.js';
import type { ProbeResult, MCPServerConfig } from '../types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const TEST_SERVER_DIST = join(
  PROJECT_ROOT,
  'packages',
  'core',
  'dist',
  '__tests__',
  'test-server.js',
);
const MCP_JSON_PATH = join(PROJECT_ROOT, 'mcp.json');

const TEST_SERVER_CONFIG: MCPServerConfig = {
  name: 'test-server',
  transport: 'stdio',
  command: 'node',
  args: [TEST_SERVER_DIST],
};

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** Ensure the test server is compiled before probe tests run. */
function ensureBuilt(): void {
  if (!existsSync(TEST_SERVER_DIST)) {
    execSync('pnpm --filter @mcp-sentinel/core build', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
  }
  if (!existsSync(TEST_SERVER_DIST)) {
    throw new Error(
      `Test server not found at ${TEST_SERVER_DIST} after build. ` +
        'Check that tsconfig includes the __tests__ directory.',
    );
  }
}

// ---------------------------------------------------------------
// Integration test suite
// ---------------------------------------------------------------

describe('MCP Sentinel — Integration', () => {
  // =============================================================
  // PARSER — reads mcp.json
  // =============================================================
  describe('Parser', () => {
    it('should correctly parse the root mcp.json config file (测试1)', () => {
      const config = parseConfig({ configPath: MCP_JSON_PATH });

      expect(config.servers).toHaveLength(1);
      expect(config.servers[0]!.name).toBe('test-server');
      expect(config.servers[0]!.transport).toBe('stdio');
      expect(config.servers[0]!.command).toBe('node');
      expect(config.servers[0]!.args).toEqual([
        'packages/core/dist/__tests__/test-server.js',
      ]);
      expect(config.options.timeout).toBe(10_000);
      expect(config.options.concurrent).toBe(5);
    });

    it('should throw for a missing config file', () => {
      expect(() =>
        parseConfig({ configPath: join(PROJECT_ROOT, 'nonexistent.json') }),
      ).toThrow(/Configuration file not found/);
    });
  });

  // =============================================================
  // PROBE + REPORTER — requires the test server to be compiled
  // =============================================================
  describe('Probe & Reporter', () => {
    let probeResult: ProbeResult;

    // Compile the test server (if needed) and probe it once for
    // all sub-tests so the connection overhead is paid only once.
    beforeAll(async () => {
      ensureBuilt();
      probeResult = await probeServer(TEST_SERVER_CONFIG, {
        timeout: 15_000,
      });
    }, 60_000);

    // -- 测试2: Connectivity --------------------------------------------
    it('should connect to test server and pass connectivity (测试2)', () => {
      const dim = probeResult.dimensions.find(
        (d) => d.dimension === 'connectivity',
      )!;
      expect(dim).toBeDefined();
      expect(dim.passed).toBe(true);
      expect(dim.message).toContain('test-server');
    });

    // -- 测试3: Protocol compliance -------------------------------------
    it('should pass protocol compliance check (测试3)', () => {
      const dim = probeResult.dimensions.find(
        (d) => d.dimension === 'protocol',
      )!;
      expect(dim).toBeDefined();
      expect(dim.passed).toBe(true);
      const details = dim.details as Record<string, unknown> | undefined;
      expect(typeof details?.score).toBe('number');
    });

    // -- 测试4: Tools availability — tools/list -------------------------
    it('should discover echo and add via tools/list (测试4a)', () => {
      const dim = probeResult.dimensions.find(
        (d) => d.dimension === 'tools',
      )!;
      expect(dim).toBeDefined();
      expect(dim.passed).toBe(true);
      const details = dim.details as Record<string, unknown> | undefined;
      const toolNames = details?.toolNames as string[] | undefined;
      expect(toolNames).toContain('echo');
      expect(toolNames).toContain('add');
    });

    // -- 测试4: Tools callability — tools/call --------------------------
    it('should execute echo and add via tools/call (测试4b)', async () => {
      const client = new Client(
        { name: 'mcp-sentinel-test', version: '0.1.0' },
        { capabilities: {} },
      );

      try {
        const transport = new StdioClientTransport({
          command: 'node',
          args: [TEST_SERVER_DIST],
        });
        await client.connect(transport);

        // --- call echo ---
        const echoResp = await client.callTool({
          name: 'echo',
          arguments: { text: 'hello world' },
        });
        const echoContent = (
          echoResp.content as Array<{ type: string; text: string }>
        )[0];
        expect(echoContent).toBeDefined();
        expect(echoContent!.type).toBe('text');
        expect(echoContent!.text).toContain('hello world');

        // --- call add ---
        const addResp = await client.callTool({
          name: 'add',
          arguments: { a: 7, b: 3 },
        });
        const addContent = (
          addResp.content as Array<{ type: string; text: string }>
        )[0];
        expect(addContent).toBeDefined();
        expect(addContent!.type).toBe('text');
        expect(addContent!.text).toBe('10');
      } finally {
        await client.close();
      }
    }, 15_000);

    // -- Performance dimension ------------------------------------------
    it('should record a performance dimension result', () => {
      const dim = probeResult.dimensions.find(
        (d) => d.dimension === 'performance',
      )!;
      expect(dim).toBeDefined();
      expect(dim.message).toBeDefined();
    });

    // -- 测试5a: Reporter — terminal format ------------------------------
    it('should generate a terminal report (测试5a)', () => {
      const report = generateReport([probeResult], 'terminal');
      expect(report).toContain('MCP Sentinel');
      expect(report).toContain('test-server');
      expect(report).toContain('connectivity');
      expect(report).toContain('protocol');
      expect(report).toContain('tools');
      expect(report).toContain('performance');
      expect(report).toContain('security');
    });

    // -- 测试5b: Reporter — JSON format ----------------------------------
    it('should generate a valid JSON report (测试5b)', () => {
      const report = generateReport([probeResult], 'json');
      const parsed = JSON.parse(report);
      expect(parsed.total).toBe(1);
      expect(parsed.passed + parsed.failed).toBe(1);
      const first = parsed.results[0] as Record<string, unknown>;
      expect(first.serverName).toBe('test-server');
      expect(Array.isArray(first.dimensions)).toBe(true);
      expect((first.dimensions as unknown[]).length).toBe(5);
    });

    // -- 测试5c: Reporter — HTML format ----------------------------------
    it('should generate an HTML report (测试5c)', () => {
      const report = generateReport([probeResult], 'html');
      expect(report).toContain('<!DOCTYPE html>');
      expect(report).toContain('<title>MCP Sentinel');
      expect(report).toContain('test-server');
      expect(report).toContain('connectivity');
      expect(report).toContain('protocol');
      expect(report).toContain('tools');
      expect(report).toContain('performance');
      expect(report).toContain('security');
    });
  });
});

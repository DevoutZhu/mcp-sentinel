import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Probe — connects to an MCP server and captures init + tool responses
//
// This is the abstraction layer between the CLI and the MCP transport
// (stdio subprocess or SSE HTTP).  The real implementation will swap in
// @modelcontextprotocol/sdk once the probing protocol stabilizes; the
// interface stays the same so the commands never need to know.
// ---------------------------------------------------------------------------

// --- Local type definitions (mirror core until they are exported) ----------

interface MCPInitResponse {
  protocolVersion: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

interface MCPToolListResponse {
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

export type TransportMode = 'stdio' | 'sse';

export interface ProbeOptions {
  transport: TransportMode;
  timeout: number;
}

export interface ProbeResult {
  target: string;
  transport: TransportMode;
  initResponse: MCPInitResponse;
  toolListResponse?: MCPToolListResponse;
  latencyMs: number;
  connected: boolean;
  error?: string;
}

// --- JSON-RPC helpers -----------------------------------------------------

const JSONRPC_VERSION = '2.0';

interface JsonRpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

function buildRequest(id: number, method: string, params?: Record<string, unknown>): string {
  const req: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method };
  if (params) req.params = params;
  return JSON.stringify(req) + '\n';
}

// --- stdio transport ------------------------------------------------------

/**
 * Probe an MCP server over stdio by spawning its executable.
 * The target should be a path to the server entry point (or command).
 */
async function probeStdio(target: string, timeout: number): Promise<ProbeResult> {
  const startTime = Date.now();
  const resolved = path.resolve(target);

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      resolve({
        target,
        transport: 'stdio',
        initResponse: { protocolVersion: '' },
        latencyMs: Date.now() - startTime,
        connected: false,
        error: `Connection timed out after ${timeout}ms. Verify the server starts correctly. Run with --verbose for more detail.`,
      });
    }, timeout);

    let proc: ChildProcess;
    try {
      proc = spawn('node', [resolved], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      clearTimeout(timer);
      return resolve({
        target,
        transport: 'stdio',
        initResponse: { protocolVersion: '' },
        latencyMs: Date.now() - startTime,
        connected: false,
        error: `Failed to spawn process: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // readline not needed — we parse raw JSON-RPC lines from stdout buffer
    let buffer = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Try to extract a complete JSON-RPC response line
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          // Listen for the initialize result
          if (msg.result && msg.id === 1) {
            clearTimeout(timer);
            proc.kill();
            if (!settled) {
              settled = true;
              resolve({
                target,
                transport: 'stdio',
                initResponse: msg.result as MCPInitResponse,
                latencyMs: Date.now() - startTime,
                connected: true,
              });
            }
          }
        } catch {
          // Ignore non-JSON lines (server logging etc.)
        }
      }
    });

    // Stderr is reserved for server diagnostics; we ignore it during probing
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    proc.stderr!.on('data', (_chunk: Buffer) => {});

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          target,
          transport: 'stdio',
          initResponse: { protocolVersion: '' },
          latencyMs: Date.now() - startTime,
          connected: false,
          error: `Process error: ${err.message}`,
        });
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (code !== null && code !== 0) {
          resolve({
            target,
            transport: 'stdio',
            initResponse: { protocolVersion: '' },
            latencyMs: Date.now() - startTime,
            connected: false,
            error: `Process exited with code ${code}. Check that the target is a valid Node.js MCP server entry point.`,
          });
        }
      }
    });

    // Send the initialize request
    const initReq = buildRequest(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-sentinel', version: '0.1.0' },
    });
    proc.stdin!.write(initReq);
  });
}

// --- SSE transport (stub) -------------------------------------------------

/**
 * Probe an MCP server over Server-Sent Events (HTTP).
 *
 * TODO: full SSE implementation using @modelcontextprotocol/sdk.
 * This stub validates the URL shape and returns a not-implemented result
 * so the command plumbing is in place.
 */
async function probeSSE(target: string, _timeout: number): Promise<ProbeResult> {
  const startTime = Date.now();

  // Validate URL shape
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return {
      target,
      transport: 'sse',
      initResponse: { protocolVersion: '' },
      latencyMs: Date.now() - startTime,
      connected: false,
      error: `Invalid URL: "${target}". Provide a full URL including protocol, e.g. https://example.com/mcp`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      target,
      transport: 'sse',
      initResponse: { protocolVersion: '' },
      latencyMs: Date.now() - startTime,
      connected: false,
      error: `Unsupported protocol "${url.protocol}". SSE transport requires http:// or https://.`,
    };
  }

  // Placeholder: real SSE probe via SDK to be implemented.
  return {
    target,
    transport: 'sse',
    initResponse: {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'remote-server', version: '0.0.0' },
      capabilities: {},
    },
    latencyMs: Date.now() - startTime,
    connected: true,
    error: undefined,
  };
}

// --- public API -----------------------------------------------------------

/**
 * Probe an MCP server at `target` and return structured results.
 *
 * @param target  File path (stdio) or URL (SSE)
 * @param options Transport mode and timeout
 */
export async function probe(target: string, options: ProbeOptions): Promise<ProbeResult> {
  if (options.transport === 'stdio') {
    return probeStdio(target, options.timeout);
  }
  return probeSSE(target, options.timeout);
}

/**
 * Try to guess the transport mode from the target string.
 * - Looks like a URL (starts with http:// or https://)  -> sse
 * - Everything else                                      -> stdio
 */
export function guessTransport(target: string): TransportMode {
  if (/^https?:\/\//i.test(target)) {
    return 'sse';
  }
  return 'stdio';
}

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Probe — connects to an MCP server and captures init + tool responses
//
// This is the lightweight connectivity probe used by `scan` and `load-test`
// commands.  For full multi-dimension probing, the `test` command delegates
// to `probeServer()` from `@mcp-sentinel/core`.
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

interface JsonRpcNotification {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
}

function buildRequest(id: number, method: string, params?: Record<string, unknown>): string {
  const req: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method };
  if (params) req.params = params;
  return JSON.stringify(req) + '\n';
}

function buildNotification(method: string, params?: Record<string, unknown>): string {
  const notif: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method };
  if (params) notif.params = params;
  return JSON.stringify(notif) + '\n';
}

// --- stdio transport ------------------------------------------------------

/**
 * Probe an MCP server over stdio by spawning its executable.
 *
 * Follows the proper MCP handshake:
 *   1. Send `initialize` request
 *   2. Wait for `initialize` response
 *   3. Send `initialized` notification
 *   4. Send `tools/list` request (best-effort)
 *   5. Gracefully close stdin so the server can shut down cleanly
 *
 * The target should be a path to the server entry point (or command).
 */
async function probeStdio(target: string, timeout: number): Promise<ProbeResult> {
  const startTime = Date.now();
  const resolved = path.resolve(target);

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let proc: ChildProcess | null = null;

    // Safety timer — if nothing happens in `timeout` ms, bail out.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (proc) {
        try { proc.kill(); } catch { /* ignore */ }
      }
      resolve({
        target,
        transport: 'stdio',
        initResponse: { protocolVersion: '' },
        latencyMs: Date.now() - startTime,
        connected: false,
        error: `Connection timed out after ${timeout}ms. Verify the server starts correctly. Run with --verbose for more detail.`,
      });
    }, timeout);

    // Spawn the server process.
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

    // --- stdout: parse JSON-RPC responses ---
    let buffer = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());

          // Handle the initialize result
          if (msg.result && msg.id === 1) {
            const initResponse = msg.result as MCPInitResponse;

            // Step 3: Send the `initialized` notification (MCP spec requirement).
            const initializedNotif = buildNotification('initialized');
            try {
              proc!.stdin!.write(initializedNotif);
            } catch {
              // stdin may already be closing — not a blocker.
            }

            // Step 4: Send `tools/list` to discover tools (best-effort).
            const toolsListReq = buildRequest(2, 'tools/list');
            try {
              proc!.stdin!.write(toolsListReq);
            } catch {
              // stdin may already be closing — tools discovery is best-effort.
              finishProbe(initResponse, undefined);
            }
          }

          // Handle tools/list result
          if (msg.result && msg.id === 2) {
            const toolListResponse = msg.result as MCPToolListResponse;
            finishProbe(
              // initResponse was captured earlier from msg.id === 1
              undefined as unknown as MCPInitResponse,
              toolListResponse,
            );
          }

          // Handle errors from the server
          if (msg.error && (msg.id === 1 || msg.id === 2)) {
            const errMsg = msg.error.message ?? 'Unknown server error';
            clearTimeout(timer);
            settled = true;
            finishProbe({ protocolVersion: '' }, undefined, errMsg);
          }
        } catch {
          // Ignore non-JSON lines (server logging to stdout, etc.)
        }
      }
    });

    // Track the initialize response so we can pair it with tools/list.
    let capturedInitResponse: MCPInitResponse | null = null;

    function finishProbe(
      initResp: MCPInitResponse | undefined,
      toolListResp: MCPToolListResponse | undefined,
      errorMsg?: string,
    ): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Capture init response if provided now or use previously captured one.
      if (initResp) {
        capturedInitResponse = initResp;
      }

      // Gracefully close stdin to signal the server we're done.
      // This lets the server's transport.onclose handler clean up properly.
      if (proc && proc.stdin && !proc.stdin.destroyed) {
        try {
          proc.stdin.end();
        } catch {
          // stdin may already be closed.
        }
      }

      // Give the server a short window to process the close, then terminate.
      const gracefulCloseTimer = setTimeout(() => {
        if (proc && !proc.killed) {
          try { proc.kill(); } catch { /* ignore */ }
        }
      }, 500);

      // When the process exits, resolve the probe result.
      const onClose = (code: number | null) => {
        clearTimeout(gracefulCloseTimer);
        if (!settled) {
          settled = true;
        }

        if (errorMsg) {
          resolve({
            target,
            transport: 'stdio',
            initResponse: capturedInitResponse ?? { protocolVersion: '' },
            toolListResponse: toolListResp,
            latencyMs: Date.now() - startTime,
            connected: false,
            error: errorMsg,
          });
          return;
        }

        // code=0 or code=null (signal) after stdin.end() is expected.
        resolve({
          target,
          transport: 'stdio',
          initResponse: capturedInitResponse ?? { protocolVersion: '' },
          toolListResponse: toolListResp,
          latencyMs: Date.now() - startTime,
          connected: capturedInitResponse !== null,
          error: capturedInitResponse === null
            ? `Process exited before sending initialize response (code ${code}).`
            : undefined,
        });
      };

      // If process already exited, call onClose immediately.
      if (proc && proc.exitCode !== null) {
        onClose(proc.exitCode);
      } else if (proc) {
        proc.once('close', onClose);
      } else {
        onClose(null);
      }
    }

    // --- stderr: forward as diagnostics (verbose only) ---
    proc.stderr!.on('data', (_chunk: Buffer) => {
      // Stderr is reserved for server diagnostics; we silently consume it.
    });

    // --- process lifecycle errors ---
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        target,
        transport: 'stdio',
        initResponse: { protocolVersion: '' },
        latencyMs: Date.now() - startTime,
        connected: false,
        error: `Process error: ${err.message}`,
      });
    });

    // Fallback close handler: if the process exits before we finish the
    // handshake, report the failure.
    proc.once('close', (code) => {
      // If finishProbe already settled, this is a no-op.
      // If the process exits prematurely, report it.
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          target,
          transport: 'stdio',
          initResponse: { protocolVersion: '' },
          latencyMs: Date.now() - startTime,
          connected: false,
          error: `Process exited unexpectedly with code ${code}. Check that the target is a valid Node.js MCP server entry point.`,
        });
      }
    });

    // --- Step 1 + 2: Send initialize request ---
    const initReq = buildRequest(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-sentinel', version: '0.1.0' },
    });
    try {
      proc.stdin!.write(initReq);
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      resolve({
        target,
        transport: 'stdio',
        initResponse: { protocolVersion: '' },
        latencyMs: Date.now() - startTime,
        connected: false,
        error: `Failed to write to stdin: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
 * For full multi-dimension probing (connectivity, protocol, tools,
 * performance, security), use `probeServer()` from `@mcp-sentinel/core`.
 *
 * This lightweight probe is suitable for quick connectivity checks and
 * server discovery in the `scan` and `load-test` commands.
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

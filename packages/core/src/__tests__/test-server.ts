// ============================================================
// MCP Sentinel — Integration Test Server
//
// A minimal MCP server over stdio used by the integration test
// suite.  It exposes two tools:
//   - echo — returns the input text prefixed with "Echo: "
//   - add  — returns the sum of two numbers as a string
//
// This server uses the low-level `Server` class from the MCP SDK
// to give us full control over JSON-RPC request handling.
//
// IMPORTANT: do NOT console.log() — stdout is reserved for the
// JSON-RPC transport.  Use console.error() for diagnostics.
// ============================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// -----------------------------------------------------------
// Server setup
// -----------------------------------------------------------

const server = new Server(
  { name: 'test-server', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
    },
  },
);

// -----------------------------------------------------------
// tools/list — advertise echo and add
// -----------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes back the input string',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'The text to echo back',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: 'Adds two numbers together',
      inputSchema: {
        type: 'object' as const,
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
        },
        required: ['a', 'b'],
      },
    },
  ],
}));

// -----------------------------------------------------------
// tools/call — dispatch echo and add
// -----------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'echo': {
      const text = args && typeof args.text === 'string' ? args.text : '';
      return {
        content: [{ type: 'text' as const, text: `Echo: ${text}` }],
      };
    }
    case 'add': {
      const a = args && typeof args.a === 'number' ? args.a : 0;
      const b = args && typeof args.b === 'number' ? args.b : 0;
      return {
        content: [{ type: 'text' as const, text: String(a + b) }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// -----------------------------------------------------------
// Bootstrap — connect stdio transport and wait
// -----------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();

  // Exit cleanly when the client disconnects (stdin closes).
  transport.onclose = () => {
    process.exit(0);
  };

  await server.connect(transport);

  // The server is now listening on stdin.  The connect()
  // resolves once the transport is started; the process stays
  // alive because of the active stdio streams.
}

main().catch((err: unknown) => {
  console.error('test-server fatal error:', err);
  process.exit(1);
});

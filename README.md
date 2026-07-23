# MCP Sentinel

**Postman for MCP** — discover, probe, and monitor Model Context Protocol servers.

Automatically connect to MCP servers, validate protocol compliance, test tool availability, and measure response performance — all from a single CLI.

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Build all packages
pnpm build

# 3. Run a health check against an MCP server
pnpm --filter @mcp-sentinel/cli exec mcp-sentinel probe --url http://localhost:3000
```

## Features

- **Server Discovery** — automatically detect MCP servers from `mcp.json` configuration or environment variables
- **Protocol Validation** — verify that servers correctly implement the MCP handshake and initialization sequence
- **Tool Testing** — list available tools and execute test calls to verify correctness
- **Performance Monitoring** — measure response latency and flag slow endpoints (>3s threshold)
- **Concurrency Control** — limit simultaneous connections (default: 5) to prevent resource exhaustion
- **Structured Reports** — JSON, table, and summary output formats for CI pipelines and human review

## Architecture

```
mcp-sentinel/
├── packages/
│   ├── core/     # Protocol validation engine
│   └── cli/      # Command-line interface
├── docs/         # Design documents
└── CLAUDE.md     # Project charter
```

## Screenshot

<!-- TODO: Add terminal screenshot showing a successful probe run -->
![Screenshot placeholder](docs/screenshot.png)

## Requirements

- Node.js >= 20
- pnpm >= 9

## License

Apache-2.0

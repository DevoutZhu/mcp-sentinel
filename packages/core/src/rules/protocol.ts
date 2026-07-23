import { ValidationRule } from '../validator.js';

// ============================================================
// MCP Protocol Compliance Rules (5 rules)
// Based on MCP spec: https://spec.modelcontextprotocol.io/
// ============================================================

export const protocolRules: ValidationRule[] = [
  (ctx) => ({
    id: 'MCP-001',
    name: 'Protocol version declared',
    description: 'Initialize response must include protocolVersion field',
    severity: 'error',
    passed: typeof ctx.initResponse.protocolVersion === 'string',
    message: typeof ctx.initResponse.protocolVersion === 'string'
      ? 'protocolVersion is declared'
      : 'protocolVersion field is missing or not a string',
  }),

  (ctx) => ({
    id: 'MCP-002',
    name: 'Protocol version format',
    description: 'protocolVersion must follow semver or date-based format (e.g. "2024-11-05")',
    severity: 'error',
    passed: /^\d{4}-\d{2}-\d{2}$/.test(ctx.initResponse.protocolVersion) ||
            /^\d+\.\d+(\.\d+)?$/.test(ctx.initResponse.protocolVersion),
    message: `protocolVersion "${ctx.initResponse.protocolVersion}" — format accepted`,
  }),

  (ctx) => ({
    id: 'MCP-003',
    name: 'Server info provided',
    description: 'serverInfo should be present in initialize response',
    severity: 'warning',
    passed: ctx.initResponse.serverInfo !== undefined,
    message: ctx.initResponse.serverInfo
      ? 'serverInfo is present'
      : 'serverInfo is missing (recommended for debugging)',
  }),

  (ctx) => ({
    id: 'MCP-004',
    name: 'Server name declared',
    description: 'serverInfo.name should be present',
    severity: 'warning',
    passed: ctx.initResponse.serverInfo?.name !== undefined,
    message: ctx.initResponse.serverInfo?.name
      ? `Server name: "${ctx.initResponse.serverInfo.name}"`
      : 'serverInfo.name is missing (recommended)',
  }),

  (ctx) => ({
    id: 'MCP-005',
    name: 'Capabilities declared',
    description: 'Initialize response should declare capabilities',
    severity: 'warning',
    passed: ctx.initResponse.capabilities !== undefined,
    message: ctx.initResponse.capabilities
      ? 'capabilities object present'
      : 'capabilities field is missing — server may not advertise its features',
  }),
];

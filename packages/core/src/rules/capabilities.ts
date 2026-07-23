import { ValidationRule } from '../validator.js';

// ============================================================
// Capability Detection Rules
// ============================================================

export const capabilityRules: ValidationRule[] = [
  (ctx) => ({
    id: 'MCP-010',
    name: 'Tools capability',
    description: 'If server claims tools capability, tools/list should return valid tools',
    severity: 'info',
    passed: ctx.initResponse.capabilities?.tools !== undefined
      ? ctx.toolListResponse?.tools !== undefined && Array.isArray(ctx.toolListResponse.tools)
      : true, // Not applicable if server doesn't claim tools capability
    message: ctx.initResponse.capabilities?.tools === undefined
      ? 'Skipped — server does not advertise tools capability'
      : ctx.toolListResponse?.tools
        ? `Server exposes ${ctx.toolListResponse.tools.length} tool(s)`
        : 'Server claims tools capability but tools/list is empty or invalid',
  }),

  (ctx) => ({
    id: 'MCP-011',
    name: 'Tool inputSchema validity',
    description: 'Each tool must have a valid inputSchema (JSON Schema object)',
    severity: 'warning',
    passed: ctx.toolListResponse?.tools
      ? ctx.toolListResponse.tools.every(t => t.inputSchema && typeof t.inputSchema === 'object')
      : true,
    message: ctx.toolListResponse?.tools
      ? ctx.toolListResponse.tools.every(t => t.inputSchema && typeof t.inputSchema === 'object')
        ? 'All tools have valid inputSchema'
        : 'One or more tools are missing inputSchema'
      : 'Skipped — no tools to validate',
  }),

  (ctx) => ({
    id: 'MCP-012',
    name: 'Tool name format',
    description: 'Tool names should use snake_case naming convention',
    severity: 'info',
    passed: ctx.toolListResponse?.tools
      ? ctx.toolListResponse.tools.every(t => /^[a-z][a-z0-9_]*$/.test(t.name))
      : true,
    message: ctx.toolListResponse?.tools
      ? ctx.toolListResponse.tools.every(t => /^[a-z][a-z0-9_]*$/.test(t.name))
        ? 'All tool names follow snake_case convention'
        : 'Some tool names deviate from snake_case convention'
      : 'Skipped — no tools to validate',
  }),
];

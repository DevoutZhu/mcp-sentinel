import { describe, it, expect } from 'vitest';

describe('MCP Sentinel — Core', () => {
  it('should load the core module', async () => {
    const mod = await import('../index.js');
    expect(mod).toBeDefined();
  });

  it('should pass a basic smoke test', () => {
    expect(1 + 1).toBe(2);
  });
});

import { ComplianceReport, RuleResult } from './types.js';

export interface MCPInitResponse {
  protocolVersion: string;
  serverInfo?: {
    name?: string;
    version?: string;
  };
  capabilities?: Record<string, unknown>;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolListResponse {
  tools: MCPTool[];
}

export type ValidationRule = (context: {
  initResponse: MCPInitResponse;
  toolListResponse?: MCPToolListResponse;
}) => RuleResult | null;

export class ProtocolValidator {
  private rules: ValidationRule[] = [];

  register(rule: ValidationRule): void {
    this.rules.push(rule);
  }

  validate(initResponse: MCPInitResponse, toolListResponse?: MCPToolListResponse): ComplianceReport {
    const results: RuleResult[] = [];

    for (const rule of this.rules) {
      const result = rule({ initResponse, toolListResponse });
      if (result) results.push(result);
    }

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const score = results.length > 0 ? Math.round((passed / results.length) * 100) : 100;

    return {
      serverName: initResponse.serverInfo?.name ?? 'unknown',
      score,
      totalRules: results.length,
      passedRules: passed,
      failedRules: failed,
      results,
      timestamp: new Date(),
    };
  }

  getRuleCount(): number {
    return this.rules.length;
  }
}

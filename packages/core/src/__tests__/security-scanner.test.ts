// ============================================================
// MCP Sentinel — Security Scanner Tests
//
// Tests cover:
//   1. Static helpers (isSSRFParam, detectPII)
//   2. generateSecurityReport (Markdown output)
//   3. scanServer static checks (missing auth)
//   4. Integration — security findings in ProbeResult
// ============================================================

import { describe, it, expect } from 'vitest';

import {
  isSSRFParam,
  detectPII,
  generateSecurityReport,
  scanServer,
  SSRF_SUSPICIOUS_PARAMS,
  PII_PATTERNS,
  INJECTION_PAYLOADS,
} from '../security-scanner.js';
import type { SecurityFinding } from '../security-scanner.js';
import type { MCPServerConfig } from '../types.js';

// ============================================================
// 1. Static helpers
// ============================================================

describe('isSSRFParam', () => {
  it('should flag exact SSRF-suspicious parameter names', () => {
    for (const param of SSRF_SUSPICIOUS_PARAMS) {
      expect(isSSRFParam(param)).toBe(true);
    }
  });

  it('should flag parameter names containing SSRF keywords', () => {
    expect(isSSRFParam('targetUrl')).toBe(true);
    expect(isSSRFParam('fetchUrl')).toBe(true);
    expect(isSSRFParam('callbackUrl')).toBe(true);
    expect(isSSRFParam('webhookEndpoint')).toBe(true);
    expect(isSSRFParam('imagePath')).toBe(true);
    expect(isSSRFParam('redirectUri')).toBe(true);
  });

  it('should not flag benign parameter names', () => {
    expect(isSSRFParam('name')).toBe(false);
    expect(isSSRFParam('description')).toBe(false);
    expect(isSSRFParam('count')).toBe(false);
    expect(isSSRFParam('enabled')).toBe(false);
    expect(isSSRFParam('timeout')).toBe(false);
    expect(isSSRFParam('maxRetries')).toBe(false);
  });
});

describe('detectPII', () => {
  it('should detect email addresses', () => {
    const result = detectPII('Contact us at test@example.com for support.');
    expect(result).toContain('email');
  });

  it('should detect Chinese mobile numbers', () => {
    const result = detectPII('Phone: 13800138000');
    expect(result).toContain('phone-cn');
  });

  it('should detect Chinese ID card numbers', () => {
    const result = detectPII('ID: 110101199001011234');
    expect(result).toContain('id-card-cn');
  });

  it('should detect multiple PII types in the same text', () => {
    const text =
      'User: alice@test.com, Phone: 13912345678, ID: 320102198506152345';
    const result = detectPII(text);
    expect(result).toContain('email');
    expect(result).toContain('phone-cn');
    expect(result).toContain('id-card-cn');
  });

  it('should return empty array for clean text', () => {
    const result = detectPII('Hello world, this is a test.');
    expect(result).toEqual([]);
  });

  it('should not match partial patterns', () => {
    // 10 digits is not a valid Chinese mobile number (needs 11 digits starting with 1)
    const result = detectPII('Code: 1234567890');
    expect(result).not.toContain('phone-cn');
  });
});

// ============================================================
// 2. Constants
// ============================================================

describe('Constants', () => {
  it('SSRF_SUSPICIOUS_PARAMS should be a non-empty array', () => {
    expect(SSRF_SUSPICIOUS_PARAMS.length).toBeGreaterThan(0);
    expect(SSRF_SUSPICIOUS_PARAMS).toContain('url');
  });

  it('PII_PATTERNS should include email, phone-cn, and id-card-cn', () => {
    const names = PII_PATTERNS.map((p) => p.name);
    expect(names).toContain('email');
    expect(names).toContain('phone-cn');
    expect(names).toContain('id-card-cn');
  });

  it('INJECTION_PAYLOADS should be a non-empty array', () => {
    expect(INJECTION_PAYLOADS.length).toBeGreaterThan(0);
  });

  it('each PII pattern should have name, label, and regex', () => {
    for (const p of PII_PATTERNS) {
      expect(p.name).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.regex).toBeInstanceOf(RegExp);
    }
  });
});

// ============================================================
// 3. generateSecurityReport
// ============================================================

describe('generateSecurityReport', () => {
  it('should produce a PASSED report when there are no findings', () => {
    const report = generateSecurityReport([]);
    expect(report).toContain('# MCP Sentinel — Security Scan Report');
    expect(report).toContain('PASSED');
    expect(report).toContain('No security risks detected');
  });

  it('should include severity counts in the report', () => {
    const findings: SecurityFinding[] = [
      {
        id: 'SSRF-001',
        severity: 'critical',
        category: 'SSRF',
        description: 'Test SSRF finding',
        remediation: 'Fix SSRF',
      },
      {
        id: 'AUTH-001',
        severity: 'high',
        category: 'Missing Auth',
        description: 'Test auth finding',
        remediation: 'Add auth',
      },
      {
        id: 'DOS-001',
        severity: 'medium',
        category: 'Unbounded Output',
        description: 'Test DoS finding',
        remediation: 'Add limits',
      },
      {
        id: 'INFO-001',
        severity: 'low',
        category: 'Info',
        description: 'Test info finding',
        remediation: 'Review',
      },
    ];

    const report = generateSecurityReport(findings);

    expect(report).toContain('CRITICAL');
    expect(report).toContain('| Critical | 1 |');
    expect(report).toContain('| High     | 1 |');
    expect(report).toContain('| Medium   | 1 |');
    expect(report).toContain('| Low      | 1 |');
    expect(report).toContain('| **Total**| **4** |');
  });

  it('should report overall severity as the highest finding severity', () => {
    const criticalFindings: SecurityFinding[] = [
      {
        id: 'SSRF-001',
        severity: 'critical',
        category: 'SSRF',
        description: 'Critical issue',
        remediation: 'Fix',
      },
    ];
    expect(generateSecurityReport(criticalFindings)).toContain(
      '**Overall Severity: CRITICAL**',
    );

    const highFindings: SecurityFinding[] = [
      {
        id: 'AUTH-001',
        severity: 'high',
        category: 'Missing Auth',
        description: 'High issue',
        remediation: 'Fix',
      },
    ];
    expect(generateSecurityReport(highFindings)).toContain(
      '**Overall Severity: HIGH**',
    );
  });

  it('should group findings by category', () => {
    const findings: SecurityFinding[] = [
      {
        id: 'SSRF-001',
        severity: 'critical',
        category: 'SSRF',
        description: 'SSRF issue 1',
        remediation: 'Fix 1',
      },
      {
        id: 'SSRF-002',
        severity: 'high',
        category: 'SSRF',
        description: 'SSRF issue 2',
        remediation: 'Fix 2',
      },
      {
        id: 'AUTH-001',
        severity: 'high',
        category: 'Missing Auth',
        description: 'Auth issue',
        remediation: 'Add auth',
      },
    ];

    const report = generateSecurityReport(findings);

    // Both SSRF findings should be under one ### SSRF section.
    const ssrfSectionIndex = report.indexOf('### SSRF');
    const authSectionIndex = report.indexOf('### Missing Auth');
    expect(ssrfSectionIndex).toBeGreaterThan(0);
    expect(authSectionIndex).toBeGreaterThan(0);
  });

  it('should include remediation in each finding', () => {
    const findings: SecurityFinding[] = [
      {
        id: 'SSRF-001',
        severity: 'critical',
        category: 'SSRF',
        description: 'SSRF risk',
        remediation: 'Use an allowlist of domains.',
      },
    ];

    const report = generateSecurityReport(findings);
    expect(report).toContain('Use an allowlist of domains.');
    expect(report).toContain('*Remediation*');
  });

  it('should include a timestamp', () => {
    const report = generateSecurityReport([]);
    expect(report).toContain('Report generated at');
  });
});

// ============================================================
// 4. scanServer — static checks (no live server required)
// ============================================================

describe('scanServer — static analysis', () => {
  it('should flag missing auth when no env is configured', async () => {
    const config: MCPServerConfig = {
      name: 'no-auth-server',
      transport: 'stdio',
      command: 'nonexistent-command',
    };

    const findings = await scanServer(config);

    // Should contain the static auth finding.
    const authFinding = findings.find((f) => f.id === 'AUTH-001');
    expect(authFinding).toBeDefined();
    expect(authFinding!.severity).toBe('high');
    expect(authFinding!.category).toBe('Missing Auth');
    expect(authFinding!.description).toContain('no-auth-server');
  });

  it('should not flag missing auth when API_KEY is present in env', async () => {
    const config: MCPServerConfig = {
      name: 'auth-server',
      transport: 'stdio',
      command: 'nonexistent-command',
      env: { API_KEY: 'sk-test-123' },
    };

    const findings = await scanServer(config);

    // Should not produce AUTH-001 since env has auth.
    const authFinding = findings.find((f) => f.id === 'AUTH-001');
    expect(authFinding).toBeUndefined();
  });

  it('should not flag missing auth when AUTH_TOKEN is present in env', async () => {
    const config: MCPServerConfig = {
      name: 'token-server',
      transport: 'stdio',
      command: 'nonexistent-command',
      env: { AUTH_TOKEN: 'bearer-token' },
    };

    const findings = await scanServer(config);

    const authFinding = findings.find((f) => f.id === 'AUTH-001');
    expect(authFinding).toBeUndefined();
  });

  it('should not flag missing auth when SECRET is present in env', async () => {
    const config: MCPServerConfig = {
      name: 'secret-server',
      transport: 'stdio',
      command: 'nonexistent-command',
      env: { CLIENT_SECRET: 'shh' },
    };

    const findings = await scanServer(config);

    const authFinding = findings.find((f) => f.id === 'AUTH-001');
    expect(authFinding).toBeUndefined();
  });

  it('should return a scan error finding when connection fails', async () => {
    const config: MCPServerConfig = {
      name: 'dead-server',
      transport: 'stdio',
      command: 'nonexistent-command-that-will-fail',
    };

    const findings = await scanServer(config);

    const scanError = findings.find((f) => f.id === 'SCAN-001');
    expect(scanError).toBeDefined();
    expect(scanError!.severity).toBe('medium');
    expect(scanError!.category).toBe('Scan Error');
  });

  it('should return findings sorted by severity (critical first)', async () => {
    // Even on a failed connection, the static AUTH finding
    // and the SCAN error should be ordered correctly.
    const config: MCPServerConfig = {
      name: 'sort-test',
      transport: 'stdio',
      command: 'nonexistent-command',
    };

    const findings = await scanServer(config);

    // Both findings should be present.
    expect(findings.length).toBeGreaterThanOrEqual(2);

    // High severity (AUTH-001) should come before medium (SCAN-001).
    const authIdx = findings.findIndex((f) => f.id === 'AUTH-001');
    const scanIdx = findings.findIndex((f) => f.id === 'SCAN-001');
    expect(authIdx).toBeLessThan(scanIdx);
  });
});

// ============================================================
// 5. PII regex precision
// ============================================================

describe('PII regex precision', () => {
  it('email regex should not match strings without TLD', () => {
    expect(detectPII('user@host')).toEqual([]);
  });

  it('email regex should match common formats', () => {
    expect(detectPII('a@b.co')).toContain('email');
    expect(detectPII('test.user+tag@example.com')).toContain('email');
    expect(detectPII('user@sub.example.co.uk')).toContain('email');
  });

  it('phone-cn regex should match valid Chinese mobile numbers', () => {
    expect(detectPII('13800138000')).toContain('phone-cn');
    expect(detectPII('15912345678')).toContain('phone-cn');
    expect(detectPII('18888888888')).toContain('phone-cn');
  });

  it('phone-cn regex should not match invalid prefixes', () => {
    // Numbers starting with 2 are not Chinese mobile numbers.
    expect(detectPII('23800138000')).toEqual([]);
    expect(detectPII('12012345678')).toEqual([]);
  });

  it('id-card-cn regex should match 18-digit IDs', () => {
    expect(detectPII('110101199001011234')).toContain('id-card-cn');
    expect(detectPII('32010219850615234X')).toContain('id-card-cn');
    expect(detectPII('44030519780321211x')).toContain('id-card-cn');
  });

  it('id-card-cn regex should not match 15-digit numbers', () => {
    // Old 15-digit IDs are not matched by the current pattern.
    expect(detectPII('110101900101123')).toEqual([]);
  });
});

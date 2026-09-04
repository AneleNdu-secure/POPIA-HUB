import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withTenantDb,
  validateTenantId,
  TenantSecurityError,
  pool,
} from '../lib/db/index.js';

describe('Multi-Tenant Security & Isolation Layer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Fail-Safe Tenant ID Validation', () => {
    it('should reject non-string and empty tenant IDs immediately', async () => {
      expect(() => validateTenantId(undefined)).toThrow(TenantSecurityError);
      expect(() => validateTenantId(null)).toThrow(TenantSecurityError);
      expect(() => validateTenantId('')).toThrow(TenantSecurityError);
      expect(() => validateTenantId('   ')).toThrow(TenantSecurityError);
    });

    it('should reject malformed or non-UUID tenant IDs', async () => {
      expect(() => validateTenantId('12345')).toThrow(TenantSecurityError);
      expect(() => validateTenantId('not-a-valid-uuid')).toThrow(TenantSecurityError);
      expect(() => validateTenantId('123e4567-e89b-12d3-a456-42661417400')).toThrow(
        TenantSecurityError
      ); // 1 char short
    });

    it('should reject SQL injection payloads attempting to bypass session variables', async () => {
      const injectionPayloads = [
        "'; DROP TABLE tenants; --",
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' OR '1'='1",
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11; SELECT * FROM pg_user;",
        "admin'; SET LOCAL app.current_tenant_id = 'all'; --",
      ];

      for (const payload of injectionPayloads) {
        expect(() => validateTenantId(payload)).toThrow(TenantSecurityError);
      }
    });

    it('should normalize and accept valid RFC 4122 UUIDs', () => {
      const validUuidUpper = 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11';
      const validUuidLower = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

      expect(validateTenantId(validUuidUpper)).toBe(validUuidLower);
      expect(validateTenantId(validUuidLower)).toBe(validUuidLower);
    });
  });

  describe('2. Fail-Safe withTenantDb Transaction Execution', () => {
    it('should reject naked queries without leasing a connection from the pool', async () => {
      const poolConnectSpy = vi.spyOn(pool, 'connect');

      await expect(
        withTenantDb('invalid-tenant-id', async () => {
          return 'should never run';
        })
      ).rejects.toThrow(TenantSecurityError);

      expect(poolConnectSpy).not.toHaveBeenCalled();
    });

    it('should execute transaction lifecycle: BEGIN -> SET LOCAL -> operation -> COMMIT -> release', async () => {
      const tenantId = 'e2b3c4d5-6789-4abc-def0-123456789abc';
      const queriesExecuted: string[] = [];

      const mockClient = {
        query: vi.fn(async (queryText: string | { text: string }, _values?: unknown[]) => {
          const sql = typeof queryText === 'string' ? queryText : queryText.text;
          queriesExecuted.push(sql);
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };

      vi.spyOn(pool, 'connect').mockResolvedValue(mockClient as any);

      const result = await withTenantDb(tenantId, async (_tx) => {
        return { success: true, data: 'secure tenant data' };
      });

      expect(result).toEqual({ success: true, data: 'secure tenant data' });

      // Verify strict transaction sequence
      expect(queriesExecuted).toContain('BEGIN');
      expect(queriesExecuted).toContain(
        `SET LOCAL app.current_tenant_id = '${tenantId}'`
      );
      expect(queriesExecuted).toContain('COMMIT');
      expect(queriesExecuted).not.toContain('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should execute ROLLBACK and always release client on operation failure', async () => {
      const tenantId = 'e2b3c4d5-6789-4abc-def0-123456789abc';
      const queriesExecuted: string[] = [];

      const mockClient = {
        query: vi.fn(async (queryText: string | { text: string }) => {
          const sql = typeof queryText === 'string' ? queryText : queryText.text;
          queriesExecuted.push(sql);
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };

      vi.spyOn(pool, 'connect').mockResolvedValue(mockClient as any);

      await expect(
        withTenantDb(tenantId, async () => {
          throw new Error('Simulated database execution failure');
        })
      ).rejects.toThrow('Simulated database execution failure');

      expect(queriesExecuted).toContain('BEGIN');
      expect(queriesExecuted).toContain('ROLLBACK');
      expect(queriesExecuted).not.toContain('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. PostgreSQL RLS Zero-Row Blocking Principle', () => {
    it('should demonstrate that NULL current_setting evaluates to zero rows in SQL logic', () => {
      // PostgreSQL ternary logic simulation:
      // When app.current_tenant_id is not set:
      // current_setting('app.current_tenant_id', true) -> null
      // NULLIF(null, '') -> null
      // tenant_id = null -> NULL (falsy in SQL WHERE/USING)
      const currentSetting = (hasSessionVar: boolean) => (hasSessionVar ? 'tenant-1' : null);
      const nullIfEmpty = (val: string | null) => (val === '' ? null : val);
      const rlsCondition = (rowTenantId: string, sessionVarActive: boolean) => {
        const setting = currentSetting(sessionVarActive);
        const resolvedTenant = nullIfEmpty(setting);
        if (resolvedTenant === null) {
          // SQL 3-valued logic: column = NULL yields NULL (row excluded)
          return false;
        }
        return rowTenantId === resolvedTenant;
      };

      const rowA = { id: 'row-1', tenant_id: 'tenant-1' };
      const rowB = { id: 'row-2', tenant_id: 'tenant-2' };

      // Case A: Unauthenticated / naked query (session variable unset)
      expect(rlsCondition(rowA.tenant_id, false)).toBe(false);
      expect(rlsCondition(rowB.tenant_id, false)).toBe(false);

      // Case B: Scoped to Tenant 1
      expect(rlsCondition(rowA.tenant_id, true)).toBe(true);
      expect(rlsCondition(rowB.tenant_id, true)).toBe(false);
    });
  });
});

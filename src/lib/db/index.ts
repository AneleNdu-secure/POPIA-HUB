import pg from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// ==============================================================================
// 1. Connection Pool Configuration (Production-Grade Neon / Supabase Support)
// ==============================================================================

const connectionString =
  process.env.DATABASE_URL ||
  process.env.DIRECT_URL ||
  'postgresql://postgres:postgres@localhost:5432/popia_hub';

// Supabase (both pooler.supabase.com and db.<ref>.supabase.co), Neon, and remote hosts require SSL
const isLocalhost =
  connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

const isSupabase =
  connectionString.includes('supabase.co') ||
  connectionString.includes('supabase.com') ||
  connectionString.includes('pooler.supabase');

const requiresSsl =
  isSupabase ||
  connectionString.includes('neon.tech') ||
  process.env.DB_SSL === 'true' ||
  (!isLocalhost && process.env.NODE_ENV === 'production') ||
  (!isLocalhost && process.env.DB_SSL !== 'false');

export const pool = new Pool({
  connectionString,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS || '5000',
    10
  ),
  ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
});

// Root Drizzle database instance (Warning: queries executed here without tenant context
// will return zero rows or fail check constraints due to PostgreSQL RLS policies).
export const rootDb = drizzle(pool, { schema });

// Type definitions for scoped tenant transaction databases
export type DrizzleSchema = typeof schema;
export type DrizzleTransaction = NodePgDatabase<DrizzleSchema>;
export type TenantDbClient = DrizzleTransaction;

// ==============================================================================
// 2. Security Exceptions & UUID Validation
// ==============================================================================

/**
 * Custom security exception thrown when tenant isolation requirements are violated.
 */
export class TenantSecurityError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'TENANT_SECURITY_VIOLATION') {
    super(message);
    this.name = 'TenantSecurityError';
    this.code = code;
    Object.setPrototypeOf(this, TenantSecurityError.prototype);
  }
}

/**
 * Strict UUID format regex (8-4-4-4-12 hex digits).
 * Conforms to PostgreSQL native UUID parser while eliminating SQL injection,
 * malicious escapes, and malformed strings before database execution.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates whether a given string is a strictly compliant UUID.
 * @param id Candidate tenant identifier
 * @returns validated UUID string
 * @throws TenantSecurityError if invalid or empty
 */
export function validateTenantId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TenantSecurityError(
      'Naked query rejected: tenantId must be a non-empty string.',
      'INVALID_TENANT_ID_EMPTY'
    );
  }

  const normalized = id.trim().toLowerCase();

  if (!UUID_REGEX.test(normalized)) {
    throw new TenantSecurityError(
      `Naked query rejected: "${id}" is not a valid RFC 4122 UUID.`,
      'INVALID_TENANT_ID_FORMAT'
    );
  }

  return normalized;
}

// ==============================================================================
// 3. Fail-Safe Multi-Tenant Transaction Client Wrapper
// ==============================================================================

/**
 * Executes a database operation within a dedicated PostgreSQL transaction that enforces
 * Row-Level Security (RLS) by scoping `app.current_tenant_id` to the provided tenantId.
 *
 * Guarantees:
 * 1. Strict tenant UUID validation prior to pool checkout.
 * 2. Dedicated single-client checkout preventing session-variable leakage across connections.
 * 3. Atomic `BEGIN` -> `SET LOCAL app.current_tenant_id` -> callback execution -> `COMMIT`.
 * 4. Automatic `ROLLBACK` on any error.
 * 5. Guaranteed connection release back to pool in `finally`.
 *
 * @param tenantId The validated UUID of the tenant
 * @param operation Callback receiving the tenant-scoped Drizzle transaction client
 * @returns The result of the operation
 */
export async function withTenantDb<T>(
  tenantId: string,
  operation: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  // Step 1: Strict client-side validation against naked queries
  const validatedTenantId = validateTenantId(tenantId);

  // Step 2: Check out an isolated client from the connection pool
  const client = await pool.connect();

  try {
    // Step 3: Begin transaction
    await client.query('BEGIN');

    // Step 4: Set local transaction session variable for PostgreSQL RLS
    // Using parameterized set_config guarantees zero injection surface and local transaction scope
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
      validatedTenantId,
    ]);

    // Also execute explicit SET LOCAL statement to conform to specification
    await client.query(`SET LOCAL app.current_tenant_id = '${validatedTenantId}'`);

    // Step 5: Wrap scoped client with Drizzle schema and execute callback
    const txDb = drizzle(client, { schema });
    const result = await operation(txDb);

    // Step 6: Commit transaction upon successful completion
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Step 7: Rollback on any failure
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Log rollback failure without suppressing original error
      console.error('Failed to rollback tenant transaction:', rollbackError);
    }
    throw error;
  } finally {
    // Step 8: Always release client back to the pool
    client.release();
  }
}

/**
 * Cleanly terminates all connections in the pool (for graceful shutdown and testing).
 */
export async function closePool(): Promise<void> {
  await pool.end();
}

export * from './schema.js';

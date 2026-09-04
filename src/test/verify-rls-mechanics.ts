import fs from 'node:fs';
import path from 'node:path';
import { validateTenantId, TenantSecurityError } from '../lib/db/index.js';

console.log('--- POPIA Hub Database Layer & RLS Architecture Verification ---');

// 1. Verify Migration File Integrity
const migrationPath = path.resolve(process.cwd(), 'migrations/0001_initial_popia_hub.sql');
if (!fs.existsSync(migrationPath)) {
  console.error('FAIL: Migration file not found at', migrationPath);
  process.exit(1);
}

const sqlContent = fs.readFileSync(migrationPath, 'utf-8');

const requiredTables = [
  'tenants',
  'subscriptions',
  'information_officers',
  'evidence_vault',
  'ropa_activities',
  'dsar_requests',
  'privacy_incidents',
];

const requiredEnums = [
  'industry_sector_enum',
  'subscription_tier_enum',
  'subscription_status_enum',
  'role_type_enum',
  'dsar_request_type_enum',
  'dsar_status_enum',
  'incident_severity_enum',
];

console.log('\n[+] Validating SQL Migration Script...');

// Check enums
for (const enumName of requiredEnums) {
  if (!sqlContent.includes(enumName)) {
    console.error(`FAIL: Missing enum ${enumName} in migration`);
    process.exit(1);
  }
  console.log(`  ✓ Enum ${enumName} present`);
}

// Check tables
for (const table of requiredTables) {
  if (!sqlContent.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) {
    console.error(`FAIL: Missing table ${table} in migration`);
    process.exit(1);
  }
  console.log(`  ✓ Table ${table} definition present`);
}

// Check 12-month agreement constraint
if (!sqlContent.includes('check_12_month_agreement')) {
  console.error('FAIL: Missing 12-month agreement constraint');
  process.exit(1);
}
console.log('  ✓ 12-Month subscription agreement constraint enforced');

// Check evidence vault SHA-256
if (!sqlContent.includes('sha256_hash CHAR(64)')) {
  console.error('FAIL: Missing sha256_hash CHAR(64) on evidence_vault');
  process.exit(1);
}
console.log('  ✓ Evidence vault SHA-256 integrity hash enforced');

// Check RLS enablement and enforcement
for (const table of requiredTables) {
  const rlsEnable = `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`;
  const rlsForce = `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`;
  if (!sqlContent.includes(rlsEnable)) {
    console.error(`FAIL: RLS not enabled for ${table}`);
    process.exit(1);
  }
  if (!sqlContent.includes(rlsForce)) {
    console.error(`FAIL: FORCE RLS not enabled for ${table}`);
    process.exit(1);
  }
  console.log(`  ✓ RLS enabled & forced for ${table}`);
}

// Check RLS policies
const expectedRlsExpression = "NULLIF(current_setting('app.current_tenant_id', true), '')::uuid";
if (!sqlContent.includes(expectedRlsExpression)) {
  console.error('FAIL: Missing fail-safe RLS expression');
  process.exit(1);
}
console.log('  ✓ Fail-safe RLS tenant isolation policy expression present');

// Check performance indexes
const requiredIndexes = [
  'idx_subscriptions_tenant_id',
  'idx_information_officers_tenant_id',
  'idx_evidence_vault_tenant_id',
  'idx_ropa_activities_tenant_id',
  'idx_ropa_activities_linked_evidence_id',
  'idx_dsar_requests_tenant_id',
  'idx_privacy_incidents_tenant_id',
];

for (const idx of requiredIndexes) {
  if (!sqlContent.includes(idx)) {
    console.error(`FAIL: Missing index ${idx}`);
    process.exit(1);
  }
  console.log(`  ✓ Index ${idx} present`);
}

console.log('\n[+] Validating Fail-Safe Tenant ID Validator...');

// 2. Test Tenant ID Validator
const invalidInputs = [
  '',
  '   ',
  '123',
  'invalid-uuid',
  '00000000-0000-0000-0000-00000000000', // invalid length
  "'; DROP TABLE tenants; --",
  "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' OR '1'='1",
];

for (const input of invalidInputs) {
  try {
    validateTenantId(input);
    console.error(`FAIL: Expected input "${input}" to be rejected!`);
    process.exit(1);
  } catch (err) {
    if (!(err instanceof TenantSecurityError)) {
      console.error('FAIL: Expected TenantSecurityError, got', err);
      process.exit(1);
    }
    console.log(`  ✓ Correctly rejected naked/malformed tenant ID: "${input}"`);
  }
}

// Test valid UUID
const validUuid = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f';
const normalized = validateTenantId(validUuid.toUpperCase());
if (normalized !== validUuid) {
  console.error('FAIL: Expected normalized lowercase UUID');
  process.exit(1);
}
console.log(`  ✓ Valid UUID accepted and normalized: ${normalized}`);

console.log('\n===============================================================');
console.log('✔ All architectural, migration, and security assertions PASSED!');
console.log('===============================================================\n');

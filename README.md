# POPIA Hub - Production Multi-Tenant Database Layer

Production-grade, multi-tenant database layer for the POPIA Hub platform, built with **PostgreSQL** (Supabase/Neon), **Drizzle ORM**, and hardware-grade **Row-Level Security (RLS)** in full compliance with South Africa's Protection of Personal Information Act (POPIA, Act 4 of 2013).

---

## 🛡️ Architecture & Security Model

### 1. Row-Level Security (RLS) Isolation
Every table in the database has RLS explicitly enabled and forced:
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
```
`FORCE ROW LEVEL SECURITY` guarantees that even table owners or service roles cannot accidentally bypass tenant filtering unless they are explicitly assigned `BYPASSRLS`.

### 2. Fail-Safe Session Variable Mechanism
Tenant filtering is driven by the PostgreSQL local session variable `app.current_tenant_id`:
```sql
CREATE POLICY tenant_isolation_policy ON <table>
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```
- **Unset / Naked Queries**: When `app.current_tenant_id` is missing or uninitialized, `current_setting('app.current_tenant_id', true)` evaluates to `NULL`. Because `tenant_id = NULL` evaluates to `UNKNOWN` in SQL ternary logic, all queries naturally return **zero rows** by default.
- **Root Entity Isolation**: On the `tenants` table itself, isolation is enforced on `id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid`.

---

## 🗄️ Database Entities & POPIA Compliance

| Table | POPIA Statutory Role | Security & Constraints |
|---|---|---|
| `tenants` | Responsible Party Organization | PK `id UUID`, Sector Enum (`Medical`, `Recruitment`, `Financial`, `Professional Services`), RLS on `id` |
| `subscriptions` | Commercial Agreement & Tier (`Free`, `Starter`, `Pro`) | 12-Month Agreement Check Constraint (`check_12_month_agreement`), Indexed `tenant_id` |
| `information_officers` | POPIA Section 55 & 56 Mandate | Statutory Officer Registration Number, Mandate Timestamp, Indexed `tenant_id` |
| `evidence_vault` | Compliance Audit Artifacts | SHA-256 Hash (`CHAR(64)`), File Size (`BIGINT`), Indexed `tenant_id` |
| `ropa_activities` | POPIA Section 17 Records of Processing | Data Categories array, Special Info flag, Retention Period, Evidence Link, Indexed FKs |
| `dsar_requests` | POPIA Section 23/24 Access / Correction / Deletion | Requester Identity Verification, Statutory Deadline Date, Status Enum, Indexed `tenant_id` |
| `privacy_incidents` | POPIA Section 22 Security Compromises | Severity Enum, Affected Count, Regulator & Subject Notification Flags, Indexed `tenant_id` |

---

## 💻 Usage: Fail-Safe Multi-Tenant Transaction Client

Always access the database through `withTenantDb`:

```typescript
import { withTenantDb, ropaActivities } from './lib/db/index.js';

// Safe execution within an isolated PostgreSQL transaction
const activities = await withTenantDb(userTenantId, async (tx) => {
  return await tx.select().from(ropaActivities);
});
```

### What `withTenantDb` guarantees:
1. **Pre-flight UUID Validation**: Verifies the tenant ID against strict 8-4-4-4-12 hex format (`UUID_REGEX`). Rejects naked queries and injection strings immediately before borrowing a client from the connection pool.
2. **Dedicated Pooled Client Checkout**: Borrows a dedicated client from `pg.Pool`, preventing connection state crosstalk.
3. **Local Transaction Scope**: Issues `BEGIN;`, executes parameterized `SELECT set_config('app.current_tenant_id', $1, true)` and `SET LOCAL app.current_tenant_id = '<id>'`. The variable vanishes automatically upon transaction completion.
4. **Automatic Error Rollback**: Triggers `ROLLBACK` on any thrown error.
5. **Leak Prevention**: Guarantees `client.release()` in a `finally` block under all circumstances.

---

## 🚀 Getting Started & CLI Commands

### 1. Configure Environment
Copy `.env.example` to `.env` and set your Supabase database connection strings:
```bash
cp .env.example .env
```
Ensure both database connection strings are configured:
- `DATABASE_URL`: Supabase Transaction Pooler connection string (port 6543) used by the application runtime and `pg.Pool`.
- `DIRECT_URL`: Supabase Direct connection string (port 5432) used by Drizzle Kit for schema migrations (`db:migrate`) and push (`db:push`) without PgBouncer locks.

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Automated Tests
```bash
npm test
```

### 4. Type Check & Compile
```bash
npm run typecheck
npm run build
```

### 5. Run RLS Mechanics & Migration Assertions
```bash
node dist/test/verify-rls-mechanics.js
```

### 6. Database Migrations
Apply `migrations/0001_initial_popia_hub.sql` to your Supabase/Neon PostgreSQL instance:
```bash
npm run db:migrate
```

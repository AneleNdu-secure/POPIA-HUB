-- ==============================================================================
-- POPIA Hub Production Multi-Tenant Schema & Row Level Security (RLS) Migration
-- Target: PostgreSQL (Supabase / Neon / Managed AWS RDS)
-- ==============================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Define Enumeration Types (Idempotent)
DO $$ BEGIN
    CREATE TYPE industry_sector_enum AS ENUM ('Medical', 'Recruitment', 'Financial', 'Professional Services');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE subscription_tier_enum AS ENUM ('Free', 'Starter', 'Pro');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE subscription_status_enum AS ENUM ('active', 'past_due', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE role_type_enum AS ENUM ('IO', 'Deputy IO');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE dsar_request_type_enum AS ENUM ('Access', 'Correction', 'Deletion');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE dsar_status_enum AS ENUM ('Received', 'Processing', 'Completed', 'Rejected');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE incident_severity_enum AS ENUM ('Low', 'Medium', 'High', 'Critical');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ==============================================================================
-- 3. Define Tables
-- ==============================================================================

-- 3.1 Tenants
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_name VARCHAR(255) NOT NULL,
    registration_number VARCHAR(100),
    industry_sector industry_sector_enum NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3.2 Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tier subscription_tier_enum NOT NULL DEFAULT 'Free',
    agreement_start_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    agreement_end_date TIMESTAMPTZ NOT NULL,
    status subscription_status_enum NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT check_12_month_agreement CHECK (agreement_end_date >= agreement_start_date + INTERVAL '12 months' - INTERVAL '1 day')
);

-- 3.3 Information Officers (POPIA Compliance Officers)
CREATE TABLE IF NOT EXISTS information_officers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    role_type role_type_enum NOT NULL DEFAULT 'IO',
    regulator_registration_number VARCHAR(100),
    mandate_signed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3.4 Evidence Vault (Tamper-evident audit document store)
CREATE TABLE IF NOT EXISTS evidence_vault (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    storage_key VARCHAR(1024) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    sha256_hash CHAR(64) NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3.5 Records of Processing Activities (ROPA - POPIA Section 17)
CREATE TABLE IF NOT EXISTS ropa_activities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    activity_name VARCHAR(255) NOT NULL,
    data_categories TEXT[] NOT NULL DEFAULT '{}',
    is_special_personal_info BOOLEAN NOT NULL DEFAULT false,
    cross_border_transfer BOOLEAN NOT NULL DEFAULT false,
    retention_period VARCHAR(255) NOT NULL,
    linked_evidence_id UUID REFERENCES evidence_vault(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3.6 Data Subject Access Requests (DSAR - POPIA Section 23/24)
CREATE TABLE IF NOT EXISTS dsar_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    requester_name VARCHAR(255) NOT NULL,
    requester_email VARCHAR(255) NOT NULL,
    request_type dsar_request_type_enum NOT NULL,
    identity_verified BOOLEAN NOT NULL DEFAULT false,
    deadline_date DATE NOT NULL,
    status dsar_status_enum NOT NULL DEFAULT 'Received',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3.7 Privacy Incidents (POPIA Section 22 Data Breach Management)
CREATE TABLE IF NOT EXISTS privacy_incidents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    incident_date DATE NOT NULL DEFAULT CURRENT_DATE,
    severity incident_severity_enum NOT NULL DEFAULT 'Medium',
    affected_subjects_count INT NOT NULL DEFAULT 0,
    incident_description TEXT NOT NULL,
    remediation_steps TEXT,
    regulator_notified BOOLEAN NOT NULL DEFAULT false,
    subjects_notified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==============================================================================
-- 4. Performance Foreign Key & Query Indexes
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_id ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_information_officers_tenant_id ON information_officers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_evidence_vault_tenant_id ON evidence_vault(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ropa_activities_tenant_id ON ropa_activities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ropa_activities_linked_evidence_id ON ropa_activities(linked_evidence_id);
CREATE INDEX IF NOT EXISTS idx_dsar_requests_tenant_id ON dsar_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_privacy_incidents_tenant_id ON privacy_incidents(tenant_id);

-- ==============================================================================
-- 5. Row Level Security (RLS) Configuration
-- ==============================================================================

-- Enable RLS and FORCE RLS on all tables so owner accounts/superuser-owned connections
-- do not bypass tenant isolation unless explicitly BYPASSRLS is granted.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

ALTER TABLE information_officers ENABLE ROW LEVEL SECURITY;
ALTER TABLE information_officers FORCE ROW LEVEL SECURITY;

ALTER TABLE evidence_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_vault FORCE ROW LEVEL SECURITY;

ALTER TABLE ropa_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ropa_activities FORCE ROW LEVEL SECURITY;

ALTER TABLE dsar_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsar_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE privacy_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_incidents FORCE ROW LEVEL SECURITY;

-- Drop existing policies if re-running migration
DROP POLICY IF EXISTS tenant_isolation_policy ON tenants;
DROP POLICY IF EXISTS tenant_isolation_policy ON subscriptions;
DROP POLICY IF EXISTS tenant_isolation_policy ON information_officers;
DROP POLICY IF EXISTS tenant_isolation_policy ON evidence_vault;
DROP POLICY IF EXISTS tenant_isolation_policy ON ropa_activities;
DROP POLICY IF EXISTS tenant_isolation_policy ON dsar_requests;
DROP POLICY IF EXISTS tenant_isolation_policy ON privacy_incidents;

-- Policy on tenants table
CREATE POLICY tenant_isolation_policy ON tenants
    FOR ALL
    USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Policy on subscriptions table
CREATE POLICY tenant_isolation_policy ON subscriptions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Policy on information_officers table
CREATE POLICY tenant_isolation_policy ON information_officers
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Policy on evidence_vault table
CREATE POLICY tenant_isolation_policy ON evidence_vault
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Policy on ropa_activities table
CREATE POLICY tenant_isolation_policy ON ropa_activities
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Policy on dsar_requests table
CREATE POLICY tenant_isolation_policy ON dsar_requests
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Policy on privacy_incidents table
CREATE POLICY tenant_isolation_policy ON privacy_incidents
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

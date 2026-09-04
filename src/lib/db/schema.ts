import { sql, relations } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  date,
  boolean,
  integer,
  bigint,
  char,
  pgEnum,
  index,
  check,
} from 'drizzle-orm/pg-core';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

// ==============================================================================
// 1. Enumerations
// ==============================================================================

export const industrySectorEnum = pgEnum('industry_sector_enum', [
  'Medical',
  'Recruitment',
  'Financial',
  'Professional Services',
]);

export const subscriptionTierEnum = pgEnum('subscription_tier_enum', [
  'Free',
  'Starter',
  'Pro',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status_enum', [
  'active',
  'past_due',
  'cancelled',
]);

export const roleTypeEnum = pgEnum('role_type_enum', [
  'IO',
  'Deputy IO',
]);

export const dsarRequestTypeEnum = pgEnum('dsar_request_type_enum', [
  'Access',
  'Correction',
  'Deletion',
]);

export const dsarStatusEnum = pgEnum('dsar_status_enum', [
  'Received',
  'Processing',
  'Completed',
  'Rejected',
]);

export const incidentSeverityEnum = pgEnum('incident_severity_enum', [
  'Low',
  'Medium',
  'High',
  'Critical',
]);

// ==============================================================================
// 2. Table Definitions
// ==============================================================================

/**
 * 2.1 Tenants Table
 * Root organization tenant entity. Isolated via RLS on `id = current_tenant_id`.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  registrationNumber: varchar('registration_number', { length: 100 }),
  industrySector: industrySectorEnum('industry_sector').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 2.2 Subscriptions Table
 * Manages tenant tier and enforces 12-month agreement constraint.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    tier: subscriptionTierEnum('tier').default('Free').notNull(),
    agreementStartDate: timestamp('agreement_start_date', { withTimezone: true })
      .defaultNow()
      .notNull(),
    agreementEndDate: timestamp('agreement_end_date', { withTimezone: true }).notNull(),
    status: subscriptionStatusEnum('status').default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_subscriptions_tenant_id').on(table.tenantId),
    check(
      'check_12_month_agreement',
      sql`${table.agreementEndDate} >= ${table.agreementStartDate} + INTERVAL '12 months' - INTERVAL '1 day'`
    ),
  ]
);

/**
 * 2.3 Information Officers Table
 * POPIA mandated statutory officer registrations with the Information Regulator.
 */
export const informationOfficers = pgTable(
  'information_officers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fullName: varchar('full_name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 50 }),
    roleType: roleTypeEnum('role_type').default('IO').notNull(),
    regulatorRegistrationNumber: varchar('regulator_registration_number', { length: 100 }),
    mandateSignedAt: timestamp('mandate_signed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_information_officers_tenant_id').on(table.tenantId),
  ]
);

/**
 * 2.4 Evidence Vault Table
 * Tamper-evident repository storing cryptographic SHA-256 hashes of compliance artifacts.
 */
export const evidenceVault = pgTable(
  'evidence_vault',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    storageKey: varchar('storage_key', { length: 1024 }).notNull(),
    fileSize: bigint('file_size', { mode: 'number' }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sha256Hash: char('sha256_hash', { length: 64 }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_evidence_vault_tenant_id').on(table.tenantId),
  ]
);

/**
 * 2.5 Records of Processing Activities (ROPA) Table
 * Mandated by POPIA Section 17 to document all personal data processing flows.
 */
export const ropaActivities = pgTable(
  'ropa_activities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    activityName: varchar('activity_name', { length: 255 }).notNull(),
    dataCategories: text('data_categories')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isSpecialPersonalInfo: boolean('is_special_personal_info').default(false).notNull(),
    crossBorderTransfer: boolean('cross_border_transfer').default(false).notNull(),
    retentionPeriod: varchar('retention_period', { length: 255 }).notNull(),
    linkedEvidenceId: uuid('linked_evidence_id').references(() => evidenceVault.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_ropa_activities_tenant_id').on(table.tenantId),
    index('idx_ropa_activities_linked_evidence_id').on(table.linkedEvidenceId),
  ]
);

/**
 * 2.6 Data Subject Access Requests (DSAR) Table
 * POPIA Section 23/24 request tracking for access, correction, or deletion of personal data.
 */
export const dsarRequests = pgTable(
  'dsar_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    requesterName: varchar('requester_name', { length: 255 }).notNull(),
    requesterEmail: varchar('requester_email', { length: 255 }).notNull(),
    requestType: dsarRequestTypeEnum('request_type').notNull(),
    identityVerified: boolean('identity_verified').default(false).notNull(),
    deadlineDate: date('deadline_date', { mode: 'string' }).notNull(),
    status: dsarStatusEnum('status').default('Received').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_dsar_requests_tenant_id').on(table.tenantId),
  ]
);

/**
 * 2.7 Privacy Incidents Table
 * POPIA Section 22 security compromises, notification logs, and impact severity.
 */
export const privacyIncidents = pgTable(
  'privacy_incidents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentDate: date('incident_date', { mode: 'string' })
      .default(sql`CURRENT_DATE`)
      .notNull(),
    severity: incidentSeverityEnum('severity').default('Medium').notNull(),
    affectedSubjectsCount: integer('affected_subjects_count').default(0).notNull(),
    incidentDescription: text('incident_description').notNull(),
    remediationSteps: text('remediation_steps'),
    regulatorNotified: boolean('regulator_notified').default(false).notNull(),
    subjectsNotified: boolean('subjects_notified').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_privacy_incidents_tenant_id').on(table.tenantId),
  ]
);

// ==============================================================================
// 3. Relational Mappings
// ==============================================================================

export const tenantsRelations = relations(tenants, ({ many }) => ({
  subscriptions: many(subscriptions),
  informationOfficers: many(informationOfficers),
  evidenceVault: many(evidenceVault),
  ropaActivities: many(ropaActivities),
  dsarRequests: many(dsarRequests),
  privacyIncidents: many(privacyIncidents),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  tenant: one(tenants, {
    fields: [subscriptions.tenantId],
    references: [tenants.id],
  }),
}));

export const informationOfficersRelations = relations(informationOfficers, ({ one }) => ({
  tenant: one(tenants, {
    fields: [informationOfficers.tenantId],
    references: [tenants.id],
  }),
}));

export const evidenceVaultRelations = relations(evidenceVault, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [evidenceVault.tenantId],
    references: [tenants.id],
  }),
  ropaActivities: many(ropaActivities),
}));

export const ropaActivitiesRelations = relations(ropaActivities, ({ one }) => ({
  tenant: one(tenants, {
    fields: [ropaActivities.tenantId],
    references: [tenants.id],
  }),
  linkedEvidence: one(evidenceVault, {
    fields: [ropaActivities.linkedEvidenceId],
    references: [evidenceVault.id],
  }),
}));

export const dsarRequestsRelations = relations(dsarRequests, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dsarRequests.tenantId],
    references: [tenants.id],
  }),
}));

export const privacyIncidentsRelations = relations(privacyIncidents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [privacyIncidents.tenantId],
    references: [tenants.id],
  }),
}));

// ==============================================================================
// 4. Inferred TypeScript Types
// ==============================================================================

export type Tenant = InferSelectModel<typeof tenants>;
export type NewTenant = InferInsertModel<typeof tenants>;

export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;

export type InformationOfficer = InferSelectModel<typeof informationOfficers>;
export type NewInformationOfficer = InferInsertModel<typeof informationOfficers>;

export type EvidenceItem = InferSelectModel<typeof evidenceVault>;
export type NewEvidenceItem = InferInsertModel<typeof evidenceVault>;

export type RopaActivity = InferSelectModel<typeof ropaActivities>;
export type NewRopaActivity = InferInsertModel<typeof ropaActivities>;

export type DsarRequest = InferSelectModel<typeof dsarRequests>;
export type NewDsarRequest = InferInsertModel<typeof dsarRequests>;

export type PrivacyIncident = InferSelectModel<typeof privacyIncidents>;
export type NewPrivacyIncident = InferInsertModel<typeof privacyIncidents>;

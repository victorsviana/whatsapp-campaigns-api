import { integer, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const CAMPAIGN_STATUSES = ['draft', 'running', 'completed'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const campaignStatusEnum = pgEnum('campaign_status', CAMPAIGN_STATUSES);

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  template: varchar('template', { length: 4096 }).notNull(),
  variables: text('variables').array().notNull().default([]),
  status: campaignStatusEnum('status').notNull().default('draft'),
  rejectedContacts: integer('rejected_contacts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

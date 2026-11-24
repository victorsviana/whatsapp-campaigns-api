import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

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

export const MESSAGE_STATUSES = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const messageStatusEnum = pgEnum('message_status', MESSAGE_STATUSES);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    phone: varchar('phone', { length: 20 }).notNull(),
    variables: jsonb('variables').$type<Record<string, string>>().notNull(),
    status: messageStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    providerMessageId: varchar('provider_message_id', { length: 255 }).unique(),
    failureReason: varchar('failure_reason', { length: 100 }),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('messages_campaign_id_phone_unique').on(table.campaignId, table.phone),
    index('messages_campaign_id_status_seq_idx').on(table.campaignId, table.status, table.seq),
    index('messages_ready_queue_idx')
      .on(table.nextAttemptAt, table.seq)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

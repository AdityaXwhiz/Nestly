/**
 * Step 13B: Add nullable request_id column to outbox and origin_request_id to payments
 * for end-to-end request correlation across API -> Outbox -> SQS -> Consumers -> Webhooks.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE outbox
    ADD COLUMN request_id text;

    ALTER TABLE payments
    ADD COLUMN origin_request_id text;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE payments
    DROP COLUMN IF EXISTS origin_request_id;

    ALTER TABLE outbox
    DROP COLUMN IF EXISTS request_id;
  `);
};

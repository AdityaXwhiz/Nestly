/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      aggregate_id uuid NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    );

    CREATE INDEX idx_outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;

    CREATE TABLE saga_instances (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      state text NOT NULL CHECK (state IN ('STARTED', 'HOLDING_PROPERTY', 'HOLDING_SERVICES', 'PAYING', 'CONFIRMING', 'COMPENSATING', 'COMPLETED', 'FAILED')),
      step int NOT NULL DEFAULT 0,
      context jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS saga_instances CASCADE;
    DROP TABLE IF EXISTS outbox CASCADE;
  `);
};

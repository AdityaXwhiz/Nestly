/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- 1. Consumer idempotency store (for non-notification consumers)
    CREATE TABLE processed_events (
      consumer text NOT NULL,
      event_id uuid NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id)
    );

    -- 2. Provider / host fulfilment records per confirmed order item
    CREATE TABLE provider_actions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      provider_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_type text NOT NULL CHECK (resource_type IN ('PROPERTY', 'SERVICE')),
      resource_id uuid NOT NULL,
      action text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'CANCELLED')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT provider_actions_item_action_unique UNIQUE (order_item_id, action)
    );

    CREATE INDEX idx_provider_actions_order_id ON provider_actions(order_id);
    CREATE INDEX idx_provider_actions_provider_user ON provider_actions(provider_user_id, status);

    -- 3. Notifications natural deduplication & pending retry index
    ALTER TABLE notifications
      ADD COLUMN event_id uuid,
      ADD COLUMN sent_at timestamptz,
      ADD CONSTRAINT notifications_user_event_unique UNIQUE (user_id, event_id, event_type);

    CREATE INDEX idx_notifications_pending_created
      ON notifications (created_at)
      WHERE status = 'PENDING';

    -- 4. Outbox published cleanup partial index
    CREATE INDEX idx_outbox_published_at
      ON outbox (published_at)
      WHERE published_at IS NOT NULL;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_outbox_published_at;
    DROP INDEX IF EXISTS idx_notifications_pending_created;

    ALTER TABLE notifications
      DROP CONSTRAINT IF EXISTS notifications_user_event_unique,
      DROP COLUMN IF EXISTS sent_at,
      DROP COLUMN IF EXISTS event_id;

    DROP TABLE IF EXISTS provider_actions CASCADE;
    DROP TABLE IF EXISTS processed_events CASCADE;
  `);
};

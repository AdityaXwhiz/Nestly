/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- 1. Update saga_instances status check to include AWAITING_PAYMENT and REFUNDING
    ALTER TABLE saga_instances
    DROP CONSTRAINT saga_instances_state_check;

    ALTER TABLE saga_instances
    ADD CONSTRAINT saga_instances_state_check
    CHECK (state IN (
      'STARTED', 'HOLDING_PROPERTY', 'HOLDING_SERVICES', 'AWAITING_PAYMENT',
      'PAYING', 'CONFIRMING', 'REFUNDING', 'COMPENSATING', 'COMPLETED', 'FAILED'
    ));

    -- 2. Partial unique index on reservations: exactly one active reservation per order item
    CREATE UNIQUE INDEX idx_reservations_active_order_item
    ON reservations (order_item_id)
    WHERE status IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED');

    -- 3. Recovery index on saga_instances for non-terminal sagas
    CREATE INDEX idx_saga_instances_unsettled
    ON saga_instances (updated_at)
    WHERE state NOT IN ('COMPLETED', 'FAILED');
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    -- 1. Drop recovery index
    DROP INDEX IF EXISTS idx_saga_instances_unsettled;

    -- 2. Drop partial unique index on reservations
    DROP INDEX IF EXISTS idx_reservations_active_order_item;

    -- 3. Revert saga_instances status check
    ALTER TABLE saga_instances
    DROP CONSTRAINT saga_instances_state_check;

    ALTER TABLE saga_instances
    ADD CONSTRAINT saga_instances_state_check
    CHECK (state IN (
      'STARTED', 'HOLDING_PROPERTY', 'HOLDING_SERVICES',
      'PAYING', 'CONFIRMING', 'COMPENSATING', 'COMPLETED', 'FAILED'
    ));
  `);
};

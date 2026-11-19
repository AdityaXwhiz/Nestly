/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- 1. Partial unique index on payments: exactly one non-failed payment per order
    CREATE UNIQUE INDEX idx_payments_order_id_active
    ON payments (order_id)
    WHERE status NOT IN ('FAILED');

    -- 2. Default currency to INR for payments
    ALTER TABLE payments
    ALTER COLUMN currency SET DEFAULT 'INR';
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    -- 1. Drop partial unique index
    DROP INDEX IF EXISTS idx_payments_order_id_active;

    -- 2. Revert currency default to USD
    ALTER TABLE payments
    ALTER COLUMN currency SET DEFAULT 'USD';
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- 1. Update orders status check to include 'HELD'
    ALTER TABLE orders
    DROP CONSTRAINT orders_status_check;

    ALTER TABLE orders
    ADD CONSTRAINT orders_status_check
    CHECK (status IN ('DRAFT', 'PENDING', 'HELD', 'CONFIRMED', 'CANCELLED', 'FAILED'));

    -- 2. Add during, guest_count, hold_expires_at to orders
    ALTER TABLE orders
    ADD COLUMN during tstzrange,
    ADD COLUMN guest_count int CHECK (guest_count > 0),
    ADD COLUMN hold_expires_at timestamptz;

    -- 3. Default currency to INR for orders
    ALTER TABLE orders
    ALTER COLUMN currency SET DEFAULT 'INR';

    -- 4. Add title, slot, and pricing_unit to order_items
    ALTER TABLE order_items
    ADD COLUMN title text NOT NULL DEFAULT '',
    ADD COLUMN slot text,
    ADD COLUMN pricing_unit text NOT NULL DEFAULT 'PER_UNIT' CHECK (pricing_unit IN ('PER_DAY', 'PER_UNIT'));

    -- 5. Default currency to INR for order_items
    ALTER TABLE order_items
    ALTER COLUMN currency SET DEFAULT 'INR';
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    -- 1. Revert order_items modifications
    ALTER TABLE order_items
    DROP COLUMN IF EXISTS pricing_unit,
    DROP COLUMN IF EXISTS slot,
    DROP COLUMN IF EXISTS title;

    ALTER TABLE order_items
    ALTER COLUMN currency SET DEFAULT 'USD';

    -- 2. Revert orders modifications
    ALTER TABLE orders
    DROP COLUMN IF EXISTS hold_expires_at,
    DROP COLUMN IF EXISTS guest_count,
    DROP COLUMN IF EXISTS during;

    ALTER TABLE orders
    ALTER COLUMN currency SET DEFAULT 'USD';

    ALTER TABLE orders
    DROP CONSTRAINT IF EXISTS orders_status_check;

    ALTER TABLE orders
    ADD CONSTRAINT orders_status_check
    CHECK (status IN ('DRAFT', 'PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED'));
  `);
};

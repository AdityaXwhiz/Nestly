/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- 1. Add is_exclusive, quantity, and slot to reservations
    ALTER TABLE reservations
    ADD COLUMN is_exclusive boolean NOT NULL DEFAULT true,
    ADD COLUMN quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
    ADD COLUMN slot text;

    -- 2. Drop the overly broad exclusion constraint that blocked capacity-based services
    ALTER TABLE reservations
    DROP CONSTRAINT reservations_resource_id_during_excl;

    -- 3. Create partial exclusion constraint applying only to exclusive resources
    ALTER TABLE reservations
    ADD CONSTRAINT reservations_exclusive_overlap_excl
    EXCLUDE USING gist (resource_id WITH =, during WITH &&)
    WHERE (is_exclusive = true AND status IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED'));
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    -- 1. Drop the partial exclusion constraint
    ALTER TABLE reservations
    DROP CONSTRAINT IF EXISTS reservations_exclusive_overlap_excl;

    -- 2. Restore the original exclusion constraint
    ALTER TABLE reservations
    ADD CONSTRAINT reservations_resource_id_during_excl
    EXCLUDE USING gist (resource_id WITH =, during WITH &&)
    WHERE (status IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED'));

    -- 3. Drop added columns
    ALTER TABLE reservations
    DROP COLUMN IF EXISTS slot,
    DROP COLUMN IF EXISTS quantity,
    DROP COLUMN IF EXISTS is_exclusive;
  `);
};

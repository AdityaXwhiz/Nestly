/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      resource_type text NOT NULL CHECK (resource_type IN ('PROPERTY','SERVICE')),
      resource_id uuid NOT NULL,
      during tstzrange NOT NULL,
      status text NOT NULL CHECK (status IN ('HELD','PAYMENT_PENDING','CONFIRMED','CANCELLED','EXPIRED')),
      hold_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      EXCLUDE USING gist (resource_id WITH =, during WITH &&)
      WHERE (status IN ('HELD','PAYMENT_PENDING','CONFIRMED'))
    );

    CREATE INDEX reservations_hold_sweep ON reservations (hold_expires_at) WHERE status = 'HELD';
    CREATE INDEX idx_reservations_order_item_id ON reservations(order_item_id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS reservations CASCADE;
  `);
};

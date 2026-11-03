/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('DRAFT', 'PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED')),
      total_amount_minor bigint NOT NULL DEFAULT 0 CHECK (total_amount_minor >= 0),
      currency varchar(3) NOT NULL DEFAULT 'USD',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_orders_user_created ON orders(user_id, created_at);
    CREATE INDEX idx_orders_status ON orders(status);

    CREATE TABLE order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      resource_type text NOT NULL CHECK (resource_type IN ('PROPERTY', 'SERVICE')),
      resource_id uuid NOT NULL,
      quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
      unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
      currency varchar(3) NOT NULL DEFAULT 'USD',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX idx_order_items_resource ON order_items(resource_type, resource_id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS order_items CASCADE;
    DROP TABLE IF EXISTS orders CASCADE;
  `);
};

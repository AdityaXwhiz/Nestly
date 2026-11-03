/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
      currency varchar(3) NOT NULL DEFAULT 'USD',
      status text NOT NULL CHECK (status IN ('CREATED', 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REFUNDED')),
      provider_reference text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE payment_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      provider_event_id text NOT NULL UNIQUE,
      type text NOT NULL CHECK (type IN ('CHARGE', 'REFUND', 'VOID', 'WEBHOOK')),
      amount_minor bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_payments_order_id ON payments(order_id);
    CREATE INDEX idx_payment_transactions_payment_id ON payment_transactions(payment_id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS payment_transactions CASCADE;
    DROP TABLE IF EXISTS payments CASCADE;
  `);
};

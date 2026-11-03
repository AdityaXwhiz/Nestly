/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      resource_type text NOT NULL CHECK (resource_type IN ('PROPERTY', 'SERVICE')),
      resource_id uuid NOT NULL,
      rating int NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, order_id, resource_type, resource_id)
    );

    CREATE INDEX idx_reviews_resource ON reviews(resource_type, resource_id);

    CREATE TABLE notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_notifications_user_status ON notifications(user_id, status);

    CREATE TABLE audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL,
      entity text NOT NULL,
      entity_id uuid,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_audit_logs_entity_created ON audit_logs(entity, created_at);

    CREATE TABLE payouts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
      currency varchar(3) NOT NULL DEFAULT 'USD',
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'PAID', 'FAILED')),
      provider_reference text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_payouts_user_id ON payouts(user_id);

    CREATE TABLE coupons (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
      discount_percentage int NOT NULL DEFAULT 0 CHECK (discount_percentage >= 0 AND discount_percentage <= 100),
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'DISABLED')),
      valid_from timestamptz NOT NULL DEFAULT now(),
      valid_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS coupons CASCADE;
    DROP TABLE IF EXISTS payouts CASCADE;
    DROP TABLE IF EXISTS audit_logs CASCADE;
    DROP TABLE IF EXISTS notifications CASCADE;
    DROP TABLE IF EXISTS reviews CASCADE;
  `);
};

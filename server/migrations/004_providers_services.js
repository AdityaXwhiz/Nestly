/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE providers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      business_name text NOT NULL,
      bio text,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'PENDING', 'SUSPENDED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE services (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      title text NOT NULL,
      description text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('exclusive', 'capacity')),
      price_minor bigint NOT NULL CHECK (price_minor >= 0),
      currency varchar(3) NOT NULL DEFAULT 'USD',
      duration_minutes int,
      capacity int,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DRAFT', 'DELETED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_services_provider_id ON services(provider_id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS services CASCADE;
    DROP TABLE IF EXISTS providers CASCADE;
  `);
};

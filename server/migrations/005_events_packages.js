/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL,
      event_date date NOT NULL,
      guest_count int NOT NULL CHECK (guest_count > 0),
      event_type text NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PLANNED', 'COMPLETED', 'CANCELLED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE packages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      description text NOT NULL,
      price_minor bigint NOT NULL CHECK (price_minor >= 0),
      currency varchar(3) NOT NULL DEFAULT 'USD',
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE package_services (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (package_id, service_id)
    );

    CREATE INDEX idx_events_customer_id ON events(customer_id);
    CREATE INDEX idx_package_services_package_id ON package_services(package_id);
    CREATE INDEX idx_package_services_service_id ON package_services(service_id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS package_services CASCADE;
    DROP TABLE IF EXISTS packages CASCADE;
    DROP TABLE IF EXISTS events CASCADE;
  `);
};

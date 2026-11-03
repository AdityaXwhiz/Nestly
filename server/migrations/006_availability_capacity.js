/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE availability (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      resource_type text NOT NULL CHECK (resource_type IN ('PROPERTY', 'SERVICE')),
      resource_id uuid NOT NULL,
      slot_start timestamptz NOT NULL,
      slot_end timestamptz NOT NULL,
      is_available boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE service_capacity (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      slot text NOT NULL,
      capacity int NOT NULL CHECK (capacity >= 0),
      reserved int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT check_reserved_capacity CHECK (reserved >= 0 AND reserved <= capacity),
      UNIQUE (service_id, slot)
    );

    CREATE INDEX idx_availability_resource ON availability(resource_type, resource_id);
    CREATE INDEX idx_service_capacity_lookup ON service_capacity(service_id, slot);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS service_capacity CASCADE;
    DROP TABLE IF EXISTS availability CASCADE;
  `);
};

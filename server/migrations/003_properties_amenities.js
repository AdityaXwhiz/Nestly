/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE properties (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL,
      description text NOT NULL,
      location text NOT NULL,
      capacity int NOT NULL CHECK (capacity > 0),
      pricing_minor bigint NOT NULL CHECK (pricing_minor >= 0),
      currency varchar(3) NOT NULL DEFAULT 'USD',
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DRAFT', 'DELETED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE property_images (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      url text NOT NULL,
      caption text,
      sort_order int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE amenities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_properties_host_id ON properties(host_id);
    CREATE INDEX idx_property_images_property_id ON property_images(property_id);
    CREATE INDEX idx_amenities_property_id ON amenities(property_id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS amenities CASCADE;
    DROP TABLE IF EXISTS property_images CASCADE;
    DROP TABLE IF EXISTS properties CASCADE;
  `);
};

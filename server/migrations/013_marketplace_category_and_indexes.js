/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- 1. Add category column to services for marketplace filtering
    ALTER TABLE services
    ADD COLUMN category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('catering', 'decoration', 'cake', 'photography', 'music', 'other'));

    -- 2. Index for case-insensitive location filtering on active properties
    CREATE INDEX idx_properties_status_lower_location ON properties(status, lower(location));

    -- 3. Index for price-range filtering on active properties
    CREATE INDEX idx_properties_status_pricing ON properties(status, pricing_minor);

    -- 4. Index for category filtering on active services
    CREATE INDEX idx_services_status_category ON services(status, category);

    -- 5. Index for price filtering on active services
    CREATE INDEX idx_services_status_price ON services(status, price_minor);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_services_status_price;
    DROP INDEX IF EXISTS idx_services_status_category;
    DROP INDEX IF EXISTS idx_properties_status_pricing;
    DROP INDEX IF EXISTS idx_properties_status_lower_location;
    ALTER TABLE services DROP COLUMN IF EXISTS category;
  `);
};

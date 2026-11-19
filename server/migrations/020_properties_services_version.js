/**
 * Migration 020: Add version column and auto-bump trigger to properties and services.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- 1. Add version column to properties and services
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
    ALTER TABLE services ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;

    -- 2. Trigger function to bump version and updated_at on every update
    CREATE OR REPLACE FUNCTION bump_row_version()
    RETURNS trigger AS $$
    BEGIN
      NEW.version = OLD.version + 1;
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- 3. Attach BEFORE UPDATE trigger to properties
    DROP TRIGGER IF EXISTS trg_properties_bump_version ON properties;
    CREATE TRIGGER trg_properties_bump_version
    BEFORE UPDATE ON properties
    FOR EACH ROW
    EXECUTE FUNCTION bump_row_version();

    -- 4. Attach BEFORE UPDATE trigger to services
    DROP TRIGGER IF EXISTS trg_services_bump_version ON services;
    CREATE TRIGGER trg_services_bump_version
    BEFORE UPDATE ON services
    FOR EACH ROW
    EXECUTE FUNCTION bump_row_version();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_services_bump_version ON services;
    DROP TRIGGER IF EXISTS trg_properties_bump_version ON properties;
    DROP FUNCTION IF EXISTS bump_row_version;

    ALTER TABLE services DROP COLUMN IF EXISTS version;
    ALTER TABLE properties DROP COLUMN IF EXISTS version;
  `);
};

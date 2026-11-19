/**
 * Migration 019: Add presigned upload fields, status lifecycle, and constraints to property_images.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- 1. Make url nullable so PENDING images can be created before confirmation
    ALTER TABLE property_images ALTER COLUMN url DROP NOT NULL;

    -- 2. Add key column with safe backfill for existing rows
    ALTER TABLE property_images ADD COLUMN IF NOT EXISTS key text;
    UPDATE property_images SET key = 'properties/' || property_id || '/' || id || '.jpg' WHERE key IS NULL;
    ALTER TABLE property_images ALTER COLUMN key SET NOT NULL;
    ALTER TABLE property_images ADD CONSTRAINT uq_property_images_key UNIQUE (key);

    -- 3. Add status column with check constraint
    ALTER TABLE property_images ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PENDING';
    ALTER TABLE property_images ADD CONSTRAINT chk_property_images_status CHECK (status IN ('PENDING', 'READY', 'FAILED'));
    UPDATE property_images SET status = 'READY' WHERE url IS NOT NULL;

    -- 4. Add content_type column with safe backfill
    ALTER TABLE property_images ADD COLUMN IF NOT EXISTS content_type text;
    UPDATE property_images SET content_type = 'image/jpeg' WHERE content_type IS NULL;
    ALTER TABLE property_images ALTER COLUMN content_type SET NOT NULL;
    ALTER TABLE property_images ADD CONSTRAINT chk_property_images_content_type CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp'));

    -- 5. Add size_bytes column with safe backfill
    ALTER TABLE property_images ADD COLUMN IF NOT EXISTS size_bytes bigint;
    UPDATE property_images SET size_bytes = 0 WHERE size_bytes IS NULL;
    ALTER TABLE property_images ALTER COLUMN size_bytes SET NOT NULL;
    ALTER TABLE property_images ADD CONSTRAINT chk_property_images_size_bytes CHECK (size_bytes >= 0 AND size_bytes <= 5242880);

    -- 6. Add updated_at column
    ALTER TABLE property_images ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

    -- 7. Add partial indexes for cleanup and ready queries
    CREATE INDEX IF NOT EXISTS idx_property_images_pending_created ON property_images (created_at) WHERE status = 'PENDING';
    CREATE INDEX IF NOT EXISTS idx_property_images_property_ready ON property_images (property_id, sort_order) WHERE status = 'READY';
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_property_images_property_ready;
    DROP INDEX IF EXISTS idx_property_images_pending_created;

    ALTER TABLE property_images DROP CONSTRAINT IF EXISTS chk_property_images_size_bytes;
    ALTER TABLE property_images DROP CONSTRAINT IF EXISTS chk_property_images_content_type;
    ALTER TABLE property_images DROP CONSTRAINT IF EXISTS chk_property_images_status;
    ALTER TABLE property_images DROP CONSTRAINT IF EXISTS uq_property_images_key;

    ALTER TABLE property_images DROP COLUMN IF EXISTS updated_at;
    ALTER TABLE property_images DROP COLUMN IF EXISTS size_bytes;
    ALTER TABLE property_images DROP COLUMN IF EXISTS content_type;
    ALTER TABLE property_images DROP COLUMN IF EXISTS status;
    ALTER TABLE property_images DROP COLUMN IF EXISTS key;

    -- Backfill null url before restoring NOT NULL
    UPDATE property_images SET url = 'https://example.com/placeholder.jpg' WHERE url IS NULL;
    ALTER TABLE property_images ALTER COLUMN url SET NOT NULL;
  `);
};

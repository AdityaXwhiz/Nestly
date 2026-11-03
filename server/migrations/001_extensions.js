/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS "btree_gist";
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP EXTENSION IF EXISTS "btree_gist";
    DROP EXTENSION IF EXISTS "pgcrypto";
  `);
};

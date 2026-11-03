/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE idempotency_keys (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation text NOT NULL,
      idempotency_key text NOT NULL,
      request_hash text NOT NULL,
      status text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
      response_reference text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (user_id, operation, idempotency_key)
    );

    CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS idempotency_keys CASCADE;
  `);
};

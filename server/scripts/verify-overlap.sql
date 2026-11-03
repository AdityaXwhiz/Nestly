-- server/scripts/verify-overlap.sql
-- Verification script for PostgreSQL EXCLUDE constraint on reservations (LLD Section 5)

DO $$
DECLARE
  v_user_id uuid;
  v_order_id uuid;
  v_item_id_1 uuid;
  v_item_id_2 uuid;
  v_res_id_1 uuid := gen_random_uuid();
  v_res_id_2 uuid := gen_random_uuid();
  v_caught_23p01 boolean := false;
  v_reservation_id uuid;
BEGIN
  RAISE NOTICE '=== STARTING RESERVATION OVERLAP CONSTRAINT VERIFICATION ===';

  -- Setup prerequisite records
  INSERT INTO users (email, role, password_hash)
  VALUES ('test-overlap@nestly.internal', 'CUSTOMER', 'hash123')
  RETURNING id INTO v_user_id;

  INSERT INTO orders (user_id, status, total_amount_minor, currency)
  VALUES (v_user_id, 'PENDING', 50000, 'USD')
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, resource_type, resource_id, quantity, unit_price_minor, currency)
  VALUES (v_order_id, 'PROPERTY', v_res_id_1, 1, 30000, 'USD')
  RETURNING id INTO v_item_id_1;

  INSERT INTO order_items (order_id, resource_type, resource_id, quantity, unit_price_minor, currency)
  VALUES (v_order_id, 'SERVICE', v_res_id_2, 1, 20000, 'USD')
  RETURNING id INTO v_item_id_2;

  -- -------------------------------------------------------------
  -- TEST 1: Two overlapping HELD reservations for the same resource
  -- Expectation: Second insert fails with SQLSTATE 23P01 (exclusion_violation)
  -- -------------------------------------------------------------
  INSERT INTO reservations (order_item_id, resource_type, resource_id, during, status, hold_expires_at)
  VALUES (
    v_item_id_1,
    'PROPERTY',
    v_res_id_1,
    tstzrange('2026-12-01 10:00:00+00', '2026-12-01 14:00:00+00', '[)'),
    'HELD',
    now() + interval '15 minutes'
  )
  RETURNING id INTO v_reservation_id;

  BEGIN
    INSERT INTO reservations (order_item_id, resource_type, resource_id, during, status, hold_expires_at)
    VALUES (
      v_item_id_1,
      'PROPERTY',
      v_res_id_1,
      tstzrange('2026-12-01 12:00:00+00', '2026-12-01 16:00:00+00', '[)'),
      'HELD',
      now() + interval '15 minutes'
    );
  EXCEPTION
    WHEN SQLSTATE '23P01' THEN
      v_caught_23p01 := true;
      RAISE NOTICE '✓ TEST 1 PASSED: Overlapping HELD reservation rejected with SQLSTATE 23P01 (exclusion_violation).';
  END;

  IF NOT v_caught_23p01 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: Expected SQLSTATE 23P01 for overlapping HELD reservations, but none was raised.';
  END IF;

  -- -------------------------------------------------------------
  -- TEST 2: Overlap succeeds if first row is CANCELLED or EXPIRED
  -- Expectation: Marking first row CANCELLED frees slot; second overlapping insert succeeds
  -- -------------------------------------------------------------
  UPDATE reservations
  SET status = 'CANCELLED'
  WHERE id = v_reservation_id;

  INSERT INTO reservations (order_item_id, resource_type, resource_id, during, status, hold_expires_at)
  VALUES (
    v_item_id_1,
    'PROPERTY',
    v_res_id_1,
    tstzrange('2026-12-01 12:00:00+00', '2026-12-01 16:00:00+00', '[)'),
    'HELD',
    now() + interval '15 minutes'
  );
  RAISE NOTICE '✓ TEST 2 PASSED: Overlapping reservation succeeded after prior reservation was CANCELLED.';

  -- -------------------------------------------------------------
  -- TEST 3: Non-overlapping ranges for the same resource both succeed
  -- Expectation: Adjacent/non-overlapping range for v_res_id_1 succeeds alongside active HELD row
  -- -------------------------------------------------------------
  INSERT INTO reservations (order_item_id, resource_type, resource_id, during, status, hold_expires_at)
  VALUES (
    v_item_id_1,
    'PROPERTY',
    v_res_id_1,
    tstzrange('2026-12-01 16:00:00+00', '2026-12-01 20:00:00+00', '[)'),
    'HELD',
    now() + interval '15 minutes'
  );
  RAISE NOTICE '✓ TEST 3 PASSED: Non-overlapping ranges for the same resource both active and succeeded.';

  -- -------------------------------------------------------------
  -- TEST 4: Overlapping ranges for DIFFERENT resources both succeed
  -- Expectation: Same time range as active reservation but for v_res_id_2 succeeds
  -- -------------------------------------------------------------
  INSERT INTO reservations (order_item_id, resource_type, resource_id, during, status, hold_expires_at)
  VALUES (
    v_item_id_2,
    'SERVICE',
    v_res_id_2,
    tstzrange('2026-12-01 12:00:00+00', '2026-12-01 16:00:00+00', '[)'),
    'HELD',
    now() + interval '15 minutes'
  );
  RAISE NOTICE '✓ TEST 4 PASSED: Overlapping ranges for DIFFERENT resources both succeeded.';

  -- Clean up test records
  DELETE FROM users WHERE id = v_user_id;
  RAISE NOTICE '=== ALL 4 OVERLAP TESTS COMPLETED SUCCESSFULLY! ===';
END $$;

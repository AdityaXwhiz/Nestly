import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { pathToFileURL } from 'node:url';
import { pool } from '../src/infrastructure/postgres.js';
import { sqsClient, QUEUE_DEFINITIONS } from '../src/infrastructure/sqs/client.js';
import { env } from '../src/config/env.js';

/**
 * Evaluate all Step 13C database, payment-provider, and queue invariants once.
 * Returns { allPassed, results: Array<{ id, name, passed, count, detail, transient }> }.
 */
export async function checkAllInvariants({
  dbPool = pool,
  sqs = sqsClient,
  queues = QUEUE_DEFINITIONS,
  mockStatsUrl = `${env.PAYMENT_PROVIDER_URL.replace(/\/+$/, '')}/stats`,
  requireMockStats = process.env.ENABLE_MOCK_STATS === 'true' || process.argv.includes('--require-mock-stats'),
  staleSeconds = env.SAGA_STALE_SECONDS,
} = {}) {
  const results = [];

  // 1. No overlapping active reservations for any exclusive resource
  const overlapRes = await dbPool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM reservations r1
    JOIN reservations r2
      ON r1.id < r2.id
     AND r1.resource_id = r2.resource_id
     AND r1.during && r2.during
    WHERE r1.is_exclusive = true
      AND r2.is_exclusive = true
      AND r1.status IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED')
      AND r2.status IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED');
  `);
  const overlapCount = overlapRes.rows[0].cnt;
  results.push({
    id: 'exclusive_no_overlap',
    name: 'No overlapping active reservations for exclusive resources',
    passed: overlapCount === 0,
    count: overlapCount,
    transient: false,
    detail: overlapCount === 0 ? '0 overlapping pairs' : `${overlapCount} overlapping exclusive reservation pair(s)`,
  });

  // 2. Capacity reserved never exceeds capacity and equals SUM(quantity) of active reservations
  const capRes = await dbPool.query(`
    WITH active_sums AS (
      SELECT resource_id AS service_id, slot, COALESCE(SUM(quantity), 0)::int AS active_qty
      FROM reservations
      WHERE resource_type = 'SERVICE'
        AND is_exclusive = false
        AND status IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED')
      GROUP BY resource_id, slot
    ),
    violations AS (
      SELECT sc.service_id, sc.slot, 'bounds' AS reason
      FROM service_capacity sc
      WHERE sc.reserved < 0 OR sc.reserved > sc.capacity
      UNION ALL
      SELECT sc.service_id, sc.slot, 'reserved_mismatch' AS reason
      FROM service_capacity sc
      LEFT JOIN active_sums a ON a.service_id = sc.service_id AND a.slot = sc.slot
      WHERE sc.reserved != COALESCE(a.active_qty, 0)
      UNION ALL
      SELECT a.service_id, a.slot, 'missing_capacity_row' AS reason
      FROM active_sums a
      LEFT JOIN service_capacity sc ON sc.service_id = a.service_id AND sc.slot = a.slot
      WHERE sc.id IS NULL
    )
    SELECT COUNT(*)::int AS cnt FROM violations;
  `);
  const capViolations = capRes.rows[0].cnt;
  results.push({
    id: 'capacity_consistency',
    name: 'Capacity reserved within bounds and equals sum of active reservation quantities',
    passed: capViolations === 0,
    count: capViolations,
    transient: false,
    detail: capViolations === 0 ? '0 capacity inconsistencies' : `${capViolations} service_capacity mismatch(es)`,
  });

  // 3. Every CONFIRMED order has all its items CONFIRMED and exactly one SUCCESS payment
  const confirmedRes = await dbPool.query(`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN reservations r
          ON r.order_item_id = oi.id
         AND r.status = 'CONFIRMED'
        WHERE o.status = 'CONFIRMED'
          AND r.id IS NULL
      ) AS missing_res_cnt,
      (
        SELECT COUNT(*)::int
        FROM orders o
        WHERE o.status = 'CONFIRMED'
          AND (
            (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id AND p.status = 'SUCCESS') != 1
            OR EXISTS (
              SELECT 1 FROM payments p
              WHERE p.order_id = o.id AND p.status IN ('CREATED', 'PENDING', 'PROCESSING')
            )
          )
      ) AS bad_pay_cnt;
  `);
  const badConfirmedCount = confirmedRes.rows[0].missing_res_cnt + confirmedRes.rows[0].bad_pay_cnt;
  results.push({
    id: 'confirmed_order_integrity',
    name: 'Every CONFIRMED order has all items CONFIRMED and exactly one SUCCESS payment',
    passed: badConfirmedCount === 0,
    count: badConfirmedCount,
    transient: false,
    detail:
      badConfirmedCount === 0
        ? 'All CONFIRMED orders consistent'
        : `missing_confirmed_res=${confirmedRes.rows[0].missing_res_cnt}, bad_payment=${confirmedRes.rows[0].bad_pay_cnt}`,
  });

  // 4. Order total equals sum of its snapshot order_items (Change #3)
  const orderTotalRes = await dbPool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM orders o
    LEFT JOIN (
      SELECT order_id, COALESCE(SUM(unit_price_minor::bigint * quantity::bigint), 0)::bigint AS item_sum
      FROM order_items
      GROUP BY order_id
    ) s ON s.order_id = o.id
    WHERE o.total_amount_minor != COALESCE(s.item_sum, 0);
  `);
  const badOrderTotals = orderTotalRes.rows[0].cnt;
  results.push({
    id: 'order_total_matches_snapshots',
    name: 'Order total equals sum of its snapshot order_items',
    passed: badOrderTotals === 0,
    count: badOrderTotals,
    transient: false,
    detail: badOrderTotals === 0 ? '0 total mismatches' : `${badOrderTotals} order(s) disagree with order_items sum`,
  });

  // 5. Payment amount equals order total (Change #3)
  const payAmtRes = await dbPool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE p.amount_minor != o.total_amount_minor;
  `);
  const badPayAmtCount = payAmtRes.rows[0].cnt;
  results.push({
    id: 'payment_amount_matches_order',
    name: 'Payment amount equals order total',
    passed: badPayAmtCount === 0,
    count: badPayAmtCount,
    transient: false,
    detail: badPayAmtCount === 0 ? '0 amount mismatches' : `${badPayAmtCount} payment(s) differ from order total`,
  });

  // 6. Provider charges (mock stats) equal payments sent to provider (Change #3)
  const dbProviderRes = await dbPool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM payments
    WHERE provider_reference IS NOT NULL
      AND status IN ('PROCESSING', 'SUCCESS', 'FAILED', 'REFUNDED');
  `);
  const dbProviderCharges = dbProviderRes.rows[0].cnt;
  let mockStatsResult = {
    id: 'provider_charges_match_db',
    name: 'Provider charges (mock stats) equal payments sent to provider',
    passed: true,
    count: 0,
    transient: true,
    detail: `skipped mock stats (${mockStatsUrl} unavailable)`,
  };
  try {
    const resp = await fetch(mockStatsUrl, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const stats = await resp.json();
      const diff = Math.abs((stats.chargesCount ?? 0) - dbProviderCharges);
      mockStatsResult = {
        id: 'provider_charges_match_db',
        name: 'Provider charges (mock stats) equal payments sent to provider',
        passed: diff === 0,
        count: diff,
        transient: true,
        detail: `mock chargesCount=${stats.chargesCount}, db provider-backed payments=${dbProviderCharges}`,
      };
    } else if (requireMockStats) {
      mockStatsResult = {
        id: 'provider_charges_match_db',
        name: 'Provider charges (mock stats) equal payments sent to provider',
        passed: false,
        count: 1,
        transient: true,
        detail: `mock /stats returned HTTP ${resp.status} while required`,
      };
    }
  } catch (err) {
    if (requireMockStats) {
      mockStatsResult = {
        id: 'provider_charges_match_db',
        name: 'Provider charges (mock stats) equal payments sent to provider',
        passed: false,
        count: 1,
        transient: true,
        detail: `failed querying ${mockStatsUrl}: ${err.message}`,
      };
    }
  }
  results.push(mockStatsResult);

  // 7. No payment in SUCCESS with a FAILED order (refunded payments have status REFUNDED)
  const unrefundedRes = await dbPool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE o.status = 'FAILED'
      AND p.status = 'SUCCESS';
  `);
  const unrefundedCount = unrefundedRes.rows[0].cnt;
  results.push({
    id: 'no_unrefunded_success_on_failed_order',
    name: 'No payment in SUCCESS with a FAILED order unless refunded',
    passed: unrefundedCount === 0,
    count: unrefundedCount,
    transient: true,
    detail:
      unrefundedCount === 0
        ? '0 unrefunded SUCCESS payments on FAILED orders'
        : `${unrefundedCount} SUCCESS payment(s) on FAILED order waiting for/missing refund`,
  });

  // 8. No HELD reservation past its expiry (after hold sweeper has run)
  const expiredHeldRes = await dbPool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM reservations
    WHERE status = 'HELD'
      AND hold_expires_at <= now();
  `);
  const expiredHeldCount = expiredHeldRes.rows[0].cnt;
  results.push({
    id: 'no_expired_held_reservations',
    name: 'No HELD reservation past its expiry',
    passed: expiredHeldCount === 0,
    count: expiredHeldCount,
    transient: true,
    detail:
      expiredHeldCount === 0
        ? '0 expired HELD reservations'
        : `${expiredHeldCount} HELD reservation(s) past hold_expires_at`,
  });

  // 9. No non-terminal sagas beyond stale threshold (Change #3)
  const staleSagaRes = await dbPool.query(
    `
      SELECT COUNT(*)::int AS cnt
      FROM saga_instances
      WHERE state NOT IN ('COMPLETED', 'FAILED')
        AND updated_at <= now() - make_interval(secs => $1);
    `,
    [staleSeconds],
  );
  const staleSagas = staleSagaRes.rows[0].cnt;
  results.push({
    id: 'no_stale_non_terminal_sagas',
    name: `No non-terminal sagas beyond stale threshold (${staleSeconds}s)`,
    passed: staleSagas === 0,
    count: staleSagas,
    transient: true,
    detail: staleSagas === 0 ? '0 stale sagas' : `${staleSagas} stale non-terminal saga(s)`,
  });

  // 10. Outbox rows all published
  const outboxRes = await dbPool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM outbox
    WHERE published_at IS NULL;
  `);
  const unpublishedOutbox = outboxRes.rows[0].cnt;
  results.push({
    id: 'outbox_all_published',
    name: 'Outbox rows all published',
    passed: unpublishedOutbox === 0,
    count: unpublishedOutbox,
    transient: true,
    detail: unpublishedOutbox === 0 ? '0 unpublished outbox rows' : `${unpublishedOutbox} unpublished outbox row(s)`,
  });

  // 11. All SQS DLQs empty
  let totalDlqMessages = 0;
  const dlqDetails = [];
  for (const [key, def] of Object.entries(queues)) {
    const attrRes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: def.dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    const visible = Number(attrRes.Attributes?.ApproximateNumberOfMessages || 0);
    const notVisible = Number(attrRes.Attributes?.ApproximateNumberOfMessagesNotVisible || 0);
    const sum = visible + notVisible;
    totalDlqMessages += sum;
    if (sum > 0) {
      dlqDetails.push(`${key}=${sum}`);
    }
  }
  results.push({
    id: 'dlqs_empty',
    name: 'All SQS dead-letter queues empty',
    passed: totalDlqMessages === 0,
    count: totalDlqMessages,
    transient: true,
    detail: totalDlqMessages === 0 ? '0 DLQ messages' : `Non-empty DLQs: ${dlqDetails.join(', ')}`,
  });

  return {
    allPassed: results.every((r) => r.passed),
    results,
  };
}

/**
 * Poll checkAllInvariants until all rules pass or timeoutMs expires (Change #3).
 */
export async function verifyInvariantsWithPolling({
  timeoutMs = 45000,
  pollIntervalMs = 1500,
  ...checkOptions
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await checkAllInvariants(checkOptions);

  while (!last.allPassed && Date.now() < deadline) {
    // Immediate abort if any non-transient structural invariant is already violated
    if (last.results.some((r) => !r.passed && !r.transient)) {
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    last = await checkAllInvariants(checkOptions);
  }

  return last;
}

function parseArgValue(flag, defaultVal) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return Number(process.argv[idx + 1]);
  }
  return defaultVal;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timeoutMs = parseArgValue('--timeout-ms', 45000);
  const pollIntervalMs = parseArgValue('--poll-interval-ms', 1500);
  const requireMockStats = process.argv.includes('--require-mock-stats') || process.env.ENABLE_MOCK_STATS === 'true';

  verifyInvariantsWithPolling({ timeoutMs, pollIntervalMs, requireMockStats })
    .then(async (report) => {
      console.log('\n=== Nestly Invariant Verification ===');
      for (const r of report.results) {
        const badge = r.passed ? 'PASS' : 'FAIL';
        console.log(`[${badge}] ${r.id}: ${r.name} (${r.detail})`);
      }

      if (!report.allPassed) {
        const failing = report.results.filter((r) => !r.passed).map((r) => r.id);
        console.error(`\nInvariant verification FAILED (${failing.length} failing rule(s): ${failing.join(', ')})`);
        await pool.end().catch(() => {});
        process.exit(1);
      }

      console.log(`\nAll ${report.results.length} invariant checks PASSED.`);
      await pool.end().catch(() => {});
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Invariant check errored:', err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

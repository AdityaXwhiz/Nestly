import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import {
  API_BASE,
  MOCK_PROVIDER_URL,
  fixtures,
  authHeaders,
  pickCustomer,
  buildDisjointDates,
} from './lib/helpers.js';

/**
 * 04: Duplicate Payment Safety (Same Key & Different Keys Under Concurrency)
 *
 * Runs two sequential concurrency phases using http.batch() on fresh held orders:
 * - Phase A (10 rounds): fires 10 simultaneous POST /payments with the SAME Idempotency-Key
 * - Phase B (10 rounds): fires 10 simultaneous POST /payments with DIFFERENT Idempotency-Keys
 * Verifies 0 5xx responses, every paid order reaches CONFIRMED, and mock-provider
 * /stats counts exactly 1 charge per paid order (Change #3 / Req #4d).
 */

const PAID_ROUNDS_EACH = 10;
const PARALLEL_DUP_REQUESTS = 10;

const paidOrdersConfirmed = new Counter('dup_paid_orders_confirmed');
const server5xxRate = new Rate('server_5xx_rate');
const unexpectedPaymentStatusRate = new Rate('unexpected_payment_status_rate');
const chargeParityOk = new Counter('mock_charge_parity_ok');

export const options = {
  scenarios: {
    duplicate_payment_safety: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: PAID_ROUNDS_EACH * 2,
      maxDuration: '90s',
    },
  },
  thresholds: {
    dup_paid_orders_confirmed: [`count==${PAID_ROUNDS_EACH * 2}`],
    mock_charge_parity_ok: ['count>=1'],
    server_5xx_rate: [{ threshold: 'rate==0', abortOnFail: true }],
    unexpected_payment_status_rate: ['rate==0'],
    'http_req_duration{name:payment_duplicate_batch}': ['p(95)<500', 'p(99)<1000'],
  },
};

export function setup() {
  const beforeRes = http.get(`${MOCK_PROVIDER_URL}/stats`);
  const beforeCount = beforeRes.status === 200 ? beforeRes.json('chargesCount') : 0;
  return { baselineChargesCount: beforeCount };
}

export default function () {
  const iter = __ITER;
  const sameKeyPhase = iter < PAID_ROUNDS_EACH;
  const customer = pickCustomer(iter);
  const propId = fixtures.duplicatePaymentProperties[iter % fixtures.duplicatePaymentProperties.length];
  const { start, end } = buildDisjointDates(iter, 200);

  const orderRes = http.post(
    `${API_BASE}/orders`,
    JSON.stringify({
      property_id: propId,
      during: { start, end },
      guest_count: 2,
      services: [],
    }),
    { headers: authHeaders(customer.token), tags: { name: 'order_create' } },
  );
  check(orderRes, { 'order created 201': (r) => r.status === 201 });
  const orderId = orderRes.json('id') || orderRes.json('order.id');

  const holdRes = http.post(`${API_BASE}/orders/${orderId}/hold`, null, {
    headers: authHeaders(customer.token, { 'Idempotency-Key': `dup-hold-${iter}` }),
    tags: { name: 'order_hold' },
  });
  check(holdRes, { 'order held 200': (r) => r.status === 200 });

  // Fire 10 simultaneous POST /payments requests
  const batchReqs = [];
  for (let k = 0; k < PARALLEL_DUP_REQUESTS; k += 1) {
    const idemKey = sameKeyPhase ? `dup-same-${iter}` : `dup-diff-${iter}-${k}`;
    batchReqs.push([
      'POST',
      `${API_BASE}/payments`,
      JSON.stringify({ order_id: orderId }),
      {
        headers: authHeaders(customer.token, { 'Idempotency-Key': idemKey }),
        tags: { name: 'payment_duplicate_batch' },
        responseCallback: http.expectedStatuses(200, 202, 409),
      },
    ]);
  }

  const responses = http.batch(batchReqs);
  for (const r of responses) {
    server5xxRate.add(r.status >= 500 || r.status === 0);
    const okStatus = r.status === 200 || r.status === 202 || r.status === 409;
    unexpectedPaymentStatusRate.add(!okStatus);
  }

  // Wait for order to become CONFIRMED
  const deadline = Date.now() + 8000;
  let confirmed = false;
  while (Date.now() < deadline) {
    const pollRes = http.get(`${API_BASE}/orders/${orderId}`, {
      headers: authHeaders(customer.token),
      tags: { name: 'order_poll' },
    });
    const st = pollRes.json('order.status') || pollRes.json('status');
    if (st === 'CONFIRMED') {
      confirmed = true;
      break;
    }
    sleep(0.15);
  }
  if (confirmed) {
    paidOrdersConfirmed.add(1);
  }
}

export function teardown(data) {
  const afterRes = http.get(`${MOCK_PROVIDER_URL}/stats`);
  if (afterRes.status === 200) {
    const deltaCharges = (afterRes.json('chargesCount') || 0) - (data.baselineChargesCount || 0);
    if (deltaCharges === PAID_ROUNDS_EACH * 2) {
      chargeParityOk.add(1);
    }
    check(afterRes, {
      'exact 1 charge per paid order in mock provider': () => deltaCharges === PAID_ROUNDS_EACH * 2,
    });
  }
}

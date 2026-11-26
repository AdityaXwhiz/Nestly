import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { API_BASE, fixtures, authHeaders, pickCustomer } from './lib/helpers.js';

/**
 * 03: Same-Resource Contention in Rounds (Change #1, Change #4)
 *
 * 20 synchronized rounds of 50 simultaneous contenders (1,000 hold attempts total).
 * Each round targets a distinct property_id + date range; exactly 1 contender must win (200 HELD),
 * the remaining 49 must receive 409 (RESOURCE_CONFLICT / RESOURCE_BUSY), and 0 requests may 5xx.
 * The winner of each round immediately pays and polls until CONFIRMED.
 */

const ROUNDS = Number(__ENV.CONTENTION_ROUNDS || 20);
const CONTENDERS_PER_ROUND = 50;

const holdWinners = new Counter('hold_winners');
const holdConflicts = new Counter('hold_conflicts');
const confirmedWinners = new Counter('confirmed_winners');
const server5xxRate = new Rate('server_5xx_rate');
const unexpectedHoldStatusRate = new Rate('unexpected_hold_status_rate');

const roundScenarios = {};
for (let r = 0; r < ROUNDS; r += 1) {
  roundScenarios[`round_${r}`] = {
    executor: 'per-vu-iterations',
    vus: CONTENDERS_PER_ROUND,
    iterations: 1,
    startTime: `${r * 3}s`,
    maxDuration: '3s',
    gracefulStop: '2s',
    exec: 'runRound',
    env: { ROUND_INDEX: String(r) },
  };
}

export const options = {
  scenarios: roundScenarios,
  thresholds: {
    // Exactly 1 winner per round across all rounds, strict 0 5xx budget (Change #4, Change #9)
    hold_winners: [`count==${ROUNDS}`],
    confirmed_winners: [`count==${ROUNDS}`],
    server_5xx_rate: [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '3s' }],
    unexpected_hold_status_rate: ['rate==0'],
    'http_req_duration{name:order_hold}': ['p(95)<1500', 'p(99)<3000'],
  },
};

export function runRound() {
  const roundIdx = Number(__ENV.ROUND_INDEX || 0);
  const contenderIdx = (__VU - 1) % CONTENDERS_PER_ROUND;
  const customer = pickCustomer(contenderIdx);
  const propertyId = fixtures.contentionProperties[roundIdx % fixtures.contentionProperties.length];

  const dayBase = Date.UTC(2027, 8, 1 + roundIdx, 0, 0, 0);
  const start = new Date(dayBase).toISOString();
  const end = new Date(dayBase + 24 * 60 * 60 * 1000).toISOString();

  // Accept 409 as expected domain outcome during contention
  const orderRes = http.post(
    `${API_BASE}/orders`,
    JSON.stringify({
      property_id: propertyId,
      during: { start, end },
      guest_count: 2,
      services: [],
    }),
    {
      headers: authHeaders(customer.token),
      tags: { name: 'order_create' },
      responseCallback: http.expectedStatuses(201),
    },
  );
  server5xxRate.add(orderRes.status >= 500 || orderRes.status === 0);

  if (orderRes.status !== 201) {
    unexpectedHoldStatusRate.add(true);
    return;
  }

  const orderBody = orderRes.json();
  const orderId = orderBody.id || orderBody.order?.id;

  const holdRes = http.post(`${API_BASE}/orders/${orderId}/hold`, null, {
    headers: authHeaders(customer.token, {
      'Idempotency-Key': `lt-hold-r${roundIdx}-c${contenderIdx}`,
    }),
    tags: { name: 'order_hold' },
    responseCallback: http.expectedStatuses(200, 409),
  });

  server5xxRate.add(holdRes.status >= 500 || holdRes.status === 0);

  if (holdRes.status === 200) {
    holdWinners.add(1);
    unexpectedHoldStatusRate.add(false);

    // Winner immediately submits payment and polls until CONFIRMED
    const payRes = http.post(
      `${API_BASE}/payments`,
      JSON.stringify({ order_id: orderId }),
      {
        headers: authHeaders(customer.token, {
          'Idempotency-Key': `lt-pay-r${roundIdx}-winner`,
        }),
        tags: { name: 'payment_create' },
        responseCallback: http.expectedStatuses(200, 202),
      },
    );
    server5xxRate.add(payRes.status >= 500 || payRes.status === 0);
    check(payRes, { 'winner pay 202': (r) => r.status === 202 || r.status === 200 });

    const deadline = Date.now() + 8000;
    let confirmed = false;
    while (Date.now() < deadline) {
      const pollRes = http.get(`${API_BASE}/orders/${orderId}`, {
        headers: authHeaders(customer.token),
        tags: { name: 'order_poll' },
      });
      server5xxRate.add(pollRes.status >= 500 || pollRes.status === 0);
      const status = pollRes.json('order.status') || pollRes.json('status');
      if (status === 'CONFIRMED') {
        confirmed = true;
        break;
      }
      sleep(0.15);
    }
    if (confirmed) {
      confirmedWinners.add(1);
    }
  } else if (holdRes.status === 409) {
    holdConflicts.add(1);
    unexpectedHoldStatusRate.add(false);
  } else {
    unexpectedHoldStatusRate.add(true);
  }
}

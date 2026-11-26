import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { API_BASE, fixtures, authHeaders, pickCustomer, buildDisjointDates } from './lib/helpers.js';

/**
 * 05: Queue Stress (High-Rate Order Confirmation -> Outbox -> SQS -> Consumers)
 *
 * Generates confirmed composite bookings (disjoint properties + capacity services) rapidly
 * so outbox rows & multi-queue SQS events flood all 4 consumer queues concurrently.
 * Runner measures outbox lag, queue depth, consumer throughput, drain time, and DLQ=0.
 */

const queueBookingsConfirmed = new Counter('queue_bookings_confirmed');
const server5xxRate = new Rate('server_5xx_rate');

export const options = {
  scenarios: {
    queue_flood: {
      executor: 'shared-iterations',
      vus: Number(__ENV.QUEUE_VUS || 12),
      iterations: Number(__ENV.QUEUE_ITERATIONS || 90),
      maxDuration: '90s',
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '5s' }],
    server_5xx_rate: [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '5s' }],
    'http_req_duration{name:order_create}': ['p(95)<500'],
    'http_req_duration{name:order_hold}': ['p(95)<800'],
    'http_req_duration{name:payment_create}': ['p(95)<500'],
    queue_bookings_confirmed: [`count>=${Number(__ENV.QUEUE_ITERATIONS || 90)}`],
  },
};

export default function () {
  const globalIter = exec.scenario.iterationInTest;
  const customer = pickCustomer(globalIter);
  const propId = fixtures.bookingProperties[globalIter % fixtures.bookingProperties.length];
  const roundCycle = Math.floor(globalIter / fixtures.bookingProperties.length);
  const { start, end, slotDate } = buildDisjointDates(roundCycle, 320);

  // Include 1 capacity-based service to exercise service_capacity + outbox fan-out cleanly
  const capSvc = fixtures.capacityServices[globalIter % fixtures.capacityServices.length];

  const orderRes = http.post(
    `${API_BASE}/orders`,
    JSON.stringify({
      property_id: propId,
      during: { start, end },
      guest_count: 2,
      services: [{ service_id: capSvc.id, quantity: 1, slot: slotDate }],
    }),
    { headers: authHeaders(customer.token), tags: { name: 'order_create' } },
  );
  server5xxRate.add(orderRes.status >= 500 || orderRes.status === 0);
  if (!check(orderRes, { 'queue order 201': (r) => r.status === 201 })) return;

  const orderId = orderRes.json('id') || orderRes.json('order.id');
  const holdRes = http.post(`${API_BASE}/orders/${orderId}/hold`, null, {
    headers: authHeaders(customer.token, { 'Idempotency-Key': `q-hold-${globalIter}` }),
    tags: { name: 'order_hold' },
  });
  server5xxRate.add(holdRes.status >= 500 || holdRes.status === 0);
  if (!check(holdRes, { 'queue hold 200': (r) => r.status === 200 })) return;

  const payRes = http.post(
    `${API_BASE}/payments`,
    JSON.stringify({ order_id: orderId }),
    {
      headers: authHeaders(customer.token, { 'Idempotency-Key': `q-pay-${globalIter}` }),
      tags: { name: 'payment_create' },
    },
  );
  server5xxRate.add(payRes.status >= 500 || payRes.status === 0);
  if (!check(payRes, { 'queue pay 202': (r) => r.status === 200 || r.status === 202 })) return;

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const pollRes = http.get(`${API_BASE}/orders/${orderId}`, {
      headers: authHeaders(customer.token),
      tags: { name: 'order_poll' },
    });
    const st = pollRes.json('order.status') || pollRes.json('status');
    if (st === 'CONFIRMED') {
      queueBookingsConfirmed.add(1);
      return;
    }
    sleep(0.15);
  }
}

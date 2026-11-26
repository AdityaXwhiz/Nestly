import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import {
  API_BASE,
  fixtures,
  authHeaders,
  pickCustomer,
  pickSkewed,
  buildDisjointDates,
} from './lib/helpers.js';

/**
 * 06: Mixed Full-Journey Workload (VU executor per Change #1)
 *
 * Ramps concurrent VUs past HLD 100x burst (~12 search RPS + ~1.2 booking RPS)
 * to probe container CPU/DB saturation:
 * - ~82% browse/search path (search -> property detail -> availability)
 * - ~18% end-to-end checkout path (search -> detail -> availability -> create -> hold -> pay -> poll)
 */

const mixedJourneysConfirmed = new Counter('mixed_journeys_confirmed');
const server5xxRate = new Rate('server_5xx_rate');

export const options = {
  scenarios: {
    mixed_workload: {
      executor: 'ramping-vus',
      startVUs: 6,
      stages: [
        { target: 12, duration: '10s' },
        { target: 30, duration: '20s' },
        { target: 50, duration: '20s' },
        { target: 10, duration: '10s' },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '8s' }],
    server_5xx_rate: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '8s' }],
    'http_req_duration{name:search_properties}': ['p(95)<600', 'p(99)<1500'],
    'http_req_duration{name:property_detail}': ['p(95)<400', 'p(99)<1000'],
    'http_req_duration{name:order_create}': ['p(95)<800', 'p(99)<1800'],
    'http_req_duration{name:order_hold}': ['p(95)<1200', 'p(99)<2500'],
    'http_req_duration{name:payment_create}': ['p(95)<800', 'p(99)<1800'],
  },
};

export default function () {
  const iter = exec.scenario.iterationInTest;
  const isHot = Math.random() < 0.75;
  const term = isHot
    ? pickSkewed(fixtures.searchTerms.hotQueries, 3)
    : pickSkewed(fixtures.searchTerms.coldQueries, 5);

  const searchRes = http.get(
    `${API_BASE}/search/properties?q=${encodeURIComponent(term.q)}&location=${encodeURIComponent(term.location)}&limit=20`,
    { tags: { name: 'search_properties' } },
  );
  server5xxRate.add(searchRes.status >= 500 || searchRes.status === 0);
  check(searchRes, { 'mixed search 200': (r) => r.status === 200 });

  const browsePropId =
    Math.random() < 0.75
      ? pickSkewed(fixtures.hotProperties, 25)
      : pickSkewed(fixtures.coldProperties, fixtures.coldProperties.length);
  const detailRes = http.get(`${API_BASE}/properties/${browsePropId}`, {
    tags: { name: 'property_detail' },
  });
  server5xxRate.add(detailRes.status >= 500 || detailRes.status === 0);
  check(detailRes, { 'mixed detail 200': (r) => r.status === 200 });

  const availRes = http.get(
    `${API_BASE}/properties/${browsePropId}/availability?from=2027-06-01T00:00:00Z&to=2027-06-30T00:00:00Z`,
    { tags: { name: 'property_availability' } },
  );
  server5xxRate.add(availRes.status >= 500 || availRes.status === 0);
  check(availRes, { 'mixed availability 200': (r) => r.status === 200 });

  // ~18% proceed to full checkout + payment
  if ((iter % 11) < 2) {
    const customer = pickCustomer(iter);
    const propId = fixtures.bookingProperties[iter % fixtures.bookingProperties.length];
    const cycle = Math.floor(iter / fixtures.bookingProperties.length);
    const { start, end, slotDate } = buildDisjointDates(cycle, 500);
    const capSvc = fixtures.capacityServices[iter % fixtures.capacityServices.length];

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
    if (!check(orderRes, { 'mixed order 201': (r) => r.status === 201 })) return;

    const orderId = orderRes.json('id') || orderRes.json('order.id');
    const holdRes = http.post(`${API_BASE}/orders/${orderId}/hold`, null, {
      headers: authHeaders(customer.token, { 'Idempotency-Key': `mix-hold-${iter}` }),
      tags: { name: 'order_hold' },
    });
    server5xxRate.add(holdRes.status >= 500 || holdRes.status === 0);
    if (!check(holdRes, { 'mixed hold 200': (r) => r.status === 200 })) return;

    const payRes = http.post(
      `${API_BASE}/payments`,
      JSON.stringify({ order_id: orderId }),
      {
        headers: authHeaders(customer.token, { 'Idempotency-Key': `mix-pay-${iter}` }),
        tags: { name: 'payment_create' },
      },
    );
    server5xxRate.add(payRes.status >= 500 || payRes.status === 0);
    if (!check(payRes, { 'mixed pay 202': (r) => r.status === 200 || r.status === 202 })) return;

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const pollRes = http.get(`${API_BASE}/orders/${orderId}`, {
        headers: authHeaders(customer.token),
        tags: { name: 'order_poll' },
      });
      const st = pollRes.json('order.status') || pollRes.json('status');
      if (st === 'CONFIRMED') {
        mixedJourneysConfirmed.add(1);
        break;
      }
      sleep(0.15);
    }
  } else {
    sleep(0.05);
  }
}

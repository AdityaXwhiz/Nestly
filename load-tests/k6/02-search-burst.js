import http from 'k6/http';
import { check } from 'k6';
import { API_BASE, fixtures, pickSkewed } from './lib/helpers.js';

/**
 * 02: Burst Search & Browse Spike (ramping-arrival-rate executor per Change #1)
 *
 * Ramps from 12 RPS (100x HLD baseline) to a sudden 160 RPS spike, holds,
 * pushes to 220 RPS stress peak, and steps back down to 12 RPS to verify clean recovery.
 * Note: abortOnFail triggers early stop if server errors exceed 2% during spike (Change #9).
 */
export const options = {
  scenarios: {
    burst_search: {
      executor: 'ramping-arrival-rate',
      startRate: 12,
      timeUnit: '1s',
      preAllocatedVUs: 60,
      maxVUs: 250,
      stages: [
        { target: 12, duration: '10s' },
        { target: 140, duration: '10s' },
        { target: 140, duration: '15s' },
        { target: 220, duration: '10s' },
        { target: 12, duration: '15s' },
      ],
    },
  },
  thresholds: {
    // Abort stress spike early if 5xx/request errors exceed 2% (Change #9)
    http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '5s' }],
    'http_req_duration{name:search_properties}': ['p(95)<600', 'p(99)<1200'],
    'http_req_duration{name:property_detail}': ['p(95)<350', 'p(99)<800'],
  },
};

export default function () {
  const roll = Math.random();
  if (roll < 0.65) {
    const isHot = Math.random() < 0.75;
    const term = isHot
      ? pickSkewed(fixtures.searchTerms.hotQueries, 3)
      : pickSkewed(fixtures.searchTerms.coldQueries, 5);
    const res = http.get(
      `${API_BASE}/search/properties?q=${encodeURIComponent(term.q)}&location=${encodeURIComponent(term.location)}&limit=20`,
      { tags: { name: 'search_properties' } },
    );
    check(res, { 'burst search 200': (r) => r.status === 200 });
  } else {
    const propId =
      Math.random() < 0.75
        ? pickSkewed(fixtures.hotProperties, 25)
        : pickSkewed(fixtures.coldProperties, fixtures.coldProperties.length);
    const res = http.get(`${API_BASE}/properties/${propId}`, { tags: { name: 'property_detail' } });
    check(res, { 'burst detail 200': (r) => r.status === 200 });
  }
}

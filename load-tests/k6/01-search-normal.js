import http from 'k6/http';
import { check } from 'k6';
import { API_BASE, fixtures, pickSkewed } from './lib/helpers.js';

/**
 * 01: Normal Search & Browse Mix (ramping-arrival-rate executor per Change #1)
 *
 * Targets HLD Section 2 baseline+burst (12 RPS) and steps up to 25 RPS to measure
 * headroom cleanly without coordinated omission.
 * Uses skewed 75/25 hot-vs-cold queries so Redis cache hit ratio reflects real browse patterns.
 */
export const options = {
  scenarios: {
    normal_search_mix: {
      executor: 'ramping-arrival-rate',
      startRate: 6,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [
        { target: 12, duration: '15s' },
        { target: 25, duration: '20s' },
        { target: 12, duration: '15s' },
      ],
    },
  },
  thresholds: {
    // Threshold reasoning (Change #9): HLD cached reads/search budget <250ms P95, <500ms P99
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '5s' }],
    'http_req_duration{name:search_properties}': ['p(95)<250', 'p(99)<500'],
    'http_req_duration{name:search_services}': ['p(95)<250', 'p(99)<500'],
    'http_req_duration{name:property_detail}': ['p(95)<150', 'p(99)<350'],
    'http_req_duration{name:property_availability}': ['p(95)<200', 'p(99)<400'],
    dropped_iterations: ['count<20'],
  },
};

export default function () {
  const roll = Math.random();

  if (roll < 0.45) {
    // Skewed property search (75% hot popular city/theme, 25% long tail + filters)
    const isHot = Math.random() < 0.75;
    const term = isHot
      ? pickSkewed(fixtures.searchTerms.hotQueries, 3)
      : pickSkewed(fixtures.searchTerms.coldQueries, 5);
    const url = isHot
      ? `${API_BASE}/search/properties?q=${encodeURIComponent(term.q)}&location=${encodeURIComponent(term.location)}&limit=20`
      : `${API_BASE}/search/properties?q=${encodeURIComponent(term.q)}&location=${encodeURIComponent(term.location)}&max_price=900000&limit=20`;

    const res = http.get(url, { tags: { name: 'search_properties' } });
    check(res, { 'search properties 200': (r) => r.status === 200 });
  } else if (roll < 0.65) {
    // Service search
    const cat = Math.random() < 0.75 ? fixtures.searchTerms.categories[0] : pickSkewed(fixtures.searchTerms.categories, 6);
    const res = http.get(`${API_BASE}/search/services?category=${encodeURIComponent(cat)}&limit=20`, {
      tags: { name: 'search_services' },
    });
    check(res, { 'search services 200': (r) => r.status === 200 });
  } else if (roll < 0.85) {
    // Property detail read (skewed: 75% hot properties -> cache hit, 25% cold pool -> DB/cache fill)
    const propId =
      Math.random() < 0.75
        ? pickSkewed(fixtures.hotProperties, 25)
        : pickSkewed(fixtures.coldProperties, fixtures.coldProperties.length);
    const res = http.get(`${API_BASE}/properties/${propId}`, { tags: { name: 'property_detail' } });
    check(res, { 'property detail 200': (r) => r.status === 200 });
  } else {
    // Indicative availability check (always authoritative DB read, never cached)
    const propId = pickSkewed(fixtures.hotProperties, 50);
    const res = http.get(
      `${API_BASE}/properties/${propId}/availability?from=2027-06-01T00:00:00Z&to=2027-06-30T00:00:00Z`,
      { tags: { name: 'property_availability' } },
    );
    check(res, { 'availability 200': (r) => r.status === 200 });
  }
}

import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * 00: Cheap CI 10-second k6 smoke (Requirement #10 & Change #11)
 * Fails ONLY on loose HTTP error rate / broken responses, NEVER on latency.
 */
const BASE_URL = (__ENV.API_BASE || 'http://localhost:8080/api/v1').replace(/\/+$/, '');

export const options = {
  scenarios: {
    ci_smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '10s',
    },
  },
  thresholds: {
    // Change #11: loose error rate only, zero latency thresholds
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const listRes = http.get(`${BASE_URL}/properties`, { tags: { name: 'smoke_properties' } });
  check(listRes, { 'list properties 200': (r) => r.status === 200 });

  const svcRes = http.get(`${BASE_URL}/services`, { tags: { name: 'smoke_services' } });
  check(svcRes, { 'list services 200': (r) => r.status === 200 });

  const searchRes = http.get(`${BASE_URL}/search/properties?limit=10`, { tags: { name: 'smoke_search' } });
  check(searchRes, { 'search 200': (r) => r.status === 200 });

  sleep(0.2);
}

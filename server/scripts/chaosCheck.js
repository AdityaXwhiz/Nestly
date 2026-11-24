import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nestly Chaos Verification Script (Step 13B)
 *
 * Refuses to run unless CHAOS_ENABLED=true and compose project name is nestly-prod (Change #5).
 * Injects 4 realistic faults sequentially against the prod+chaos Compose stack while sending
 * live traffic during each fault (Change #4), verifies Prometheus alerts fire and recover,
 * and always restores stopped services and SQS settings inside finally blocks (Change #5).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const REQUIRED_PROJECT = 'nestly-prod';
const BASE_WEB_URL = (process.env.CHAOS_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const API_BASE = `${BASE_WEB_URL}/api/v1`;
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090').replace(/\/+$/, '');

function resolveEnvFileArgs() {
  const candidates = [
    process.env.ENV_FILE,
    '.env.prod',
    '.env',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.join(ROOT_DIR, candidate);
    if (fs.existsSync(abs)) {
      return ['--env-file', abs];
    }
  }
  return [];
}

const ENV_FILE_ARGS = resolveEnvFileArgs();

function compose(args, { capture = true } = {}) {
  return execFileSync(
    'docker',
    [
      'compose',
      ...ENV_FILE_ARGS,
      '-f',
      'docker-compose.prod.yml',
      '-f',
      'docker-compose.chaos.yml',
      ...args,
    ],
    {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: capture ? 'pipe' : 'inherit',
    },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, { method = 'GET', token, headers = {}, body, expectStatuses = null } = {}) {
  const reqHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
  }
  if (token) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (expectStatuses) {
    if (!expectStatuses.includes(res.status)) {
      throw new Error(`Expected status ${expectStatuses.join('/')} on ${method} ${url}, got ${res.status}: ${text}`);
    }
    return { status: res.status, data: json };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${method} ${url}: ${text}`);
  }
  return { status: res.status, data: json };
}

async function getPrometheusAlerts() {
  const { data } = await fetchJson(`${PROMETHEUS_URL}/api/v1/alerts`);
  return data?.data?.alerts || [];
}

async function waitForAlertState(
  alertName,
  targetMode, // 'firing' | 'inactive'
  { timeoutMs = 90000, pollIntervalMs = 3000, onTick = null, matchLabels = null } = {},
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (onTick) {
      await onTick();
    }

    const alerts = await getPrometheusAlerts();
    const matching = alerts.filter((a) => {
      if (a.labels?.alertname !== alertName) return false;
      if (!matchLabels) return true;
      return Object.entries(matchLabels).every(([k, v]) => a.labels?.[k] === v);
    });

    if (targetMode === 'firing') {
      if (matching.some((a) => a.state === 'firing')) {
        return;
      }
    } else if (targetMode === 'inactive') {
      if (matching.every((a) => a.state !== 'firing' && a.state !== 'pending')) {
        return;
      }
    }

    await sleep(pollIntervalMs);
  }

  const latestAlerts = await getPrometheusAlerts();
  const snapshot = latestAlerts
    .filter((a) => a.labels?.alertname === alertName)
    .map((a) => ({ state: a.state, labels: a.labels }));
  throw new Error(
    `Timed out waiting for alert "${alertName}" -> ${targetMode}. Current matches: ${JSON.stringify(snapshot)}`,
  );
}

async function waitForServiceHealthy(serviceName, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = compose(['ps', '--format', 'json', serviceName]);
      const lines = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (lines.length > 0 && (lines[0].Health === 'healthy' || lines[0].State === 'running')) {
        if (!lines[0].Health || lines[0].Health === 'healthy') {
          return;
        }
      }
    } catch {
      // retry until timeout
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for service "${serviceName}" to become healthy`);
}

function assertGuards() {
  if (process.env.CHAOS_ENABLED !== 'true') {
    console.error('[chaos] REFUSED: Set CHAOS_ENABLED=true explicitly to allow fault injection.');
    process.exit(1);
  }

  const project = process.env.COMPOSE_PROJECT_NAME || REQUIRED_PROJECT;
  if (project !== REQUIRED_PROJECT) {
    console.error(
      `[chaos] REFUSED: COMPOSE_PROJECT_NAME is "${project}", must be local "${REQUIRED_PROJECT}".`,
    );
    process.exit(1);
  }

  const runningOut = compose(['ps', '--services', '--status', 'running']);
  const running = new Set(runningOut.trim().split('\n').filter(Boolean));
  for (const required of ['api', 'worker-scheduler', 'worker-consumer', 'prometheus', 'redis', 'mock-provider']) {
    if (!running.has(required)) {
      console.error(
        `[chaos] REFUSED: Required service "${required}" is not running in ${REQUIRED_PROJECT}.`,
      );
      process.exit(1);
    }
  }
}

async function assertObservabilityPreconditions() {
  // 1. Nginx public origin MUST reject /metrics with 404 (Change #1)
  const metricsRes = await fetch(`${BASE_WEB_URL}/metrics`, { signal: AbortSignal.timeout(5000) });
  if (metricsRes.status !== 404) {
    throw new Error(`Expected ${BASE_WEB_URL}/metrics to return 404, got ${metricsRes.status}`);
  }
  console.log(`[chaos] Precondition OK: ${BASE_WEB_URL}/metrics returns 404`);

  // 2. Prometheus targets must be UP
  const { data: targetsData } = await fetchJson(`${PROMETHEUS_URL}/api/v1/targets`);
  const activeTargets = targetsData?.data?.activeTargets || [];
  const requiredJobs = ['nestly-api', 'nestly-worker-scheduler', 'nestly-worker-consumer'];
  for (const job of requiredJobs) {
    const match = activeTargets.find((t) => t.labels?.job === job);
    if (!match || match.health !== 'up') {
      throw new Error(`Prometheus target "${job}" is not UP (found: ${JSON.stringify(match)})`);
    }
  }
  console.log('[chaos] Precondition OK: All 3 Prometheus scrape targets are UP');

  // 3. Chaos rules overlay must be active (Change #4)
  const { data: rulesData } = await fetchJson(`${PROMETHEUS_URL}/api/v1/rules`);
  const groups = rulesData?.data?.groups || [];
  const hasChaosGroup = groups.some((g) => g.name === 'nestly-chaos-alerts');
  if (!hasChaosGroup) {
    throw new Error(
      'Prometheus is not running with chaos rules overlay (nestly-chaos-alerts missing). Boot stack with -f docker-compose.prod.yml -f docker-compose.chaos.yml',
    );
  }
  console.log('[chaos] Precondition OK: nestly-chaos-alerts rule group loaded');
}

async function registerUser(email, role) {
  const password = `Chaos_${crypto.randomUUID().slice(0, 12)}!`;
  await fetchJson(`${API_BASE}/auth/register`, {
    method: 'POST',
    body: { email, password, role },
  });
  const { data } = await fetchJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    body: { email, password },
  });
  return { token: data.accessToken, user: data.user };
}

async function provisionTestBookingOrders() {
  const runId = crypto.randomUUID().slice(0, 8);
  const host = await registerUser(`chaos-host-${runId}@example.test`, 'HOST');
  const customer = await registerUser(`chaos-cust-${runId}@example.test`, 'CUSTOMER');

  const { data: propRes } = await fetchJson(`${API_BASE}/properties`, {
    method: 'POST',
    token: host.token,
    body: {
      title: `Chaos Villa ${runId}`,
      description: 'Property created by chaos verification script',
      location: 'Goa',
      capacity: 8,
      pricing_minor: 120000,
      currency: 'INR',
      status: 'ACTIVE',
    },
  });
  const propertyId = propRes.property.id;

  // Pre-create 6 disjoint held orders so we can fail multiple POST /payments across scrape ticks
  const heldOrderIds = [];
  const baseMs = Date.now() + 40 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < 6; i += 1) {
    const start = new Date(baseMs + i * 3 * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(baseMs + (i * 3 + 1) * 24 * 60 * 60 * 1000).toISOString();

    const { data: orderRes } = await fetchJson(`${API_BASE}/orders`, {
      method: 'POST',
      token: customer.token,
      body: {
        property_id: propertyId,
        during: { start, end },
        guest_count: 2,
        services: [],
      },
    });
    const orderId = orderRes.id || orderRes.order?.id;

    await fetchJson(`${API_BASE}/orders/${orderId}/hold`, {
      method: 'POST',
      token: customer.token,
      headers: { 'Idempotency-Key': `chaos-hold-${runId}-${i}` },
    });
    heldOrderIds.push(orderId);
  }

  return { customerToken: customer.token, heldOrderIds, runId };
}

function injectPoisonQueueMessage() {
  const script = `
    import { GetQueueAttributesCommand, SetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
    import { sqsClient, QUEUE_DEFINITIONS } from './src/infrastructure/sqs/client.js';
    const def = QUEUE_DEFINITIONS.notifications;
    const dlqAttrs = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: def.dlqUrl,
      AttributeNames: ['QueueArn'],
    }));
    const dlqArn = dlqAttrs.Attributes?.QueueArn;
    await sqsClient.send(new SetQueueAttributesCommand({
      QueueUrl: def.url,
      Attributes: {
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '1',
        }),
      },
    }));
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: def.url,
      MessageBody: '__CHAOS_POISON_NOT_JSON__',
    }));
  `;
  compose(['exec', '-T', 'worker-scheduler', 'node', '--input-type=module', '-e', script]);
}

function cleanupPoisonQueueAndRestore() {
  const script = `
    import { PurgeQueueCommand } from '@aws-sdk/client-sqs';
    import { sqsClient, QUEUE_DEFINITIONS } from './src/infrastructure/sqs/client.js';
    import { setupQueues } from './src/infrastructure/sqs/setupQueues.js';
    const def = QUEUE_DEFINITIONS.notifications;
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.url })).catch(() => {});
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.dlqUrl })).catch(() => {});
    await setupQueues({ maxReceiveCount: 5, visibilityTimeout: 30 });
  `;
  compose(['exec', '-T', 'worker-scheduler', 'node', '--input-type=module', '-e', script]);
}

async function runFault1RedisDegraded() {
  console.log('\n[chaos] === Fault 1: Stop Redis (expect RedisDependencyDown) ===');
  try {
    compose(['stop', 'redis']);
    await waitForAlertState('RedisDependencyDown', 'firing', {
      timeoutMs: 60000,
      pollIntervalMs: 3000,
      onTick: async () => {
        await fetchJson(`${API_BASE}/properties`, { expectStatuses: [200] });
        await fetchJson(`${API_BASE}/search/properties?q=Chaos`, { expectStatuses: [200] });
      },
    });
    console.log('[chaos] PASS: RedisDependencyDown fired while API stayed up serving degraded traffic');
  } finally {
    console.log('[chaos] Restoring redis...');
    compose(['start', 'redis']);
    await waitForServiceHealthy('redis');
  }

  await waitForAlertState('RedisDependencyDown', 'inactive', {
    timeoutMs: 60000,
    pollIntervalMs: 3000,
  });
  console.log('[chaos] PASS: RedisDependencyDown cleared after Redis recovery');
}

async function runFault2ProviderOutage({ customerToken, heldOrderIds, runId }) {
  console.log('\n[chaos] === Fault 2: Stop mock-provider (expect ElevatedHttp5xxRate) ===');
  let orderIndex = 0;

  try {
    compose(['stop', 'mock-provider']);
    await waitForAlertState('ElevatedHttp5xxRate', 'firing', {
      timeoutMs: 75000,
      pollIntervalMs: 6000,
      onTick: async () => {
        if (orderIndex < heldOrderIds.length) {
          const orderId = heldOrderIds[orderIndex];
          orderIndex += 1;
          await fetchJson(`${API_BASE}/payments`, {
            method: 'POST',
            token: customerToken,
            headers: { 'Idempotency-Key': `chaos-pay-${runId}-${orderIndex}` },
            body: { order_id: orderId },
            expectStatuses: [503],
          });
        } else {
          await fetchJson(`${API_BASE}/properties`, { expectStatuses: [200] });
        }
      },
    });
    console.log('[chaos] PASS: ElevatedHttp5xxRate fired during payment provider outage');
  } finally {
    console.log('[chaos] Restoring mock-provider...');
    compose(['start', 'mock-provider']);
    await waitForServiceHealthy('mock-provider');
  }

  // Send healthy traffic so 1m error ratio decays rapidly below threshold and clear alert
  await waitForAlertState('ElevatedHttp5xxRate', 'inactive', {
    timeoutMs: 90000,
    pollIntervalMs: 3000,
    onTick: async () => {
      await fetchJson(`${API_BASE}/properties`, { expectStatuses: [200] });
    },
  });
  console.log('[chaos] PASS: ElevatedHttp5xxRate cleared after mock-provider recovery');
}

async function runFault3PoisonDlq() {
  console.log('\n[chaos] === Fault 3: Poison SQS message -> DLQ (expect SqsDlqNotEmpty) ===');
  try {
    injectPoisonQueueMessage();
    await waitForAlertState('SqsDlqNotEmpty', 'firing', {
      timeoutMs: 90000,
      pollIntervalMs: 3000,
      matchLabels: { queue: 'notifications' },
      onTick: async () => {
        await fetchJson(`${API_BASE}/properties`, { expectStatuses: [200] });
      },
    });
    console.log('[chaos] PASS: SqsDlqNotEmpty fired for notifications DLQ');
  } finally {
    console.log('[chaos] Purging notifications DLQ and restoring queue RedrivePolicy...');
    cleanupPoisonQueueAndRestore();
  }

  await waitForAlertState('SqsDlqNotEmpty', 'inactive', {
    timeoutMs: 60000,
    pollIntervalMs: 3000,
    matchLabels: { queue: 'notifications' },
  });
  console.log('[chaos] PASS: SqsDlqNotEmpty cleared after DLQ purge');
}

async function runFault4WorkerDown() {
  console.log('\n[chaos] === Fault 4: Stop worker-consumer (expect TargetDown) ===');
  try {
    compose(['stop', 'worker-consumer']);
    await waitForAlertState('TargetDown', 'firing', {
      timeoutMs: 60000,
      pollIntervalMs: 3000,
      matchLabels: { job: 'nestly-worker-consumer' },
      onTick: async () => {
        await fetchJson(`${API_BASE}/properties`, { expectStatuses: [200] });
      },
    });
    console.log('[chaos] PASS: TargetDown fired for nestly-worker-consumer');
  } finally {
    console.log('[chaos] Restoring worker-consumer...');
    compose(['start', 'worker-consumer']);
    await waitForServiceHealthy('worker-consumer');
  }

  await waitForAlertState('TargetDown', 'inactive', {
    timeoutMs: 60000,
    pollIntervalMs: 3000,
    matchLabels: { job: 'nestly-worker-consumer' },
  });
  console.log('[chaos] PASS: TargetDown cleared after worker-consumer recovery');
}

async function main() {
  console.log('[chaos] Checking safety guards and preconditions...');
  assertGuards();
  await assertObservabilityPreconditions();

  console.log('[chaos] Provisioning temporary orders for payment failure fault...');
  const ctx = await provisionTestBookingOrders();

  const summary = [];
  const steps = [
    ['Fault 1: Redis Down -> RedisDependencyDown', () => runFault1RedisDegraded()],
    ['Fault 2: Payment Provider Down -> ElevatedHttp5xxRate', () => runFault2ProviderOutage(ctx)],
    ['Fault 3: Poison SQS Message -> SqsDlqNotEmpty', () => runFault3PoisonDlq()],
    ['Fault 4: Consumer Down -> TargetDown', () => runFault4WorkerDown()],
  ];

  for (const [label, fn] of steps) {
    try {
      await fn();
      summary.push({ label, status: 'PASS' });
    } catch (err) {
      summary.push({ label, status: 'FAIL', error: err.message });
      throw err;
    }
  }

  console.log('\n[chaos] === SUMMARY ===');
  for (const row of summary) {
    console.log(`  [${row.status}] ${row.label}`);
  }
}

main().catch((err) => {
  console.error(`\n[chaos] FAILED: ${err.message}`);
  process.exit(1);
});

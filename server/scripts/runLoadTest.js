import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nestly Step 13C Load-Test Orchestrator
 *
 * Enforces safety guards (LOADTEST_ENABLED=true, COMPOSE_PROJECT_NAME=nestly-load),
 * prepares fixtures, runs a warm-up followed by 3 measured k6 runs (via grafana/k6:0.55.0),
 * collects docker stats (including k6 CPU%) and Prometheus server-side window metrics,
 * runs verify:invariants after EVERY run, and writes median + range reports.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT_DIR, 'load-tests/results');
const K6_DIR = path.join(ROOT_DIR, 'load-tests/k6');

const K6_IMAGE = 'grafana/k6:0.55.0';
const PROJECT_NAME = 'nestly-load';
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090').replace(/\/+$/, '');

const SCENARIO_MAP = {
  '01-search-normal': { file: '01-search-normal.js', label: '01 Normal Search & Browse', warmupEnv: { }, scaleDownWarmup: true },
  '02-search-burst': { file: '02-search-burst.js', label: '02 Burst Search Spike', warmupEnv: {}, scaleDownWarmup: true },
  '03-contention': { file: '03-contention.js', label: '03 Same-Resource Contention', warmupEnv: { CONTENTION_ROUNDS: '3' }, scaleDownWarmup: false },
  '04-duplicate-payment': { file: '04-duplicate-payment.js', label: '04 Duplicate Payment Safety', warmupEnv: {}, scaleDownWarmup: false },
  '05-queue-stress': { file: '05-queue-stress.js', label: '05 Queue & Consumer Stress', warmupEnv: { QUEUE_VUS: '4', QUEUE_ITERATIONS: '12' }, scaleDownWarmup: false },
  '06-mixed-journey': { file: '06-mixed-journey.js', label: '06 Mixed Full Journey', warmupEnv: {}, scaleDownWarmup: true },
};

function resolveEnvFileArgs() {
  for (const candidate of [process.env.ENV_FILE, '.env.loadtest', '.env'].filter(Boolean)) {
    const abs = path.isAbsolute(candidate) ? candidate : path.join(ROOT_DIR, candidate);
    if (fs.existsSync(abs)) {
      return ['--env-file', abs];
    }
  }
  return [];
}

const ENV_FILE_ARGS = resolveEnvFileArgs();

function compose(args, { capture = true, envExtra = {} } = {}) {
  return execFileSync(
    'docker',
    [
      'compose',
      ...ENV_FILE_ARGS,
      '-p',
      PROJECT_NAME,
      '-f',
      'docker-compose.prod.yml',
      '-f',
      'docker-compose.loadtest.yml',
      ...args,
    ],
    {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: capture ? 'pipe' : 'inherit',
      env: { ...process.env, ...envExtra },
      maxBuffer: 25 * 1024 * 1024,
    },
  );
}

function assertGuards() {
  if (process.env.LOADTEST_ENABLED !== 'true') {
    console.error('[loadtest] REFUSED: Set LOADTEST_ENABLED=true explicitly.');
    process.exit(1);
  }
  const project = process.env.COMPOSE_PROJECT_NAME || PROJECT_NAME;
  if (project !== PROJECT_NAME) {
    console.error(`[loadtest] REFUSED: COMPOSE_PROJECT_NAME="${project}" !== "${PROJECT_NAME}".`);
    process.exit(1);
  }

  const runningOut = compose(['ps', '--services', '--status', 'running']);
  const running = new Set(runningOut.trim().split('\n').filter(Boolean));
  for (const svc of ['api', 'client', 'worker-scheduler', 'worker-consumer', 'postgres', 'redis', 'mock-provider', 'prometheus']) {
    if (!running.has(svc)) {
      console.error(`[loadtest] REFUSED: Service "${svc}" is not running in ${PROJECT_NAME}.`);
      process.exit(1);
    }
  }
}

function detectNetworkName() {
  const netOut = execFileSync(
    'docker',
    ['network', 'ls', '--filter', `label=com.docker.compose.project=${PROJECT_NAME}`, '--format', '{{.Name}}'],
    { encoding: 'utf8' },
  );
  const nets = netOut.trim().split('\n').filter(Boolean);
  return nets[0] || `${PROJECT_NAME}_default`;
}

function seedFixtures({ skipReindex = false } = {}) {
  const containerTmpPath = '/tmp/nestly-lt-fixtures.json';
  const args = [
    'exec',
    '-T',
    '-e',
    'LOADTEST_ENABLED=true',
    '-e',
    `COMPOSE_PROJECT_NAME=${PROJECT_NAME}`,
    'worker-scheduler',
    'node',
    'scripts/seedLoadTest.js',
    '--out',
    containerTmpPath,
  ];
  if (skipReindex) {
    args.push('--skip-reindex');
  }
  compose(args, { capture: false });
  const jsonText = compose(['exec', '-T', 'worker-scheduler', 'cat', containerTmpPath], { capture: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const fixturesPath = path.join(RESULTS_DIR, 'fixtures.json');
  fs.writeFileSync(fixturesPath, jsonText, 'utf8');
  return JSON.parse(jsonText);
}

function runVerifyInvariants(timeoutMs = 45000) {
  try {
    compose(
      [
        'exec',
        '-T',
        '-e',
        'ENABLE_MOCK_STATS=true',
        'worker-scheduler',
        'node',
        'scripts/verifyInvariants.js',
        '--require-mock-stats',
        '--timeout-ms',
        String(timeoutMs),
      ],
      { capture: false },
    );
    return true;
  } catch {
    return false;
  }
}

function parseCpuPct(val) {
  return Number.parseFloat(String(val || '0').replace('%', '')) || 0;
}

function parseMemMiB(memUsageStr) {
  const part = String(memUsageStr || '').split('/')[0].trim();
  const m = part.match(/^([0-9.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'b') return n / (1024 * 1024);
  if (unit === 'kib' || unit === 'kb') return n / 1024;
  if (unit === 'mib' || unit === 'mb') return n;
  if (unit === 'gib' || unit === 'gb') return n * 1024;
  return n;
}

function startStatsSampler() {
  const samples = [];
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const out = execFileSync(
        'docker',
        ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'],
        { encoding: 'utf8', timeout: 3000 },
      );
      const ts = Date.now();
      for (const line of out.trim().split('\n')) {
        if (!line) continue;
        const [name, cpu, mem] = line.split('\t');
        if (!name) continue;
        if (name.startsWith(`${PROJECT_NAME}-`)) {
          samples.push({ ts, name, cpuPct: parseCpuPct(cpu), memMiB: parseMemMiB(mem) });
        }
      }
    } catch {
      // ignore transient sampling error
    }
  }, 2000);

  return () => {
    stopped = true;
    clearInterval(timer);
    const byContainer = {};
    for (const s of samples) {
      const short = s.name.replace(`${PROJECT_NAME}-`, '');
      if (!byContainer[short]) byContainer[short] = { cpuSamples: [], memSamples: [] };
      byContainer[short].cpuSamples.push(s.cpuPct);
      byContainer[short].memSamples.push(s.memMiB);
    }
    const summary = {};
    for (const [k, v] of Object.entries(byContainer)) {
      summary[k] = {
        avgCpuPct: Number((v.cpuSamples.reduce((a, b) => a + b, 0) / v.cpuSamples.length).toFixed(2)),
        peakCpuPct: Number(Math.max(...v.cpuSamples).toFixed(2)),
        peakMemMiB: Number(Math.max(...v.memSamples).toFixed(1)),
      };
    }
    return summary;
  };
}

async function promInstant(query, timeSec) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}&time=${timeSec}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.result || [];
}

async function promRange(query, startSec, endSec, step = '5s') {
  const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${startSec}&end=${endSec}&step=${step}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.data?.result || [];
}

function firstScalar(results) {
  if (!results || results.length === 0) return null;
  const val = Number.parseFloat(results[0]?.value?.[1]);
  return Number.isFinite(val) ? val : null;
}

function maxRangeValue(results) {
  let max = 0;
  for (const r of results || []) {
    for (const [, v] of r.values || []) {
      const num = Number.parseFloat(v);
      if (Number.isFinite(num) && num > max) max = num;
    }
  }
  return max;
}

async function queryPrometheusWindow(startMs, k6EndMs, fullEndMs) {
  const startSec = Math.floor(startMs / 1000);
  const httpEvalSec = Math.ceil(k6EndMs / 1000) + 5;
  const httpWinSec = Math.max(10, httpEvalSec - startSec);
  const httpWin = `${httpWinSec}s`;
  const activeDurSec = Math.max(1, (k6EndMs - startMs) / 1000);

  const drainEvalSec = Math.max(httpEvalSec, Math.ceil(fullEndMs / 1000) + 2);
  const drainWinSec = Math.max(10, drainEvalSec - startSec);
  const drainWin = `${drainWinSec}s`;

  const [
    srvCountRes,
    srv5xxRes,
    srvP50Res,
    srvP95Res,
    srvP99Res,
    cacheHitRes,
    cacheMissRes,
    dbTotalRange,
    dbActiveRange,
    dbWaitRange,
    outboxRange,
    sqsDepthRange,
    dlqDepthRange,
    consumerRateRes,
  ] = await Promise.all([
    promInstant(`sum(increase(nestly_http_requests_total[${httpWin}]))`, httpEvalSec),
    promInstant(`sum(rate(nestly_http_requests_total{status_class="5xx"}[${httpWin}])) / clamp_min(sum(rate(nestly_http_requests_total[${httpWin}])), 1e-6)`, httpEvalSec),
    promInstant(`histogram_quantile(0.50, sum by (le) (rate(nestly_http_request_duration_seconds_bucket[${httpWin}]))) * 1000`, httpEvalSec),
    promInstant(`histogram_quantile(0.95, sum by (le) (rate(nestly_http_request_duration_seconds_bucket[${httpWin}]))) * 1000`, httpEvalSec),
    promInstant(`histogram_quantile(0.99, sum by (le) (rate(nestly_http_request_duration_seconds_bucket[${httpWin}]))) * 1000`, httpEvalSec),
    promInstant(`sum(increase(nestly_cache_operations_total{outcome="hit"}[${httpWin}]))`, httpEvalSec),
    promInstant(`sum(increase(nestly_cache_operations_total{outcome="miss"}[${httpWin}]))`, httpEvalSec),
    promRange(`sum(nestly_db_pool_connections{state="total"})`, startSec, httpEvalSec),
    promRange(`sum(nestly_db_pool_connections{state="total"} - nestly_db_pool_connections{state="idle"})`, startSec, httpEvalSec),
    promRange(`sum(nestly_db_pool_connections{state="waiting"})`, startSec, httpEvalSec),
    promRange(`max(nestly_outbox_unpublished_count)`, startSec, drainEvalSec),
    promRange(`sum(nestly_sqs_queue_depth)`, startSec, drainEvalSec),
    promRange(`sum(nestly_sqs_dlq_depth)`, startSec, drainEvalSec),
    promInstant(`sum(rate(nestly_worker_messages_received_total[${drainWin}]))`, drainEvalSec),
  ]);

  const hits = firstScalar(cacheHitRes) || 0;
  const misses = firstScalar(cacheMissRes) || 0;
  const cacheHitRatio = hits + misses > 0 ? Number((hits / (hits + misses)).toFixed(4)) : null;
  const totalServerReqs = firstScalar(srvCountRes) || 0;

  return {
    windowSec: httpWinSec,
    serverRps: Number((totalServerReqs / activeDurSec).toFixed(2)),
    serverTotalReqs: Math.round(totalServerReqs),
    server5xxRatio: Number((firstScalar(srv5xxRes) || 0).toFixed(4)),
    serverP50Ms: firstScalar(srvP50Res) !== null ? Number(firstScalar(srvP50Res).toFixed(2)) : null,
    serverP95Ms: firstScalar(srvP95Res) !== null ? Number(firstScalar(srvP95Res).toFixed(2)) : null,
    serverP99Ms: firstScalar(srvP99Res) !== null ? Number(firstScalar(srvP99Res).toFixed(2)) : null,
    cacheHitRatio,
    cacheHits: Math.round(hits),
    cacheMisses: Math.round(misses),
    peakDbTotalConns: Math.round(maxRangeValue(dbTotalRange)),
    peakDbActiveConns: Math.round(maxRangeValue(dbActiveRange)),
    peakDbWaitingConns: Math.round(maxRangeValue(dbWaitRange)),
    peakOutboxUnpublished: Math.round(maxRangeValue(outboxRange)),
    peakSqsQueueDepth: Math.round(maxRangeValue(sqsDepthRange)),
    peakDlqDepth: Math.round(maxRangeValue(dlqDepthRange)),
    consumerThroughputMsgPerSec: Number((firstScalar(consumerRateRes) || 0).toFixed(2)),
  };
}

function runK6Container({ scriptFile, summaryFileName, networkName, extraEnv = {} }) {
  return new Promise((resolve) => {
    const args = [
      'run',
      '--rm',
      '--name',
      `${PROJECT_NAME}-k6`,
      '--cpus=2.0',
      '--network',
      networkName,
      '-v',
      `${K6_DIR}:/scripts:ro`,
      '-v',
      `${RESULTS_DIR}:/results`,
      '-e',
      'API_BASE=http://client:8080/api/v1',
      '-e',
      'MOCK_PROVIDER_URL=http://mock-provider:3001',
      '-e',
      'FIXTURES_PATH=/results/fixtures.json',
    ];
    for (const [k, v] of Object.entries(extraEnv)) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(
      K6_IMAGE,
      'run',
      '--summary-trend-stats=avg,min,med,max,p(90),p(95),p(99)',
      `/scripts/${scriptFile}`,
      '--summary-export',
      `/results/${summaryFileName}`,
    );

    const proc = spawn('docker', args, { stdio: 'inherit' });
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

function parseK6Summary(summaryPath) {
  if (!fs.existsSync(summaryPath)) return null;
  const raw = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const m = raw.metrics || {};
  const reqs = m.http_reqs?.values || m.http_reqs || {};
  const dur = m.http_req_duration?.values || m.http_req_duration || {};
  const fail = m.http_req_failed?.values || m.http_req_failed || {};
  const dropped = m.dropped_iterations?.values || m.dropped_iterations || {};
  const s5xx = m.server_5xx_rate?.values || m.server_5xx_rate || {};

  return {
    rps: Number((reqs.rate || 0).toFixed(2)),
    totalRequests: reqs.count || 0,
    p50Ms: Number((dur.med || 0).toFixed(2)),
    p95Ms: Number((dur['p(95)'] || 0).toFixed(2)),
    p99Ms: Number((dur['p(99)'] || 0).toFixed(2)),
    errorRate: Number((fail.rate || 0).toFixed(4)),
    server5xxRate: s5xx.rate !== undefined ? Number(s5xx.rate.toFixed(4)) : null,
    droppedIterations: dropped.count || 0,
    customCounters: {
      holdWinners: m.hold_winners?.values?.count ?? m.hold_winners?.count ?? null,
      holdConflicts: m.hold_conflicts?.values?.count ?? m.hold_conflicts?.count ?? null,
      confirmedWinners: m.confirmed_winners?.values?.count ?? m.confirmed_winners?.count ?? null,
      dupPaidConfirmed: m.dup_paid_orders_confirmed?.values?.count ?? m.dup_paid_orders_confirmed?.count ?? null,
      queueConfirmed: m.queue_bookings_confirmed?.values?.count ?? m.queue_bookings_confirmed?.count ?? null,
      mixedConfirmed: m.mixed_journeys_confirmed?.values?.count ?? m.mixed_journeys_confirmed?.count ?? null,
    },
  };
}

function medianAndRange(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return {
    median: Number(median.toFixed(2)),
    min: nums[0],
    max: nums[nums.length - 1],
  };
}

async function waitForQueueDrain(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = compose(
        [
          'exec',
          '-T',
          'worker-scheduler',
          'node',
          '--input-type=module',
          '-e',
          `import { pool } from './src/infrastructure/postgres.js';
           const r = await pool.query("SELECT COUNT(*)::int AS cnt FROM outbox WHERE published_at IS NULL");
           console.log(r.rows[0].cnt);
           await pool.end();`,
        ],
        { capture: true },
      ).trim();
      if (Number(out) === 0) {
        return true;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function runScenario(key, { runs = 3, doWarmup = true, tag = '' } = {}) {
  const spec = SCENARIO_MAP[key];
  if (!spec) {
    throw new Error(`Unknown scenario "${key}". Valid: ${Object.keys(SCENARIO_MAP).join(', ')}`);
  }

  const networkName = detectNetworkName();
  const suffix = tag ? `-${tag}` : '';
  console.log(`\n=======================================================`);
  console.log(`[loadtest] Scenario: ${spec.label} (${runs} measured runs${tag ? `, tag=${tag}` : ''})`);
  console.log(`=======================================================`);

  if (doWarmup) {
    console.log('[loadtest] Running warm-up pass...');
    seedFixtures({ skipReindex: true });
    await runK6Container({
      scriptFile: spec.file,
      summaryFileName: `${key}${suffix}-warmup.json`,
      networkName,
      extraEnv: spec.warmupEnv,
    });
    await waitForQueueDrain(20000);
  }

  const runRecords = [];
  for (let i = 1; i <= runs; i += 1) {
    console.log(`\n[loadtest] --- Run ${i}/${runs} for ${key}${suffix} ---`);
    seedFixtures({ skipReindex: true });

    const stopSampler = startStatsSampler();
    const startMs = Date.now();
    const exitCode = await runK6Container({
      scriptFile: spec.file,
      summaryFileName: `${key}${suffix}-run${i}.json`,
      networkName,
    });
    const endMs = Date.now();
    const containerStats = stopSampler();

    const drainStart = Date.now();
    await waitForQueueDrain(30000);
    const drainEndMs = Date.now();
    const drainDurationMs = drainEndMs - drainStart;
    const invariantsPassed = runVerifyInvariants(45000);

    // Give Prometheus one final scrape cycle so metrics cover the tail cleanly
    await new Promise((r) => setTimeout(r, 5500));
    const promMetrics = await queryPrometheusWindow(startMs, endMs, Date.now());
    const k6Summary = parseK6Summary(path.join(RESULTS_DIR, `${key}${suffix}-run${i}.json`));

    const runPassed = exitCode === 0 && invariantsPassed;
    console.log(
      `[loadtest] Run ${i} result: k6Exit=${exitCode}, invariants=${invariantsPassed ? 'PASS' : 'FAIL'} -> ${runPassed ? 'PASS' : 'FAIL'}`,
    );

    runRecords.push({
      run: i,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      durationMs: endMs - startMs,
      drainDurationMs,
      k6ExitCode: exitCode,
      invariantsPassed,
      passed: runPassed,
      k6: k6Summary,
      prometheus: promMetrics,
      containerStats,
    });
  }

  const allContainerKeys = new Set();
  for (const r of runRecords) {
    for (const k of Object.keys(r.containerStats || {})) {
      allContainerKeys.add(k);
    }
  }
  const containersAgg = {};
  for (const k of [...allContainerKeys].sort()) {
    containersAgg[k] = {
      avgCpuPct: medianAndRange(runRecords.map((r) => r.containerStats?.[k]?.avgCpuPct)),
      peakCpuPct: medianAndRange(runRecords.map((r) => r.containerStats?.[k]?.peakCpuPct)),
      peakMemMiB: medianAndRange(runRecords.map((r) => r.containerStats?.[k]?.peakMemMiB)),
    };
  }

  const aggregate = {
    scenario: key,
    label: spec.label,
    tag: tag || 'default',
    allPassed: runRecords.every((r) => r.passed),
    stats: {
      clientRps: medianAndRange(runRecords.map((r) => r.k6?.rps)),
      clientP50Ms: medianAndRange(runRecords.map((r) => r.k6?.p50Ms)),
      clientP95Ms: medianAndRange(runRecords.map((r) => r.k6?.p95Ms)),
      clientP99Ms: medianAndRange(runRecords.map((r) => r.k6?.p99Ms)),
      clientErrorRate: medianAndRange(runRecords.map((r) => r.k6?.errorRate)),
      droppedIterations: medianAndRange(runRecords.map((r) => r.k6?.droppedIterations)),
      serverRps: medianAndRange(runRecords.map((r) => r.prometheus?.serverRps)),
      serverP50Ms: medianAndRange(runRecords.map((r) => r.prometheus?.serverP50Ms)),
      serverP95Ms: medianAndRange(runRecords.map((r) => r.prometheus?.serverP95Ms)),
      serverP99Ms: medianAndRange(runRecords.map((r) => r.prometheus?.serverP99Ms)),
      cacheHitRatio: medianAndRange(runRecords.map((r) => r.prometheus?.cacheHitRatio)),
      peakDbTotalConns: medianAndRange(runRecords.map((r) => r.prometheus?.peakDbTotalConns)),
      peakDbActiveConns: medianAndRange(runRecords.map((r) => r.prometheus?.peakDbActiveConns)),
      peakDbWaitingConns: medianAndRange(runRecords.map((r) => r.prometheus?.peakDbWaitingConns)),
      peakOutboxUnpublished: medianAndRange(runRecords.map((r) => r.prometheus?.peakOutboxUnpublished)),
      peakSqsQueueDepth: medianAndRange(runRecords.map((r) => r.prometheus?.peakSqsQueueDepth)),
      peakDlqDepth: medianAndRange(runRecords.map((r) => r.prometheus?.peakDlqDepth)),
      drainDurationMs: medianAndRange(runRecords.map((r) => r.drainDurationMs)),
      consumerThroughputMsgPerSec: medianAndRange(runRecords.map((r) => r.prometheus?.consumerThroughputMsgPerSec)),
      containers: containersAgg,
    },
    runs: runRecords,
  };

  const outFile = path.join(RESULTS_DIR, `${key}${suffix}-aggregate.json`);
  fs.writeFileSync(outFile, JSON.stringify(aggregate, null, 2), 'utf8');
  console.log(`[loadtest] Wrote aggregate summary to ${path.relative(ROOT_DIR, outFile)}`);
  return aggregate;
}

async function main() {
  assertGuards();

  const args = process.argv.slice(2);
  const runsIdx = args.indexOf('--runs');
  const runs = runsIdx !== -1 ? Number(args[runsIdx + 1]) : 3;
  const tagIdx = args.indexOf('--tag');
  const tag = tagIdx !== -1 ? args[tagIdx + 1] : '';
  const doWarmup = !args.includes('--no-warmup');
  const doSeedFull = !args.includes('--no-seed');

  const positional = args.filter((a, idx) => {
    if (a.startsWith('--')) return false;
    if (runsIdx !== -1 && idx === runsIdx + 1) return false;
    if (tagIdx !== -1 && idx === tagIdx + 1) return false;
    return true;
  });

  const target = positional[0] || 'all';
  const keys = target === 'all' ? Object.keys(SCENARIO_MAP) : [target];

  if (doSeedFull) {
    console.log('[loadtest] Preparing HLD load-test catalog (5,000 properties, 20,000 services) + OpenSearch reindex...');
    seedFixtures({ skipReindex: false });
  }

  const results = [];
  for (const k of keys) {
    const agg = await runScenario(k, { runs, doWarmup, tag });
    results.push(agg);
  }

  console.log('\n=== LOAD TEST SUMMARY ===');
  let anyFailed = false;
  for (const r of results) {
    if (!r.allPassed) anyFailed = true;
    console.log(
      `  [${r.allPassed ? 'PASS' : 'FAIL'}] ${r.label} | clientP95 median=${r.stats.clientP95Ms?.median}ms, rps median=${r.stats.clientRps?.median}, err=${r.stats.clientErrorRate?.median}`,
    );
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(`[loadtest] ERROR: ${err.message}`);
  process.exit(1);
});

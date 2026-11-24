import crypto from 'node:crypto';

/**
 * Nestly End-to-End Smoke Test (Step 13A)
 *
 * Uses ONLY Node built-in fetch (zero dependencies).
 * Creates its own fresh test data directly through the API (host, property,
 * provider, service, customer) without using seed:demo or search (Change #2).
 *
 * Usage:
 *   SMOKE_BASE_URL=http://localhost:8080 npm run smoke
 *   node server/scripts/smoke.js http://localhost:8080
 */

const rawBaseUrl = process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:8080';
const cleanBase = rawBaseUrl.replace(/\/+$/, '');
const apiBase = cleanBase.endsWith('/api/v1') ? cleanBase : `${cleanBase}/api/v1`;
const webOrigin = cleanBase.endsWith('/api/v1') ? cleanBase.replace(/\/api\/v1$/, '') : cleanBase;

const runId = crypto.randomUUID().slice(0, 8);
const PASSWORD = `Smoke_${crypto.randomUUID().slice(0, 12)}!`;

async function requestJson(url, { method = 'GET', token, headers = {}, body } = {}) {
  const reqHeaders = {
    'Accept': 'application/json',
    ...headers,
  };
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
  }
  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} on ${method} ${url}: ${JSON.stringify(json)}`,
    );
  }
  return { status: res.status, data: json };
}

async function registerAndLogin({ email, role }) {
  await requestJson(`${apiBase}/auth/register`, {
    method: 'POST',
    body: { email, password: PASSWORD, role },
  });

  const { data } = await requestJson(`${apiBase}/auth/login`, {
    method: 'POST',
    body: { email, password: PASSWORD },
  });

  if (!data.accessToken) {
    throw new Error(`Missing accessToken in login response for ${email}`);
  }
  return { email, token: data.accessToken, user: data.user };
}

async function checkEdgeReachable() {
  // Check client SPA root OR API healthz depending on target URL
  const rootRes = await fetch(`${webOrigin}/`, { signal: AbortSignal.timeout(5000) });
  const contentType = rootRes.headers.get('content-type') || '';

  if (rootRes.ok && contentType.includes('text/html')) {
    console.log(`[smoke] ✅ Client SPA reachable at ${webOrigin}/`);
    const cfgRes = await fetch(`${webOrigin}/config.js`, { signal: AbortSignal.timeout(5000) });
    if (!cfgRes.ok) {
      throw new Error(`Runtime /config.js returned HTTP ${cfgRes.status}`);
    }
    const cfgText = await cfgRes.text();
    console.log(`[smoke] ✅ Runtime /config.js loaded (${cfgText.trim()})`);
    return;
  }

  const healthRes = await fetch(`${webOrigin}/healthz`, { signal: AbortSignal.timeout(5000) });
  if (!healthRes.ok) {
    throw new Error(`Target ${webOrigin} did not return SPA HTML or /healthz 200`);
  }
  console.log(`[smoke] ✅ API healthcheck reachable at ${webOrigin}/healthz`);
}

async function runSmoke() {
  const startedAt = Date.now();
  console.log(`[smoke] Starting smoke test (runId=${runId}) against API=${apiBase}`);

  // 1. Check client / API health
  await checkEdgeReachable();

  // 2. Host creates property
  const host = await registerAndLogin({
    email: `smoke-host-${runId}@example.test`,
    role: 'HOST',
  });
  const propRes = await requestJson(`${apiBase}/properties`, {
    method: 'POST',
    token: host.token,
    body: {
      title: `Smoke Courtyard ${runId}`,
      description: 'End-to-end containerized smoke test venue',
      location: 'Mumbai',
      capacity: 25,
      pricing_minor: 500000,
      currency: 'INR',
      status: 'ACTIVE',
      amenities: ['WiFi', 'Parking'],
    },
  });
  const propertyId = propRes.data.property?.id;
  if (!propertyId) throw new Error('Failed to get created property ID');
  console.log(`[smoke] ✅ Host created property ${propertyId}`);

  // 3. Provider creates profile + service
  const provider = await registerAndLogin({
    email: `smoke-provider-${runId}@example.test`,
    role: 'PROVIDER',
  });
  await requestJson(`${apiBase}/providers`, {
    method: 'POST',
    token: provider.token,
    body: {
      business_name: `Smoke Vendor ${runId}`,
      bio: 'Automated smoke test vendor profile',
    },
  });
  const svcRes = await requestJson(`${apiBase}/services`, {
    method: 'POST',
    token: provider.token,
    body: {
      title: `Smoke Catering ${runId}`,
      description: 'Full event dining package for smoke test verification',
      category: 'catering',
      kind: 'exclusive',
      price_minor: 150000,
      currency: 'INR',
      status: 'ACTIVE',
    },
  });
  const serviceId = svcRes.data.service?.id;
  if (!serviceId) throw new Error('Failed to get created service ID');
  console.log(`[smoke] ✅ Provider created service ${serviceId}`);

  // 4. Customer creates order -> holds -> pays -> polls until CONFIRMED
  const customer = await registerAndLogin({
    email: `smoke-customer-${runId}@example.test`,
    role: 'CUSTOMER',
  });

  // Deterministic future booking window (tomorrow + 2 days)
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  const orderRes = await requestJson(`${apiBase}/orders`, {
    method: 'POST',
    token: customer.token,
    body: {
      property_id: propertyId,
      during: { start, end },
      guest_count: 5,
      services: [{ service_id: serviceId, quantity: 1 }],
    },
  });
  const orderId = orderRes.data.id || orderRes.data.order?.id;
  const totalAmount = orderRes.data.total_amount_minor;
  if (!orderId || !totalAmount) {
    throw new Error(`Unexpected create order response: ${JSON.stringify(orderRes.data)}`);
  }
  console.log(`[smoke] ✅ Customer created order ${orderId} (total_amount_minor=${totalAmount})`);

  // 5. Hold order
  const holdRes = await requestJson(`${apiBase}/orders/${orderId}/hold`, {
    method: 'POST',
    token: customer.token,
  });
  if (holdRes.data.status !== 'HELD' || !holdRes.data.hold_expires_at || !holdRes.data.server_time) {
    throw new Error(`Unexpected hold response: ${JSON.stringify(holdRes.data)}`);
  }
  console.log(`[smoke] ✅ Order ${orderId} held until ${holdRes.data.hold_expires_at}`);

  // 6. Initiate payment with Idempotency-Key
  const idempotencyKey = crypto.randomUUID();
  const payRes = await requestJson(`${apiBase}/payments`, {
    method: 'POST',
    token: customer.token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { order_id: orderId },
  });
  console.log(`[smoke] ✅ Payment initiated (HTTP ${payRes.status}, idempotencyKey=${idempotencyKey})`);

  // 7. Poll GET /orders/:id until CONFIRMED
  const deadline = Date.now() + 30000;
  let finalOrder = null;
  while (Date.now() < deadline) {
    const check = await requestJson(`${apiBase}/orders/${orderId}`, {
      token: customer.token,
    });
    const order = check.data.order || check.data;
    if (order.status === 'CONFIRMED') {
      finalOrder = order;
      break;
    }
    if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
      throw new Error(`Order entered terminal non-confirmed state: ${order.status}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!finalOrder) {
    throw new Error(`Timed out after 30s waiting for order ${orderId} to become CONFIRMED`);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[smoke] 🎉 Order ${orderId} reached CONFIRMED (payment=${finalOrder.payment?.status}) in ${elapsedMs}ms`,
  );
}

runSmoke()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[smoke] ❌ Smoke test failed: ${err.message}`);
    process.exit(1);
  });

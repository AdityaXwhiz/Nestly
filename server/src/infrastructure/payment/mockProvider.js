import express from 'express';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';

const app = express();
app.use(express.json());

const PORT = process.env.PAYMENT_MOCK_PORT || 3001;
const WEBHOOK_URL = process.env.WEBHOOK_TARGET_URL || 'http://localhost:3000/api/v1/payments/webhook';
const SECRET = env.PAYMENT_WEBHOOK_SECRET;

const charges = new Map();
const refunds = new Map();

function sendSignedWebhook(payload) {
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signaturePayload = `${timestamp}.${rawBody}`;
  const signature = crypto.createHmac('sha256', SECRET).update(signaturePayload).digest('hex');

  return fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': String(timestamp),
      'X-Signature': `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  }).catch((err) => {
    console.error('Mock provider webhook delivery error:', err.message);
  });
}

// POST /charges
app.post('/charges', async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header required' });
  }

  if (charges.has(idempotencyKey)) {
    return res.status(200).json(charges.get(idempotencyKey));
  }

  const { amount_minor, currency, reference, metadata = {} } = req.body;

  // Failure scenario: timeout (never answers)
  if (metadata.scenario === 'timeout') {
    // Keep connection hanging
    return;
  }

  // Failure scenario: immediate fail
  if (metadata.scenario === 'fail') {
    return res.status(400).json({
      code: 'CARD_DECLINED',
      message: 'Card was declined by issuing bank',
    });
  }

  const chargeReference = reference || `ch_${crypto.randomUUID()}`;
  const charge = {
    reference: chargeReference,
    amount_minor,
    currency,
    status: 'PROCESSING',
    idempotency_key: idempotencyKey,
    metadata,
    created_at: new Date().toISOString(),
  };

  charges.set(idempotencyKey, charge);
  charges.set(chargeReference, charge);

  // Respond immediately with 200/202
  res.status(200).json(charge);

  // Trigger webhook asynchronously
  const webhookEvent = {
    event_id: `evt_${crypto.randomUUID()}`,
    type: 'payment.succeeded',
    data: {
      reference: chargeReference,
      status: 'SUCCESS',
      amount_minor,
      currency,
    },
  };

  const delayMs = metadata.scenario === 'delayed' ? 2000 : 50;

  setTimeout(async () => {
    if (metadata.scenario === 'duplicate_webhook') {
      await sendSignedWebhook(webhookEvent);
      await sendSignedWebhook(webhookEvent);
    } else {
      await sendSignedWebhook(webhookEvent);
    }
  }, delayMs);
});

// GET /charges/:reference
app.get('/charges/:reference', (req, res) => {
  const charge = charges.get(req.params.reference);
  if (!charge) {
    return res.status(404).json({ message: 'Charge not found' });
  }
  res.status(200).json(charge);
});

// POST /refunds
app.post('/refunds', (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ message: 'Idempotency-Key required' });
  }

  if (refunds.has(idempotencyKey)) {
    return res.status(200).json(refunds.get(idempotencyKey));
  }

  const { charge_reference, amount_minor } = req.body;
  const refund = {
    refund_reference: `ref_${crypto.randomUUID()}`,
    charge_reference,
    amount_minor,
    status: 'REFUNDED',
    created_at: new Date().toISOString(),
  };

  refunds.set(idempotencyKey, refund);
  res.status(200).json(refund);
});

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Nestly Mock Payment Provider listening on port ${PORT}`);
  });

  const stop = () => {
    console.log('Shutting down Mock Payment Provider...');
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

export default app;

import { env } from '../../config/env.js';
import { FakePaymentProvider } from './fakeProvider.js';

class HttpPaymentProvider {
  constructor(baseUrl, secret) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.secret = secret;
  }

  async createCharge({ amount_minor, currency, idempotencyKey, reference, metadata = {} }) {
    const res = await fetch(`${this.baseUrl}/charges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        amount_minor,
        currency,
        reference,
        metadata,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const err = new Error(errBody.message || 'Payment provider charge failed');
      err.statusCode = res.status;
      err.code = errBody.code || 'PROVIDER_ERROR';
      throw err;
    }

    return res.json();
  }

  async getCharge(reference) {
    const res = await fetch(`${this.baseUrl}/charges/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const err = new Error('Payment provider getCharge failed');
      err.statusCode = res.status;
      throw err;
    }

    return res.json();
  }

  async refund({ chargeRef, amount_minor, idempotencyKey }) {
    const res = await fetch(`${this.baseUrl}/refunds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        charge_reference: chargeRef,
        amount_minor,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const err = new Error(errBody.message || 'Payment provider refund failed');
      err.statusCode = res.status;
      throw err;
    }

    return res.json();
  }

  verifyWebhook(rawBody, headers) {
    const fake = new FakePaymentProvider();
    return fake.verifyWebhook(rawBody, headers, this.secret);
  }
}

// Default instance: use FakePaymentProvider in test or when PAYMENT_PROVIDER_USE_FAKE is set,
// otherwise use HttpPaymentProvider pointing to local mock
let activeProvider =
  process.env.NODE_ENV === 'test'
    ? new FakePaymentProvider()
    : new HttpPaymentProvider(env.PAYMENT_PROVIDER_URL, env.PAYMENT_WEBHOOK_SECRET);

export const paymentProvider = {
  createCharge(params) {
    return activeProvider.createCharge(params);
  },
  getCharge(reference) {
    return activeProvider.getCharge(reference);
  },
  refund(params) {
    return activeProvider.refund(params);
  },
  verifyWebhook(rawBody, headers) {
    return activeProvider.verifyWebhook(rawBody, headers);
  },
  setProvider(provider) {
    if (env.NODE_ENV === 'production') {
      throw new Error('setProvider test hook is disabled in production');
    }
    activeProvider = provider;
  },
  getProvider() {
    return activeProvider;
  },
};

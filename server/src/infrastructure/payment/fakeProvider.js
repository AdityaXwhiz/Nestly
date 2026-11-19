import crypto from 'node:crypto';
import { env } from '../../config/env.js';

export class FakePaymentProvider {
  constructor() {
    this.charges = new Map(); // idempotencyKey -> charge
    this.chargesByRef = new Map(); // reference -> charge
    this.refunds = new Map(); // idempotencyKey -> refund
    this.webhookEvents = [];
    this.shouldThrowOnRefund = false;
  }

  reset() {
    this.charges.clear();
    this.chargesByRef.clear();
    this.refunds.clear();
    this.webhookEvents = [];
    this.shouldThrowOnRefund = false;
  }

  async createCharge({ amount_minor, currency, idempotencyKey, reference, metadata = {} }) {
    if (this.charges.has(idempotencyKey)) {
      return this.charges.get(idempotencyKey);
    }

    if (metadata.scenario === 'timeout') {
      const err = new Error('Provider connection timeout');
      err.code = 'ETIMEDOUT';
      throw err;
    }

    if (metadata.scenario === 'error') {
      throw new Error('Provider internal server error');
    }

    const providerRef = reference || `ch_${crypto.randomUUID()}`;
    const status = metadata.scenario === 'fail' ? 'FAILED' : 'SUCCESS';

    const charge = {
      reference: providerRef,
      amount_minor,
      currency,
      status, // 'SUCCESS' | 'FAILED' | 'PENDING'
      idempotency_key: idempotencyKey,
      metadata,
      created_at: new Date().toISOString(),
    };

    this.charges.set(idempotencyKey, charge);
    this.chargesByRef.set(providerRef, charge);

    return charge;
  }

  async getCharge(reference) {
    const charge = this.chargesByRef.get(reference);
    if (!charge) {
      const err = new Error('Charge not found');
      err.statusCode = 404;
      throw err;
    }
    return charge;
  }

  async refund({ chargeRef, amount_minor, idempotencyKey }) {
    if (this.shouldThrowOnRefund) {
      throw new Error('Provider refund gateway unavailable');
    }

    if (this.refunds.has(idempotencyKey)) {
      return this.refunds.get(idempotencyKey);
    }

    const charge = this.chargesByRef.get(chargeRef);
    if (!charge) {
      const err = new Error('Original charge not found');
      err.statusCode = 404;
      throw err;
    }

    const refund = {
      refund_reference: `ref_${crypto.randomUUID()}`,
      charge_reference: chargeRef,
      amount_minor: amount_minor || charge.amount_minor,
      idempotency_key: idempotencyKey,
      status: 'REFUNDED',
      created_at: new Date().toISOString(),
    };

    this.refunds.set(idempotencyKey, refund);
    charge.status = 'REFUNDED';
    return refund;
  }

  /**
   * Helper to construct and sign a webhook payload.
   */
  signWebhookPayload(bodyObj, { secret = env.PAYMENT_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
    const rawBody = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    const signaturePayload = `${timestamp}.${rawBody}`;
    const signature = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');
    return {
      rawBody,
      timestamp,
      signature,
      signatureHeader: `t=${timestamp},v1=${signature}`
    };
  }

  /**
   * Verify signed webhook payload.
   */
  verifyWebhook(rawBody, headers, secret = env.PAYMENT_WEBHOOK_SECRET) {
    const signatureHeader = headers['x-signature'] || headers['x-payment-signature'] || '';
    const timestampHeader = headers['x-timestamp'] || '';

    let timestamp;
    let signature;

    if (signatureHeader.includes('t=') && signatureHeader.includes('v1=')) {
      const parts = signatureHeader.split(',');
      const tPart = parts.find((p) => p.startsWith('t='));
      const v1Part = parts.find((p) => p.startsWith('v1='));
      timestamp = tPart ? tPart.slice(2) : null;
      signature = v1Part ? v1Part.slice(3) : null;
    } else {
      timestamp = timestampHeader;
      signature = signatureHeader;
    }

    if (!timestamp || !signature) {
      return { valid: false, reason: 'MISSING_SIGNATURE_OR_TIMESTAMP' };
    }

    const tsNumber = Number(timestamp);
    if (Number.isNaN(tsNumber)) {
      return { valid: false, reason: 'INVALID_TIMESTAMP' };
    }

    // Reject events older than 5 minutes (300 seconds)
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNumber) > 300) {
      return { valid: false, reason: 'STALE_TIMESTAMP' };
    }

    const expectedPayload = `${timestamp}.${rawBody}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(expectedPayload).digest('hex');

    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { valid: false, reason: 'INVALID_SIGNATURE' };
      }
    } catch {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    return { valid: true, timestamp: tsNumber };
  }
}

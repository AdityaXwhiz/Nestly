import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreatePaymentIdempotencyKey } from '../src/pages/BookStepper/BookingState.js';

describe('Payment Idempotency-Key Persistence', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('generates an idempotency key once per order and persists in sessionStorage', () => {
    const orderId1 = 'order-aaa-111';
    const key1 = getOrCreatePaymentIdempotencyKey(orderId1);
    expect(key1).toBeTruthy();

    // Calling again returns the exact same key
    const key2 = getOrCreatePaymentIdempotencyKey(orderId1);
    expect(key2).toBe(key1);

    // Verify key was saved in sessionStorage
    expect(window.sessionStorage.getItem(`nestly_pay_idem_${orderId1}`)).toBe(key1);
  });

  it('generates distinct keys for distinct orders', () => {
    const keyA = getOrCreatePaymentIdempotencyKey('order-1');
    const keyB = getOrCreatePaymentIdempotencyKey('order-2');
    expect(keyA).not.toBe(keyB);
  });
});

/**
 * Pure functions for booking state machine and order payload hashing.
 * Enables deterministic testing of step transitions, input caching, and validations.
 */

/**
 * Creates initial state for booking flow.
 */
export function createInitialBookingState({ propertyId, from = '', to = '', guests = 1 }) {
  return {
    step: 1, // 1: Details, 2: Services, 3: Review, 4: Hold & Pay
    propertyId,
    startDate: from,
    endDate: to,
    guestCount: Math.max(1, parseInt(guests, 10) || 1),
    selectedServices: [], // Array of { serviceId, title, kind, quantity, slot, price_minor }
    order: null, // Server order object from POST /api/v1/orders
    lastOrderPayloadHash: null,
    holdData: null, // { order_id, status, hold_expires_at, server_time }
    isHolding: false,
    isPaying: false,
    errorMessage: null,
    fieldErrors: [],
  };
}

/**
 * Validates step 1 (Details).
 */
export function validateBookingDetails({ startDate, endDate, guestCount, propertyCapacity }) {
  const errors = [];
  if (!startDate) errors.push('Start date is required.');
  if (!endDate) errors.push('End date is required.');
  if (startDate && endDate && startDate > endDate) {
    errors.push('Start date must be on or before end date.');
  }

  // Max 90 days window check
  if (startDate && endDate && startDate <= endDate) {
    const s = new Date(startDate);
    const e = new Date(endDate);
    const diffDays = Math.ceil((e - s) / (1000 * 60 * 60 * 24));
    if (diffDays > 90) {
      errors.push('Booking window cannot exceed 90 days.');
    }
  }

  if (!guestCount || guestCount < 1) {
    errors.push('Guest count must be at least 1.');
  }
  if (propertyCapacity && guestCount > propertyCapacity) {
    errors.push(`Guest count cannot exceed property capacity of ${propertyCapacity}.`);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validates selected services for Step 2.
 * Capacity services must have a valid slot in YYYY-MM-DD and fall in [startDate, endDate] (Change #4).
 */
export function validateBookingServices({ selectedServices, startDate, endDate }) {
  const errors = [];
  for (const s of selectedServices) {
    if (s.kind === 'capacity') {
      if (!s.slot) {
        errors.push(`Please select a date slot for ${s.title}.`);
      } else if (startDate && endDate && (s.slot < startDate || s.slot > endDate)) {
        errors.push(`Selected slot for ${s.title} (${s.slot}) must be between ${startDate} and ${endDate}.`);
      }
    }
    if (!s.quantity || s.quantity < 1) {
      errors.push(`Quantity for ${s.title} must be at least 1.`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Computes deterministic hash / string representation of order payload inputs.
 * Used to avoid recreating order if user steps back to Review with unchanged inputs (Change #10).
 */
export function computeOrderPayloadHash({ propertyId, startDate, endDate, guestCount, selectedServices }) {
  const normalizedServices = [...selectedServices]
    .map((s) => ({
      service_id: s.serviceId,
      quantity: Number(s.quantity),
      slot: s.slot || null,
    }))
    .sort((a, b) => a.service_id.localeCompare(b.service_id));

  return JSON.stringify({
    propertyId,
    startDate,
    endDate,
    guestCount: Number(guestCount),
    services: normalizedServices,
  });
}

/**
 * Determines whether existing order can be reused or must be created afresh (Change #10).
 */
export function shouldReuseOrder(state) {
  if (!state.order) return false;
  const currentHash = computeOrderPayloadHash({
    propertyId: state.propertyId,
    startDate: state.startDate,
    endDate: state.endDate,
    guestCount: state.guestCount,
    selectedServices: state.selectedServices,
  });
  return state.lastOrderPayloadHash === currentHash;
}

/**
 * Generates or retrieves existing Idempotency-Key from sessionStorage for an order payment attempt.
 */
export function getOrCreatePaymentIdempotencyKey(orderId, storage = window.sessionStorage) {
  if (!orderId) return null;
  const storageKey = `nestly_pay_idem_${orderId}`;
  let key = storage?.getItem?.(storageKey);
  if (!key) {
    key = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `idem-${Date.now()}-${Math.random()}`;
    try {
      storage?.setItem?.(storageKey, key);
    } catch {
      // storage unavailable / quota exceeded
    }
  }
  return key;
}

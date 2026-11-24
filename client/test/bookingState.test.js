import { describe, it, expect } from 'vitest';
import {
  createInitialBookingState,
  validateBookingDetails,
  validateBookingServices,
  computeOrderPayloadHash,
  shouldReuseOrder,
} from '../src/pages/BookStepper/BookingState.js';

describe('Booking State Machine & Validation', () => {
  it('creates initial booking state with defaults and parsed dates', () => {
    const state = createInitialBookingState({
      propertyId: 'prop-123',
      from: '2026-12-01',
      to: '2026-12-05',
      guests: 3,
    });

    expect(state.step).toBe(1);
    expect(state.propertyId).toBe('prop-123');
    expect(state.startDate).toBe('2026-12-01');
    expect(state.endDate).toBe('2026-12-05');
    expect(state.guestCount).toBe(3);
    expect(state.selectedServices).toEqual([]);
    expect(state.order).toBeNull();
  });

  it('validates booking details (Step 1): enforces dates, 90-day window, and capacity', () => {
    // Missing dates
    expect(
      validateBookingDetails({ startDate: '', endDate: '', guestCount: 2, propertyCapacity: 4 }).isValid
    ).toBe(false);

    // End date before start date
    expect(
      validateBookingDetails({
        startDate: '2026-12-05',
        endDate: '2026-12-01',
        guestCount: 2,
        propertyCapacity: 4,
      }).isValid
    ).toBe(false);

    // Window > 90 days
    expect(
      validateBookingDetails({
        startDate: '2026-01-01',
        endDate: '2026-05-01',
        guestCount: 2,
        propertyCapacity: 4,
      }).isValid
    ).toBe(false);

    // Exceeds property capacity
    expect(
      validateBookingDetails({
        startDate: '2026-12-01',
        endDate: '2026-12-05',
        guestCount: 10,
        propertyCapacity: 4,
      }).isValid
    ).toBe(false);

    // Valid details
    const valid = validateBookingDetails({
      startDate: '2026-12-01',
      endDate: '2026-12-05',
      guestCount: 4,
      propertyCapacity: 4,
    });
    expect(valid.isValid).toBe(true);
    expect(valid.errors).toHaveLength(0);
  });

  it('validates booking services (Step 2): requires slot within order dates for capacity services (Change #4)', () => {
    const services = [
      {
        serviceId: 'svc-1',
        title: 'Catering',
        kind: 'capacity',
        quantity: 1,
        slot: null, // missing slot
      },
    ];

    const invalidSlot = validateBookingServices({
      selectedServices: services,
      startDate: '2026-12-01',
      endDate: '2026-12-03',
    });
    expect(invalidSlot.isValid).toBe(false);
    expect(invalidSlot.errors[0]).toMatch(/select a date slot/i);

    // Slot outside booking date range
    services[0].slot = '2026-12-10';
    const outOfRange = validateBookingServices({
      selectedServices: services,
      startDate: '2026-12-01',
      endDate: '2026-12-03',
    });
    expect(outOfRange.isValid).toBe(false);
    expect(outOfRange.errors[0]).toMatch(/must be between/i);

    // Valid slot inside booking date range
    services[0].slot = '2026-12-02';
    const valid = validateBookingServices({
      selectedServices: services,
      startDate: '2026-12-01',
      endDate: '2026-12-03',
    });
    expect(valid.isValid).toBe(true);
  });

  it('reuses existing order if inputs are unchanged when revisiting Review (Change #10)', () => {
    const input = {
      propertyId: 'prop-123',
      startDate: '2026-12-01',
      endDate: '2026-12-05',
      guestCount: 2,
      selectedServices: [
        { serviceId: 'svc-1', quantity: 2, slot: '2026-12-02' },
      ],
    };

    const hash = computeOrderPayloadHash(input);

    const stateWithOrder = {
      ...input,
      order: { id: 'ord-999', total_minor: 50000 },
      lastOrderPayloadHash: hash,
    };

    // Unchanged inputs -> should reuse order
    expect(shouldReuseOrder(stateWithOrder)).toBe(true);

    // Changed guest count -> must NOT reuse order
    const stateChangedGuests = {
      ...stateWithOrder,
      guestCount: 3,
    };
    expect(shouldReuseOrder(stateChangedGuests)).toBe(false);

    // Changed dates -> must NOT reuse order
    const stateChangedDates = {
      ...stateWithOrder,
      endDate: '2026-12-06',
    };
    expect(shouldReuseOrder(stateChangedDates)).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingStepper } from '../src/pages/BookStepper/BookingStepper.jsx';
import { OrderStatus } from '../src/pages/OrderStatus.jsx';
import { propertiesApi } from '../src/api/properties.js';
import { servicesApi } from '../src/api/services.js';
import { ordersApi } from '../src/api/orders.js';

expect.extend(toHaveNoViolations);

describe('Step 12B Accessibility & Stepper Semantics (Change #11)', () => {
  let queryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('renders booking stepper with aria-current="step" on active step and passes axe audit', async () => {
    vi.spyOn(propertiesApi, 'getPropertyById').mockResolvedValue({
      id: 'prop-1',
      title: 'Grand Palace Estate',
      location: 'Udaipur',
      capacity: 50,
      price_minor: 500000,
      currency: 'INR',
    });

    vi.spyOn(propertiesApi, 'getPropertyAvailability').mockResolvedValue({
      available_slots: 1,
    });

    vi.spyOn(servicesApi, 'searchServices').mockResolvedValue({
      items: [],
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/book/prop-1']}>
          <Routes>
            <Route path="/book/:id" element={<BookingStepper />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Wait for property title to load
    await screen.findByText(/Book Grand Palace Estate/i);

    // Verify stepper has aria-current="step" on step 1 (Change #11)
    const step1 = screen.getByText('Details').closest('li');
    expect(step1).toHaveAttribute('aria-current', 'step');

    const step2 = screen.getByText('Services').closest('li');
    expect(step2).not.toHaveAttribute('aria-current');

    // Run axe accessibility audit
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('renders order status with polite live region and passes axe audit', async () => {
    vi.spyOn(ordersApi, 'getOrderById').mockResolvedValue({
      order: {
        id: '12345678-abcd-ef01-2345-6789abcdef01',
        status: 'CONFIRMED',
        total_minor: 150000,
        currency: 'INR',
        guest_count: 4,
        created_at: '2026-11-24T10:00:00Z',
        during: {
          start: '2026-12-01T00:00:00Z',
          end: '2026-12-03T23:59:59Z',
        },
        items: [
          {
            id: 'item-1',
            resource_type: 'PROPERTY',
            resource_id: 'prop-1',
            quantity: 1,
            price_minor: 150000,
          },
        ],
        payment: {
          id: 'pay-1',
          status: 'SUCCEEDED',
        },
      },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/orders/12345678-abcd-ef01-2345-6789abcdef01']}>
          <Routes>
            <Route path="/orders/:id" element={<OrderStatus />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await screen.findByText(/Reservation Confirmed!/i);

    // Verify aria-live="polite" container exists
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

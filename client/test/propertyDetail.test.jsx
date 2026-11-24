import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { PropertyDetail } from '../src/pages/PropertyDetail.jsx';
import { propertiesApi } from '../src/api/properties.js';
import * as AuthContextModule from '../src/context/AuthContext.jsx';

describe('PropertyDetail Component', () => {
  let queryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    vi.restoreAllMocks();

    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      user: { id: 'usr-1', email: 'customer@example.com', role: 'CUSTOMER' },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  const mockProperty = {
    id: 'prop-xyz',
    title: 'Emerald Lakeside Villa',
    description: 'A luxurious villa facing the lake, perfect for gatherings.',
    location: 'Udaipur',
    capacity: 20,
    pricing_minor: 4500000,
    currency: 'INR',
    amenities: ['wifi', 'pool', 'kitchen', 'parking'],
    images: [
      { id: 'img-1', url: 'https://cdn.example.com/prop-xyz/1.webp', position: 0 },
      { id: 'img-2', url: 'https://cdn.example.com/prop-xyz/2.webp', position: 1 },
    ],
  };

  it('renders property details, image gallery, and availability section', async () => {
    vi.spyOn(propertiesApi, 'getPropertyById').mockResolvedValueOnce(mockProperty);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/properties/prop-xyz']}>
          <Routes>
            <Route path="/properties/:id" element={<PropertyDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Wait for property details
    await waitFor(() => {
      expect(screen.getByText('Emerald Lakeside Villa')).toBeInTheDocument();
    });

    expect(screen.getByText('Udaipur')).toBeInTheDocument();
    expect(screen.getByText('20 guests')).toBeInTheDocument();
    expect(screen.getByText(/₹\s?45,000/)).toBeInTheDocument();
    expect(screen.getByText(/About this property/i)).toBeInTheDocument();
    expect(screen.getByText(/A luxurious villa facing the lake/i)).toBeInTheDocument();

    // Check amenities
    expect(screen.getByText('pool')).toBeInTheDocument();
    expect(screen.getByText('kitchen')).toBeInTheDocument();

    // Change #10: Gallery with alt text
    const mainImg = screen.getByAltText('Emerald Lakeside Villa');
    expect(mainImg).toHaveAttribute('src', 'https://cdn.example.com/prop-xyz/1.webp');

    // Change #8: Time zone disclaimer
    expect(
      screen.getByText(/All dates and times are shown in your local time zone/i),
    ).toBeInTheDocument();

    // Native date inputs present
    const checkInInput = screen.getByLabelText('Check-in');
    const checkOutInput = screen.getByLabelText('Check-out');
    expect(checkInInput).toHaveAttribute('type', 'date');
    expect(checkOutInput).toHaveAttribute('type', 'date');
  });

  it('checks availability and shows conflicts when ranges overlap', async () => {
    vi.spyOn(propertiesApi, 'getPropertyById').mockResolvedValueOnce(mockProperty);
    vi.spyOn(propertiesApi, 'getPropertyAvailability').mockResolvedValueOnce({
      property_id: 'prop-xyz',
      indicative: true,
      window: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-05T23:59:59.999Z' },
      unavailable_ranges: [
        {
          start: '2026-12-02T14:00:00.000Z',
          end: '2026-12-04T11:00:00.000Z',
          reason: 'RESERVED',
        },
      ],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/properties/prop-xyz']}>
          <Routes>
            <Route path="/properties/:id" element={<PropertyDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Emerald Lakeside Villa')).toBeInTheDocument();
    });

    const checkInInput = screen.getByLabelText('Check-in');
    const checkOutInput = screen.getByLabelText('Check-out');

    fireEvent.change(checkInInput, { target: { value: '2026-12-01' } });
    fireEvent.change(checkOutInput, { target: { value: '2026-12-05' } });

    await waitFor(() => {
      expect(screen.getByText(/Dates Unavailable/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Conflict with existing reservation/i)).toBeInTheDocument();
  });

  it('passes jest-axe accessibility audit (Change #11)', async () => {
    vi.spyOn(propertiesApi, 'getPropertyById').mockResolvedValueOnce(mockProperty);

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/properties/prop-xyz']}>
          <Routes>
            <Route path="/properties/:id" element={<PropertyDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Emerald Lakeside Villa')).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

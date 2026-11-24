import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { BrowseProperties } from '../src/pages/BrowseProperties.jsx';
import { propertiesApi } from '../src/api/properties.js';

describe('BrowseProperties Component', () => {
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
  });

  const mockProperties = [
    {
      id: 'prop-1',
      title: 'Serene Villa in Bangalore',
      description: 'Spacious private villa for weekend retreats',
      location: 'Bangalore',
      capacity: 12,
      pricing_minor: 2500000,
      currency: 'INR',
      amenities: ['wifi', 'parking', 'pool'],
      cover_image_url: 'https://cdn.example.com/properties/prop-1/cover.webp',
    },
    {
      id: 'prop-2',
      title: 'Cozy Heritage Home',
      description: 'Charming vintage house for small family gatherings',
      location: 'Mysore',
      capacity: 6,
      pricing_minor: 850000,
      currency: 'INR',
      amenities: ['wifi', 'kitchen'],
      cover_image_url: null, // No image -> tests fallback placeholder
    },
  ];

  it('renders property catalog with indicative disclaimer and property cards', async () => {
    vi.spyOn(propertiesApi, 'searchProperties').mockResolvedValueOnce({
      indicative: true,
      degraded: false,
      properties: mockProperties,
      pagination: { page: 1, limit: 12, total: 2, has_more: false },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/properties']}>
          <BrowseProperties />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Indicative notice present
    expect(
      screen.getByText(/Search results are indicative and updated periodically/i),
    ).toBeInTheDocument();

    // Wait for properties to load
    await waitFor(() => {
      expect(screen.getByText('Serene Villa in Bangalore')).toBeInTheDocument();
    });

    expect(screen.getByText('Cozy Heritage Home')).toBeInTheDocument();

    // Check money formatting
    expect(screen.getAllByText(/₹\s?25,000/).length).toBeGreaterThan(0);
    expect(screen.getByText(/₹\s?8,500/)).toBeInTheDocument();

    // Check capacity and amenities
    expect(screen.getByText('12 guests')).toBeInTheDocument();
    expect(screen.getByText('6 guests')).toBeInTheDocument();

    // Change #10: Image with lazy loading and alt text
    const image = screen.getByAltText('Serene Villa in Bangalore');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('src', 'https://cdn.example.com/properties/prop-1/cover.webp');

    // Change #10: Placeholder when no image available
    expect(screen.getByText('[No image available]')).toBeInTheDocument();
  });

  it('displays degraded notice when search is in degraded fallback mode', async () => {
    vi.spyOn(propertiesApi, 'searchProperties').mockResolvedValueOnce({
      indicative: true,
      degraded: true,
      properties: mockProperties,
      pagination: { page: 1, limit: 12, total: 2, has_more: false },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/properties']}>
          <BrowseProperties />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/simplified fallback mode/i)).toBeInTheDocument();
    });
  });

  it('displays text-only empty state when no properties match (Change #10)', async () => {
    vi.spyOn(propertiesApi, 'searchProperties').mockResolvedValueOnce({
      indicative: true,
      degraded: false,
      properties: [],
      pagination: { page: 1, limit: 12, total: 0, has_more: false },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/properties']}>
          <BrowseProperties />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('No properties found')).toBeInTheDocument();
    });

    expect(
      screen.getByText(/No properties match your current filters/i),
    ).toBeInTheDocument();
  });

  it('passes jest-axe accessibility checks (Change #11)', async () => {
    vi.spyOn(propertiesApi, 'searchProperties').mockResolvedValueOnce({
      indicative: true,
      degraded: false,
      properties: mockProperties,
      pagination: { page: 1, limit: 12, total: 2, has_more: false },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/properties']}>
          <BrowseProperties />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Serene Villa in Bangalore')).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

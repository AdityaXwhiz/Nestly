import { useState, useEffect, useId } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { propertiesApi } from '../api/properties.js';
import { Card } from '../components/common/Card.jsx';
import { Input } from '../components/common/Input.jsx';
import { Select } from '../components/common/Select.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Button } from '../components/common/Button.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import { EmptyState } from '../components/common/EmptyState.jsx';
import { formatMoney } from '../utils/money.js';
import './BrowseProperties.css';

const AMENITY_OPTIONS = [
  { id: 'wifi', label: 'Wi-Fi' },
  { id: 'parking', label: 'Parking' },
  { id: 'pool', label: 'Swimming Pool' },
  { id: 'air_conditioning', label: 'Air Conditioning' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'garden', label: 'Garden / Lawn' },
];

export function BrowseProperties() {
  const [searchParams, setSearchParams] = useSearchParams();

  const urlQ = searchParams.get('q') || '';
  const urlLocation = searchParams.get('location') || '';
  const urlMinCapacity = searchParams.get('min_capacity') || '';
  const urlMaxPrice = searchParams.get('max_price') || '';
  const urlAmenities = searchParams.get('amenities') || '';
  const urlPage = Number(searchParams.get('page') || '1');

  // Local state for debouncing text search input
  const [searchTerm, setSearchTerm] = useState(urlQ);

  // Sync local input with URL if URL changes externally (e.g. back/forward navigation)
  useEffect(() => {
    setSearchTerm(urlQ);
  }, [urlQ]);

  // Debounce text input by 300ms (Change #5)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchTerm !== urlQ) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          if (searchTerm.trim()) {
            next.set('q', searchTerm.trim());
          } else {
            next.delete('q');
          }
          next.delete('page'); // Reset to page 1 on new search query
          return next;
        });
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchTerm, urlQ, setSearchParams]);

  const updateParam = (key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value !== undefined && value !== null && value !== '') {
        next.set(key, String(value));
      } else {
        next.delete(key);
      }
      next.delete('page'); // Reset to page 1 on filter change
      return next;
    });
  };

  const handleAmenityToggle = (amenityId) => {
    const currentList = urlAmenities ? urlAmenities.split(',').filter(Boolean) : [];
    const isChecked = currentList.includes(amenityId);
    const updatedList = isChecked
      ? currentList.filter((a) => a !== amenityId)
      : [...currentList, amenityId];

    updateParam('amenities', updatedList.length > 0 ? updatedList.join(',') : '');
  };

  const handleClearFilters = () => {
    setSearchTerm('');
    setSearchParams(new URLSearchParams());
  };

  const selectedAmenities = urlAmenities ? urlAmenities.split(',').filter(Boolean) : [];

  // TanStack Query with keepPreviousData (Change #5)
  const { data, isLoading, isError, error, isPlaceholderData } = useQuery({
    queryKey: [
      'properties',
      {
        q: urlQ,
        location: urlLocation,
        min_capacity: urlMinCapacity,
        max_price: urlMaxPrice,
        amenities: urlAmenities,
        page: urlPage,
      },
    ],
    queryFn: () =>
      propertiesApi.searchProperties({
        q: urlQ || undefined,
        location: urlLocation || undefined,
        min_capacity: urlMinCapacity ? Number(urlMinCapacity) : undefined,
        max_price: urlMaxPrice ? Number(urlMaxPrice) : undefined,
        amenities: selectedAmenities.length > 0 ? selectedAmenities : undefined,
        page: urlPage,
        limit: 12,
      }),
    placeholderData: keepPreviousData,
  });

  const properties = data?.properties || [];
  const pagination = data?.pagination || { page: 1, limit: 12, total: 0, has_more: false };
  const totalPages = Math.max(1, Math.ceil((pagination.total || 0) / (pagination.limit || 12)));

  const handlePageChange = (newPage) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (newPage > 1) {
        next.set('page', String(newPage));
      } else {
        next.delete('page');
      }
      return next;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const searchInputId = useId();
  const locationInputId = useId();
  const capacitySelectId = useId();
  const priceSelectId = useId();

  return (
    <div className="browse-page">
      <header className="browse-header">
        <h1 className="browse-title">Find Properties</h1>
        <p className="indicative-notice">
          Search results are indicative and updated periodically. Availability is confirmed at reservation.
        </p>
      </header>

      {data?.degraded && (
        <div className="degraded-notice" role="status">
          <strong>Notice:</strong> Search is operating in simplified fallback mode.
        </div>
      )}

      <div className="browse-layout">
        {/* Filter Sidebar */}
        <aside className="filter-sidebar" aria-label="Filters">
          <div className="filter-sidebar-header">
            <h2 className="filter-sidebar-title">Filters</h2>
            {(urlQ || urlLocation || urlMinCapacity || urlMaxPrice || urlAmenities) && (
              <button
                type="button"
                className="clear-filters-btn"
                onClick={handleClearFilters}
              >
                Clear all
              </button>
            )}
          </div>

          <div className="filter-group">
            <Input
              id={searchInputId}
              label="Keywords"
              placeholder="Search by title, description..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div className="filter-group">
            <Input
              id={locationInputId}
              label="Location"
              placeholder="e.g. Bangalore, Goa..."
              value={urlLocation}
              onChange={(e) => updateParam('location', e.target.value.trim())}
            />
          </div>

          <div className="filter-group">
            <Select
              id={capacitySelectId}
              label="Guests"
              value={urlMinCapacity}
              onChange={(e) => updateParam('min_capacity', e.target.value)}
              options={[
                { value: '', label: 'Any guest capacity' },
                { value: '2', label: '2+ guests' },
                { value: '5', label: '5+ guests' },
                { value: '10', label: '10+ guests' },
                { value: '25', label: '25+ guests' },
                { value: '50', label: '50+ guests' },
              ]}
            />
          </div>

          <div className="filter-group">
            <Select
              id={priceSelectId}
              label="Max Price Per Night"
              value={urlMaxPrice}
              onChange={(e) => updateParam('max_price', e.target.value)}
              options={[
                { value: '', label: 'Any price' },
                { value: '500000', label: 'Up to ₹5,000' },
                { value: '1000000', label: 'Up to ₹10,000' },
                { value: '2500000', label: 'Up to ₹25,000' },
                { value: '5000000', label: 'Up to ₹50,000' },
                { value: '10000000', label: 'Up to ₹1,00,000' },
              ]}
            />
          </div>

          <fieldset className="filter-group" style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="filter-group-legend" style={{ marginBottom: 'var(--space-2)' }}>
              Amenities
            </legend>
            <div className="amenities-list">
              {AMENITY_OPTIONS.map((opt) => (
                <label key={opt.id} className="amenity-checkbox-label">
                  <input
                    type="checkbox"
                    className="amenity-checkbox"
                    checked={selectedAmenities.includes(opt.id)}
                    onChange={() => handleAmenityToggle(opt.id)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </aside>

        {/* Results Area */}
        <section className="results-content" aria-label="Search Results">
          {isError && (
            <ErrorMessage
              title="Failed to load properties"
              message={error?.message || 'Could not fetch properties. Please try again later.'}
              requestId={error?.requestId}
            />
          )}

          {isLoading && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '300px',
              }}
              role="status"
            >
              <Spinner size="lg" />
              <span className="sr-only">Loading properties...</span>
            </div>
          )}

          {!isLoading && properties.length === 0 && (
            <EmptyState
              title="No properties found"
              description="No properties match your current filters. Try relaxing your search criteria or clearing filters."
            >
              {(urlQ || urlLocation || urlMinCapacity || urlMaxPrice || urlAmenities) && (
                <Button variant="outline" onClick={handleClearFilters} style={{ marginTop: 'var(--space-4)' }}>
                  Clear all filters
                </Button>
              )}
            </EmptyState>
          )}

          {!isLoading && properties.length > 0 && (
            <>
              <div className="results-meta">
                <span>
                  Showing {properties.length} of {pagination.total} properties
                </span>
                {isPlaceholderData && (
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-primary)' }}>
                    Updating...
                  </span>
                )}
              </div>

              <div className="properties-grid">
                {properties.map((property) => (
                  <Link
                    key={property.id}
                    to={`/properties/${property.id}`}
                    className="property-card-link"
                    aria-label={`View details for ${property.title}`}
                  >
                    <Card className="property-card">
                      <div className="property-card-image-wrap">
                        {property.cover_image_url ? (
                          <img
                            src={property.cover_image_url}
                            alt={property.title}
                            loading="lazy"
                            className="property-card-image"
                          />
                        ) : (
                          <div className="property-image-placeholder">
                            <span>[No image available]</span>
                          </div>
                        )}
                      </div>

                      <div className="property-card-body">
                        <span className="property-card-location">{property.location}</span>
                        <h2 className="property-card-title">{property.title}</h2>

                        <div className="property-card-badges">
                          <Badge variant="default">{property.capacity} guests</Badge>
                          {property.amenities?.slice(0, 3).map((amenity) => (
                            <Badge key={amenity} variant="neutral">
                              {amenity.replace('_', ' ')}
                            </Badge>
                          ))}
                          {property.amenities?.length > 3 && (
                            <Badge variant="neutral">+{property.amenities.length - 3}</Badge>
                          )}
                        </div>

                        <div className="property-card-footer">
                          <div className="property-price">
                            {formatMoney(property.pricing_minor)}
                            <span className="property-price-unit"> / day</span>
                          </div>
                        </div>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>

              {totalPages > 1 && (
                <nav className="pagination-bar" aria-label="Pagination">
                  <Button
                    variant="outline"
                    disabled={urlPage <= 1}
                    onClick={() => handlePageChange(urlPage - 1)}
                  >
                    Previous
                  </Button>
                  <span className="page-indicator">
                    Page {urlPage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    disabled={!pagination.has_more && urlPage >= totalPages}
                    onClick={() => handlePageChange(urlPage + 1)}
                  >
                    Next
                  </Button>
                </nav>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

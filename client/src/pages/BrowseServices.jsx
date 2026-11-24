import { useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { servicesApi } from '../api/services.js';
import { Card } from '../components/common/Card.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import { EmptyState } from '../components/common/EmptyState.jsx';
import { formatMoney } from '../utils/money.js';
import './BrowseServices.css';

const CATEGORIES = [
  { id: '', label: 'All Services' },
  { id: 'CATERING', label: 'Catering' },
  { id: 'DECORATION', label: 'Decoration' },
  { id: 'CAKE', label: 'Cakes & Desserts' },
  { id: 'PHOTOGRAPHY', label: 'Photography' },
  { id: 'MUSIC', label: 'Music & DJ' },
  { id: 'OTHER', label: 'Other' },
];

export function BrowseServices() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentCategory = searchParams.get('category') || '';
  const currentPage = Number(searchParams.get('page') || '1');

  const handleSelectCategory = (categoryId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (categoryId) {
        next.set('category', categoryId);
      } else {
        next.delete('category');
      }
      next.delete('page');
      return next;
    });
  };

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['services', { category: currentCategory, page: currentPage }],
    queryFn: () =>
      servicesApi.searchServices({
        category: currentCategory || undefined,
        page: currentPage,
        limit: 18,
      }),
    placeholderData: keepPreviousData,
  });

  const services = data?.services || [];

  return (
    <div className="services-page">
      <header className="services-header">
        <h1 className="services-title">Event Services</h1>
        <p className="indicative-notice">
          Add vendor services to your property order. Service catalog results are indicative and updated periodically.
        </p>
      </header>

      {/* Category Pills Navigation */}
      <nav className="category-filter-bar" aria-label="Filter by service category">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id || 'all'}
            type="button"
            className={`category-pill ${currentCategory.toUpperCase() === cat.id ? 'active' : ''}`}
            onClick={() => handleSelectCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </nav>

      {/* Services Grid */}
      <section aria-label="Services List">
        {isError && (
          <ErrorMessage
            title="Failed to load services"
            message={error?.message || 'Could not fetch services at this time.'}
            requestId={error?.requestId}
          />
        )}

        {isLoading && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              minHeight: '200px',
            }}
            role="status"
          >
            <Spinner size="lg" />
            <span className="sr-only">Loading services...</span>
          </div>
        )}

        {!isLoading && services.length === 0 && (
          <EmptyState
            title="No services found"
            description="There are currently no active services in this category."
          />
        )}

        {!isLoading && services.length > 0 && (
          <div className="services-grid">
            {services.map((service) => (
              <Card key={service.id} className="service-card">
                <div className="service-card-top">
                  <h2 className="service-card-title">{service.title}</h2>
                  <Badge variant="accent">{service.category}</Badge>
                </div>

                <p className="service-card-desc">{service.description}</p>

                <div className="service-card-footer">
                  <div className="service-price">
                    {formatMoney(service.price_minor)}
                  </div>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                    {service.kind === 'HOURLY' ? 'per hour' : 'flat fee'}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

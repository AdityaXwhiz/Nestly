import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { propertiesApi } from '../api/properties.js';
import { formatMoney } from '../utils/money.js';
import { formatDate } from '../utils/date.js';
import { Badge } from '../components/common/Badge.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { EmptyState } from '../components/common/EmptyState.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import './HostProperties.css';

export function HostProperties() {
  const { data: properties, isLoading, error } = useQuery({
    queryKey: ['host-properties'],
    queryFn: () => propertiesApi.getMyProperties(),
  });

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '4rem 0', textAlign: 'center' }}>
        <Spinner size="lg" message="Loading your properties..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container" style={{ padding: '4rem 0' }}>
        <ErrorMessage
          title="Error Loading Properties"
          message={error.message || 'Unable to retrieve your properties list.'}
        />
      </div>
    );
  }

  return (
    <div className="container host-properties-page">
      <div className="host-header">
        <div>
          <h1 className="host-title">My Properties</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            Manage your rental listings, photos, and availability.
          </p>
        </div>
        <Link to="/host/properties/new" className="btn btn-primary">
          + Add New Property
        </Link>
      </div>

      {(!properties || properties.length === 0) ? (
        <EmptyState
          title="No properties listed yet"
          message="Create your first property listing to start receiving booking requests."
          actionText="Add New Property"
          onAction="/host/properties/new"
        />
      ) : (
        <div className="properties-table-container">
          <table className="properties-table" aria-label="My properties list">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Location</th>
                <th scope="col">Capacity</th>
                <th scope="col">Price / Day</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col" style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {properties.map((prop) => (
                <tr key={prop.id}>
                  <td>
                    <Link
                      to={`/host/properties/${prop.id}`}
                      style={{ fontWeight: '600', color: 'var(--color-accent)' }}
                    >
                      {prop.title}
                    </Link>
                  </td>
                  <td>{prop.location}</td>
                  <td>{prop.capacity} guests</td>
                  <td>{formatMoney(prop.pricing_minor ?? prop.price_minor, prop.currency)}</td>
                  <td>
                    <Badge variant={prop.status === 'ACTIVE' ? 'accent' : 'neutral'}>
                      {prop.status}
                    </Badge>
                  </td>
                  <td style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                    {formatDate(prop.created_at)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Link
                      to={`/host/properties/${prop.id}`}
                      className="btn btn-outline"
                      style={{ padding: '0.25rem 0.75rem', fontSize: 'var(--font-size-xs)' }}
                    >
                      Edit & Photos
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

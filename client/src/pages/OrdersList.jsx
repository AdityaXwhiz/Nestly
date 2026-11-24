import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ordersApi } from '../api/orders.js';
import { formatMoney } from '../utils/money.js';
import { formatDate, formatDateRange } from '../utils/date.js';
import { Badge } from '../components/common/Badge.jsx';
import { Button } from '../components/common/Button.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { EmptyState } from '../components/common/EmptyState.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import './OrdersList.css';

export function OrdersList() {
  const [page, setPage] = useState(1);
  const limit = 10;

  const { data, isLoading, error } = useQuery({
    queryKey: ['orders', page],
    queryFn: () => ordersApi.listOrders({ page, limit }),
    keepPreviousData: true,
  });

  const getStatusBadgeVariant = (status) => {
    switch (status) {
      case 'CONFIRMED':
        return 'accent';
      case 'HELD':
        return 'neutral';
      case 'FAILED':
      case 'EXPIRED':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '4rem 0', textAlign: 'center' }}>
        <Spinner size="lg" message="Loading your orders..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container" style={{ padding: '4rem 0' }}>
        <ErrorMessage
          title="Error Loading Orders"
          message={error.message || 'Unable to retrieve your order history.'}
        />
      </div>
    );
  }

  const orders = data?.orders || [];
  const pagination = data?.pagination || { page: 1, limit, total: orders.length };
  const totalPages = pagination.total_pages || Math.max(1, Math.ceil((pagination.total || 0) / limit));

  return (
    <div className="container orders-page">
      <div className="orders-header">
        <h1 className="orders-title">Your Bookings</h1>
        <Link to="/properties" className="btn btn-primary">
          Explore Properties
        </Link>
      </div>

      {orders.length === 0 ? (
        <EmptyState
          title="No bookings yet"
          message="When you make a reservation, your bookings and payment status will appear here."
          actionText="Browse Properties"
          onAction="/properties"
        />
      ) : (
        <>
          <div className="orders-list">
            {orders.map((order) => (
              <Link
                key={order.id}
                to={`/orders/${order.id}`}
                className="order-card"
                aria-label={`View order ${order.id.slice(0, 8)}, status ${order.status}`}
              >
                <div className="order-card-main">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)', fontWeight: 'bold' }}>
                      #{order.id.slice(0, 8)}
                    </span>
                    <Badge variant={getStatusBadgeVariant(order.status)}>{order.status}</Badge>
                  </div>
                  <div className="order-card-meta">
                    <span>Booked on: {formatDate(order.created_at)}</span>
                    <span>•</span>
                    <span>Dates: {formatDateRange(order.during)}</span>
                    <span>•</span>
                    <span>{order.items?.length || 0} item(s)</span>
                  </div>
                </div>

                <div className="order-card-side">
                  <span className="order-card-amount">
                    {formatMoney(order.total_amount_minor ?? order.total_minor, order.currency)}
                  </span>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-accent)' }}>
                    View Details →
                  </span>
                </div>
              </Link>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="pagination-controls" aria-label="Pagination">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                Previous
              </Button>
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

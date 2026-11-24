import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ordersApi } from '../api/orders.js';
import { paymentsApi } from '../api/payments.js';
import { formatMoney } from '../utils/money.js';
import { formatDate, formatDateRange } from '../utils/date.js';
import { getFriendlyErrorMessage } from '../utils/errors.js';
import { getOrCreatePaymentIdempotencyKey } from './BookStepper/BookingState.js';
import { Button } from '../components/common/Button.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import './OrderStatus.css';

const TERMINAL_ORDER_STATUSES = new Set(['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED']);

export function OrderStatus() {
  const { id: orderId } = useParams();
  const queryClient = useQueryClient();

  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const prevStatusRef = useRef(null);
  const startTimeRef = useRef(Date.now());
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [actionError, setActionError] = useState(null);

  // Fetch order data with controlled polling for non-terminal states
  const {
    data: orderData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => ordersApi.getOrderById(orderId),
    refetchInterval: (query) => {
      const o = query.state.data?.order || query.state.data;
      if (!o) return 2000;

      // Stop polling on terminal states
      if (TERMINAL_ORDER_STATUSES.has(o.status)) {
        return false;
      }

      // Stop polling after 60 seconds (max duration)
      if (Date.now() - startTimeRef.current > 60000) {
        return false;
      }

      // If payment is PROCESSING or order is HELD, poll every 2s
      return 2000;
    },
  });

  const order = orderData?.order || orderData;
  const payment = order?.payment;

  // Accessibility: Announce status change to screen readers only when status changes (Change #11)
  useEffect(() => {
    if (order?.status && order.status !== prevStatusRef.current) {
      prevStatusRef.current = order.status;
      setStatusAnnouncement(`Order status changed to ${order.status}`);
    }
  }, [order?.status]);

  // Handle Pay / Retry Payment
  const handlePayNow = async () => {
    if (!orderId || isActionLoading) return;
    setActionError(null);
    setIsActionLoading(true);

    try {
      const idempotencyKey = getOrCreatePaymentIdempotencyKey(orderId);
      await paymentsApi.createPayment({ orderId, idempotencyKey });
      queryClient.invalidateQueries(['order', orderId]);
    } catch (err) {
      setActionError(getFriendlyErrorMessage(err));
    } finally {
      setIsActionLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '4rem 0', textAlign: 'center' }}>
        <Spinner size="lg" message="Loading order details..." />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="container" style={{ padding: '4rem 0' }}>
        <ErrorMessage
          title="Order Not Found"
          message={error?.message || 'Unable to retrieve order details.'}
        />
        <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
          <Link to="/orders" className="btn btn-outline">
            View My Orders
          </Link>
        </div>
      </div>
    );
  }

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

  return (
    <div className="container order-status-page">
      {/* Polite live region for screen readers (Change #11) */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {statusAnnouncement}
      </div>

      <div className="order-status-card">
        <div className="order-header-row">
          <div>
            <span className="order-id-label">Order #{order.id.slice(0, 8)}</span>
            <h1 className="order-title">Order Status</h1>
          </div>
          <Badge variant={getStatusBadgeVariant(order.status)}>{order.status}</Badge>
        </div>

        {actionError && <ErrorMessage message={actionError} />}

        {/* Action Branching based on Order Status + Payment Status (Change #2) */}
        {order.status === 'CONFIRMED' && (
          <div className="order-action-banner confirmed">
            <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)', fontWeight: 'bold' }}>✓ Reservation Confirmed!</h2>
            <p style={{ margin: 0, fontSize: 'var(--font-size-sm)' }}>
              Your reservation has been confirmed and payment was completed. Thank you for booking with Nestly.
            </p>
          </div>
        )}

        {order.status === 'HELD' && payment?.status === 'PROCESSING' && (
          <div className="order-action-banner processing">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Spinner size="sm" />
              <div>
                <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)', fontWeight: 'bold' }}>Payment Processing</h2>
                <p style={{ margin: 0, fontSize: 'var(--font-size-sm)' }}>
                  We are finalizing your payment with the provider. This page will update automatically.
                </p>
              </div>
            </div>
          </div>
        )}

        {order.status === 'HELD' && (!payment || payment.status === 'FAILED') && (
          <div className="order-action-banner processing">
            <div>
              <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)', fontWeight: 'bold' }}>Reservation Held</h2>
              <p style={{ margin: 0, fontSize: 'var(--font-size-sm)' }}>
                Your inventory is held. Please complete payment to confirm your booking.
              </p>
            </div>
            <div style={{ marginTop: '0.5rem' }}>
              <Button
                variant="primary"
                onClick={handlePayNow}
                disabled={isActionLoading}
              >
                {isActionLoading ? 'Processing...' : 'Pay Now'}
              </Button>
            </div>
          </div>
        )}

        {(order.status === 'FAILED' || order.status === 'EXPIRED') && (
          <div className="order-action-banner failed">
            <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)', fontWeight: 'bold' }}>Order Not Completed</h2>
            <p style={{ margin: 0, fontSize: 'var(--font-size-sm)' }}>
              This reservation was {order.status.toLowerCase()}. You can start a new booking at any time.
            </p>
            <div style={{ marginTop: '0.5rem' }}>
              <Link to="/properties" className="btn btn-outline">
                Browse Properties
              </Link>
            </div>
          </div>
        )}

        {/* Order Details Grid */}
        <div className="order-details-grid">
          <div>
            <span className="detail-item-label">Created Date</span>
            <div className="detail-item-value">{formatDate(order.created_at)}</div>
          </div>
          <div>
            <span className="detail-item-label">Guest Count</span>
            <div className="detail-item-value">{order.guest_count || 1} Guests</div>
          </div>
          <div>
            <span className="detail-item-label">Reservation Dates</span>
            <div className="detail-item-value">
              {formatDateRange(order.during)}
            </div>
          </div>
          <div>
            <span className="detail-item-label">Payment ID</span>
            <div className="detail-item-value">
              {payment?.id ? `${payment.id.slice(0, 8)} (${payment.status})` : 'None'}
            </div>
          </div>
        </div>

        {/* Line Items Table */}
        <div>
          <h2 style={{ fontSize: 'var(--font-size-base)', fontWeight: 'bold', marginBottom: '1rem' }}>
            Booked Items
          </h2>
          <table className="order-items-table" aria-label="Booked items">
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: 'left' }}>Item</th>
                <th scope="col" style={{ textAlign: 'center' }}>Qty</th>
                <th scope="col" style={{ textAlign: 'right' }}>Unit Price</th>
              </tr>
            </thead>
            <tbody>
              {order.items?.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div style={{ fontWeight: '500' }}>
                      {item.title || (item.resource_type === 'PROPERTY' ? 'Property Rental' : `Service (${item.resource_type})`)}
                    </div>
                    {item.slot && (
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                        Slot: {item.slot}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'center' }}>{item.quantity}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(item.unit_price_minor ?? item.price_minor, order.currency)}</td>
                </tr>
              ))}
              <tr className="order-footer-total">
                <th scope="row" colSpan={2} style={{ textAlign: 'left' }}>Total Paid / Due</th>
                <td style={{ textAlign: 'right' }}>{formatMoney(order.total_amount_minor ?? order.total_minor, order.currency)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem' }}>
          <Link to="/orders" className="btn btn-outline">
            ← Back to Orders
          </Link>
          <Link to="/properties" className="btn btn-secondary">
            Browse More Properties
          </Link>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { propertiesApi } from '../../api/properties.js';
import { servicesApi } from '../../api/services.js';
import { ordersApi } from '../../api/orders.js';
import { paymentsApi } from '../../api/payments.js';
import { formatMoney } from '../../utils/money.js';
import { toInputDateFormat, toIsoWithLocalOffset, getDatesInRange } from '../../utils/date.js';
import { computeTargetPerformanceNow, getRemainingSeconds, formatRemainingTime } from '../../utils/countdown.js';
import { getFriendlyErrorMessage } from '../../utils/errors.js';
import {
  createInitialBookingState,
  validateBookingDetails,
  validateBookingServices,
  computeOrderPayloadHash,
  shouldReuseOrder,
  getOrCreatePaymentIdempotencyKey,
} from './BookingState.js';
import { Button } from '../../components/common/Button.jsx';
import { Input } from '../../components/common/Input.jsx';
import { Spinner } from '../../components/common/Spinner.jsx';
import { ErrorMessage } from '../../components/common/ErrorMessage.jsx';
import { Badge } from '../../components/common/Badge.jsx';
import './BookingStepper.css';

export function BookingStepper() {
  const { id: propertyId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Load property details
  const { data: property, isLoading: isPropertyLoading, error: propertyError } = useQuery({
    queryKey: ['property', propertyId],
    queryFn: () => propertiesApi.getPropertyById(propertyId),
  });

  // Load available services
  const { data: servicesData, isLoading: isServicesLoading } = useQuery({
    queryKey: ['services', 'active'],
    queryFn: () => servicesApi.searchServices({ limit: 50 }),
  });

  const [state, setState] = useState(() =>
    createInitialBookingState({
      propertyId,
      from: searchParams.get('from') || toInputDateFormat(new Date()),
      to: searchParams.get('to') || toInputDateFormat(new Date(Date.now() + 86400000)),
      guests: 1,
    })
  );

  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const [targetPerfNow, setTargetPerfNow] = useState(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [isHolding, setIsHolding] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [submittingError, setSubmittingError] = useState(null);
  const [fieldIssues, setFieldIssues] = useState([]);

  // Check property availability for selected dates
  const { data: availabilityData, isFetching: isCheckingAvailability } = useQuery({
    queryKey: ['property-avail', propertyId, state.startDate, state.endDate],
    queryFn: () =>
      propertiesApi.getPropertyAvailability(
        propertyId,
        toIsoWithLocalOffset(state.startDate),
        toIsoWithLocalOffset(state.endDate, true)
      ),
    enabled: !!(propertyId && state.startDate && state.endDate && state.startDate <= state.endDate),
  });

  const isPropertyAvailable =
    availabilityData?.available_slots !== undefined ? availabilityData.available_slots > 0 : true;

  // Countdown timer effect using performance.now() (Change #1)
  useEffect(() => {
    if (!targetPerfNow) return;

    const tick = () => {
      const sec = getRemainingSeconds(targetPerfNow);
      setRemainingSeconds(sec);
      if (sec <= 0) {
        setStatusAnnouncement('Your reservation hold has expired.');
      }
    };

    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [targetPerfNow]);

  // Stepper navigation
  const goToStep = (stepNumber) => {
    setState((prev) => ({ ...prev, step: stepNumber }));
    setSubmittingError(null);
    setFieldIssues([]);
  };

  // Step 1: Validate & proceed
  const handleProceedToServices = () => {
    const val = validateBookingDetails({
      startDate: state.startDate,
      endDate: state.endDate,
      guestCount: state.guestCount,
      propertyCapacity: property?.capacity,
    });

    if (!val.isValid) {
      setSubmittingError(val.errors[0]);
      return;
    }

    if (!isPropertyAvailable) {
      setSubmittingError('Selected dates are not available for this property.');
      return;
    }

    setSubmittingError(null);
    goToStep(2);
  };

  // Step 2: Service toggle & slot selection
  const handleToggleService = (service) => {
    setState((prev) => {
      const exists = prev.selectedServices.find((s) => s.serviceId === service.id);
      if (exists) {
        return {
          ...prev,
          selectedServices: prev.selectedServices.filter((s) => s.serviceId !== service.id),
        };
      }
      return {
        ...prev,
        selectedServices: [
          ...prev.selectedServices,
          {
            serviceId: service.id,
            title: service.title,
            kind: service.kind,
            price_minor: service.price_minor,
            currency: service.currency,
            quantity: 1,
            slot: service.kind === 'capacity' ? prev.startDate : null,
          },
        ],
      };
    });
  };

  const handleUpdateServiceSlot = (serviceId, slot) => {
    setState((prev) => ({
      ...prev,
      selectedServices: prev.selectedServices.map((s) =>
        s.serviceId === serviceId ? { ...s, slot } : s
      ),
    }));
  };

  const handleUpdateServiceQuantity = (serviceId, quantity) => {
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    setState((prev) => ({
      ...prev,
      selectedServices: prev.selectedServices.map((s) =>
        s.serviceId === serviceId ? { ...s, quantity: qty } : s
      ),
    }));
  };

  const handleProceedToReview = async () => {
    const val = validateBookingServices({
      selectedServices: state.selectedServices,
      startDate: state.startDate,
      endDate: state.endDate,
    });

    if (!val.isValid) {
      setSubmittingError(val.errors[0]);
      return;
    }

    setSubmittingError(null);
    setFieldIssues([]);

    // Check if we can reuse previous order (Change #10)
    if (shouldReuseOrder(state)) {
      goToStep(3);
      return;
    }

    // Submit order creation to backend
    try {
      setIsHolding(true);
      const parsedGuestCount = parseInt(state.guestCount, 10) || 1;
      const payload = {
        property_id: propertyId,
        during: {
          start: toIsoWithLocalOffset(state.startDate),
          end: toIsoWithLocalOffset(state.endDate, true),
        },
        guest_count: parsedGuestCount,
        services: state.selectedServices.map((s) => ({
          service_id: s.serviceId,
          quantity: parseInt(s.quantity, 10) || 1,
          slot: s.slot || undefined,
        })),
      };

      const res = await ordersApi.createOrder(payload);
      const orderObj = res.order || res;
      const hash = computeOrderPayloadHash({
        propertyId,
        startDate: state.startDate,
        endDate: state.endDate,
        guestCount: parsedGuestCount,
        selectedServices: state.selectedServices,
      });

      setState((prev) => ({
        ...prev,
        order: orderObj,
        lastOrderPayloadHash: hash,
      }));
      goToStep(3);
    } catch (err) {
      if ((err.code === 'ITEM_INVALID' || err.code === 'VALIDATION_ERROR') && err.details?.issues) {
        setFieldIssues(err.details.issues);
      }
      setSubmittingError(getFriendlyErrorMessage(err));
    } finally {
      setIsHolding(false);
    }
  };

  // Step 3 -> 4: Hold order
  const handleProceedToHoldAndPay = async (retryCount = 0) => {
    if (!state.order?.id) return;
    setSubmittingError(null);
    setIsHolding(true);

    try {
      const holdRes = await ordersApi.holdOrder(state.order.id);
      // Compute monotonic target timestamp from server_time and hold_expires_at (Change #1)
      const targetPerf = computeTargetPerformanceNow(holdRes.hold_expires_at, holdRes.server_time);
      setTargetPerfNow(targetPerf);
      setState((prev) => ({
        ...prev,
        holdData: holdRes,
      }));
      setStatusAnnouncement('Reservation hold active. Complete payment before the timer expires.');
      goToStep(4);
    } catch (err) {
      // Change #9: on ORDER_NOT_HOLDABLE, refetch order and retry after short delay
      if (err.code === 'ORDER_NOT_HOLDABLE' && retryCount < 3) {
        setTimeout(async () => {
          try {
            const fresh = await ordersApi.getOrderById(state.order.id);
            setState((prev) => ({ ...prev, order: fresh.order || fresh }));
            handleProceedToHoldAndPay(retryCount + 1);
          } catch {
            setSubmittingError(getFriendlyErrorMessage(err));
          }
        }, 1000);
        return;
      }
      setSubmittingError(getFriendlyErrorMessage(err));
    } finally {
      setIsHolding(false);
    }
  };

  // Step 4: Pay
  // The UI never collects card data (the mock provider has no card form).
  const handlePayOrder = async () => {
    if (!state.order?.id || isPaying) return;
    if (remainingSeconds <= 0) {
      setSubmittingError('Reservation hold has expired. Please refresh the hold to continue.');
      return;
    }

    setSubmittingError(null);
    setIsPaying(true);

    // Change #8: Idempotency-Key generated once per order attempt and persisted in sessionStorage
    const idempotencyKey = getOrCreatePaymentIdempotencyKey(state.order.id);

    try {
      await paymentsApi.createPayment({
        orderId: state.order.id,
        idempotencyKey,
      });
      // Payment accepted / processing -> navigate to order status
      navigate(`/orders/${state.order.id}`);
    } catch (err) {
      // Change #8: Second-tab payment conflict (PAYMENT_ALREADY_EXISTS) redirects to /orders/:id
      if (err.code === 'PAYMENT_ALREADY_EXISTS' || err.status === 409) {
        navigate(`/orders/${state.order.id}`);
        return;
      }
      setSubmittingError(getFriendlyErrorMessage(err));
      setIsPaying(false);
    }
  };

  if (isPropertyLoading) {
    return (
      <div className="container" style={{ padding: '4rem 0', textAlign: 'center' }}>
        <Spinner size="lg" message="Loading booking details..." />
      </div>
    );
  }

  if (propertyError || !property) {
    return (
      <div className="container" style={{ padding: '4rem 0' }}>
        <ErrorMessage
          title="Property Not Found"
          message={propertyError?.message || 'Unable to load property details for booking.'}
        />
      </div>
    );
  }

  const dateOptions = getDatesInRange(state.startDate, state.endDate);

  return (
    <div className="container booking-page">
      {/* Live announcement region for status updates (Change #11) */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {statusAnnouncement}
      </div>

      <div className="booking-header">
        <h1 className="booking-title">Book {property.title}</h1>
        <p className="booking-subtitle">{property.location}</p>
      </div>

      {/* Accessible Stepper Nav */}
      <nav className="stepper-nav" aria-label="Booking steps">
        <ol className="stepper-list">
          <li
            className={`stepper-item ${state.step === 1 ? 'active' : ''} ${state.step > 1 ? 'completed' : ''}`}
            aria-current={state.step === 1 ? 'step' : undefined}
          >
            <span className="stepper-bubble">1</span>
            <span className="stepper-label">Details</span>
          </li>
          <li
            className={`stepper-item ${state.step === 2 ? 'active' : ''} ${state.step > 2 ? 'completed' : ''}`}
            aria-current={state.step === 2 ? 'step' : undefined}
          >
            <span className="stepper-bubble">2</span>
            <span className="stepper-label">Services</span>
          </li>
          <li
            className={`stepper-item ${state.step === 3 ? 'active' : ''} ${state.step > 3 ? 'completed' : ''}`}
            aria-current={state.step === 3 ? 'step' : undefined}
          >
            <span className="stepper-bubble">3</span>
            <span className="stepper-label">Review</span>
          </li>
          <li
            className={`stepper-item ${state.step === 4 ? 'active' : ''}`}
            aria-current={state.step === 4 ? 'step' : undefined}
          >
            <span className="stepper-bubble">4</span>
            <span className="stepper-label">Hold & Pay</span>
          </li>
        </ol>
      </nav>

      {submittingError && (
        <div style={{ marginBottom: '1.5rem' }}>
          <ErrorMessage message={submittingError} />
        </div>
      )}

      {fieldIssues.length > 0 && (
        <div style={{ marginBottom: '1.5rem' }}>
          <ErrorMessage
            title="Validation Issues"
            message={
              <ul style={{ paddingLeft: '1.25rem', margin: '0.5rem 0' }}>
                {fieldIssues.map((issue, idx) => (
                  <li key={idx}>
                    {issue.path ? <strong>{Array.isArray(issue.path) ? issue.path.join('.') : issue.path}: </strong> : null}
                    {issue.message}
                  </li>
                ))}
              </ul>
            }
          />
        </div>
      )}

      {/* STEP 1: DETAILS */}
      {state.step === 1 && (
        <section className="step-content" aria-labelledby="step-1-heading">
          <h2 id="step-1-heading" className="step-heading">
            Reservation Details
          </h2>

          <div className="form-grid-2">
            <Input
              label="Check-in Date"
              type="date"
              name="startDate"
              value={state.startDate}
              min={toInputDateFormat(new Date())}
              onChange={(e) => setState((prev) => ({ ...prev, startDate: e.target.value }))}
              required
            />
            <Input
              label="Check-out Date"
              type="date"
              name="endDate"
              value={state.endDate}
              min={state.startDate || toInputDateFormat(new Date())}
              onChange={(e) => setState((prev) => ({ ...prev, endDate: e.target.value }))}
              required
            />
          </div>

          <Input
            label={`Number of Guests (Max ${property.capacity})`}
            type="number"
            name="guestCount"
            min={1}
            max={property.capacity}
            value={state.guestCount}
            onChange={(e) => setState((prev) => ({ ...prev, guestCount: parseInt(e.target.value, 10) || 1 }))}
            required
          />

          {isCheckingAvailability ? (
            <p className="availability-alert" style={{ color: 'var(--color-text-secondary)' }}>
              Checking property availability...
            </p>
          ) : isPropertyAvailable ? (
            <div className="availability-alert available">
              <strong>Available:</strong> The property is open for reservation on these dates.
            </div>
          ) : (
            <div className="availability-alert unavailable">
              <strong>Unavailable:</strong> These dates are already booked. Please choose different dates.
            </div>
          )}

          <div className="step-actions">
            <Button variant="outline" onClick={() => navigate(`/properties/${propertyId}`)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleProceedToServices}
              disabled={!isPropertyAvailable || isCheckingAvailability}
            >
              Continue to Services
            </Button>
          </div>
        </section>
      )}

      {/* STEP 2: SERVICES */}
      {state.step === 2 && (
        <section className="step-content" aria-labelledby="step-2-heading">
          <h2 id="step-2-heading" className="step-heading">
            Add Event Services (Optional)
          </h2>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: '1.5rem' }}>
            Enhance your event with catering, decoration, music, or other services.
          </p>

          {isServicesLoading ? (
            <Spinner message="Loading available services..." />
          ) : (
            <div className="services-selection-list">
              {(servicesData?.items || []).map((service) => {
                const isSelected = state.selectedServices.some((s) => s.serviceId === service.id);
                const selectedItem = state.selectedServices.find((s) => s.serviceId === service.id);

                return (
                  <div
                    key={service.id}
                    className={`service-select-card ${isSelected ? 'selected' : ''}`}
                  >
                    <div className="service-card-top">
                      <div className="service-card-info">
                        <h4>{service.title}</h4>
                        <p>{service.description}</p>
                        <div style={{ marginTop: '0.25rem' }}>
                          <Badge variant="neutral">{service.category}</Badge>{' '}
                          <Badge variant={service.kind === 'exclusive' ? 'accent' : 'neutral'}>
                            {service.kind === 'exclusive' ? 'Exclusive' : `Capacity: ${service.capacity || 'Open'}`}
                          </Badge>
                        </div>
                      </div>
                      <div className="service-card-price">
                        {formatMoney(service.price_minor, service.currency)}
                      </div>
                    </div>

                    <div className="service-card-controls">
                      <Button
                        variant={isSelected ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => handleToggleService(service)}
                      >
                        {isSelected ? 'Remove' : 'Add to Booking'}
                      </Button>

                      {isSelected && (
                        <>
                          <div className="service-control-group">
                            <label htmlFor={`qty-${service.id}`}>Quantity:</label>
                            <input
                              id={`qty-${service.id}`}
                              type="number"
                              min={1}
                              max={service.capacity || 10}
                              value={selectedItem?.quantity || 1}
                              onChange={(e) => handleUpdateServiceQuantity(service.id, e.target.value)}
                              style={{ width: '4rem', padding: '0.25rem 0.5rem', borderRadius: '4px', border: '1px solid var(--color-border-subtle)' }}
                            />
                          </div>

                          {service.kind === 'capacity' && (
                            <div className="service-control-group">
                              <label htmlFor={`slot-${service.id}`}>Slot Date:</label>
                              <select
                                id={`slot-${service.id}`}
                                value={selectedItem?.slot || ''}
                                onChange={(e) => handleUpdateServiceSlot(service.id, e.target.value)}
                                style={{ padding: '0.25rem 0.5rem', borderRadius: '4px', border: '1px solid var(--color-border-subtle)' }}
                                required
                              >
                                {dateOptions.map((d) => (
                                  <option key={d} value={d}>
                                    {d}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="step-actions">
            <Button variant="outline" onClick={() => goToStep(1)}>
              Back
            </Button>
            <Button variant="primary" onClick={handleProceedToReview} disabled={isHolding}>
              {isHolding ? 'Preparing Review...' : 'Continue to Review'}
            </Button>
          </div>
        </section>
      )}

      {/* STEP 3: REVIEW */}
      {state.step === 3 && state.order && (
        <section className="step-content" aria-labelledby="step-3-heading">
          <h2 id="step-3-heading" className="step-heading">
            Review Order
          </h2>

          <table className="review-summary-table" aria-label="Order summary">
            <thead>
              <tr>
                <th scope="col">Item Description</th>
                <th scope="col">Price</th>
              </tr>
            </thead>
            <tbody>
              {state.order.items?.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.title || (item.resource_type === 'PROPERTY' ? property.title : item.resource_id)}</strong>
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                      {item.resource_type === 'PROPERTY' ? (
                        <>Guests: {state.guestCount} | {state.startDate} to {state.endDate} ({item.quantity} day(s))</>
                      ) : (
                        <>Qty: {item.quantity}{item.slot ? ` | Slot: ${item.slot}` : ''}</>
                      )}
                    </div>
                  </td>
                  <td>
                    {formatMoney(item.unit_price_minor ?? item.price_minor, state.order.currency)}
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                      {' '}× {item.quantity}
                    </span>
                  </td>
                </tr>
              ))}
              <tr className="review-total-row">
                <th scope="row">Order Total</th>
                <td className="review-total-amount">
                  {formatMoney(state.order.total_amount_minor ?? state.order.total_minor, state.order.currency)}
                </td>
              </tr>
            </tbody>
          </table>

          <p className="server-verified-note">
            ✓ Line items and total are authoritatively verified and locked by the server.
          </p>

          <div className="step-actions">
            <Button variant="outline" onClick={() => goToStep(2)}>
              Back to Services
            </Button>
            <Button variant="primary" onClick={() => handleProceedToHoldAndPay()} disabled={isHolding}>
              {isHolding ? 'Securing Hold...' : 'Proceed to Hold & Pay'}
            </Button>
          </div>
        </section>
      )}

      {/* STEP 4: HOLD & PAY */}
      {state.step === 4 && (
        <section className="step-content" aria-labelledby="step-4-heading">
          <h2 id="step-4-heading" className="step-heading">
            Reservation Hold & Payment
          </h2>

          <div className="hold-timer-container">
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              Inventory Hold Remaining Time:
            </span>
            <div
              className={`hold-timer-clock ${remainingSeconds < 60 ? 'expiring' : ''}`}
              aria-label={`Time remaining: ${formatRemainingTime(remainingSeconds)}`}
            >
              {formatRemainingTime(remainingSeconds)}
            </div>
            <p className="hold-instructions">
              {remainingSeconds > 0
                ? 'Your inventory is locked. Complete payment before the countdown ends.'
                : 'Hold has expired. Please refresh the hold to continue.'}
            </p>

            {remainingSeconds <= 0 && (
              <div style={{ marginTop: '1rem' }}>
                <Button
                  variant="primary"
                  onClick={() => handleProceedToHoldAndPay()}
                  disabled={isHolding}
                >
                  {isHolding ? 'Refreshing Hold...' : 'Refresh Hold'}
                </Button>
              </div>
            )}
          </div>

          <div className="payment-simulation-box">
            <h3 style={{ fontSize: 'var(--font-size-base)', fontWeight: 'bold', marginBottom: '0.5rem' }}>
              Test Mode Payment
            </h3>
            <p>
              In accordance with Nestly safety guidelines, no real credit cards or paid gateways are used.
              Clicking Confirm & Pay simulates an authorized payment transaction for your order reference.
            </p>
          </div>

          <div className="step-actions">
            <Button variant="outline" onClick={() => goToStep(3)} disabled={isPaying}>
              Back to Review
            </Button>
            <Button
              variant="primary"
              onClick={handlePayOrder}
              disabled={isPaying || remainingSeconds <= 0}
            >
              {isPaying ? 'Processing Payment...' : `Confirm & Pay ${formatMoney(state.order?.total_amount_minor ?? state.order?.total_minor, state.order?.currency)}`}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

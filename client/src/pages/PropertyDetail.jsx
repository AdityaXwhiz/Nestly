import { useState, useMemo, useId } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { propertiesApi } from '../api/properties.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Card } from '../components/common/Card.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Button } from '../components/common/Button.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import { formatMoney } from '../utils/money.js';
import {
  getUserTimeZone,
  formatDate,
  toInputDateFormat,
  toIsoWithLocalOffset,
} from '../utils/date.js';
import './PropertyDetail.css';

export function PropertyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  // Date picker state for availability checking
  const todayStr = useMemo(() => toInputDateFormat(new Date()), []);
  const maxDateStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 90);
    return toInputDateFormat(d);
  }, []);

  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');

  // Fetch property details
  const {
    data: property,
    isLoading: isPropertyLoading,
    isError: isPropertyError,
    error: propertyError,
  } = useQuery({
    queryKey: ['property', id],
    queryFn: () => propertiesApi.getPropertyById(id),
    enabled: Boolean(id),
  });

  // Date range validation (Change #8: native inputs, max 90 days, ISO with local offset)
  const dateValidation = useMemo(() => {
    if (!checkIn || !checkOut) {
      return { isValid: false, error: null };
    }

    const inDate = new Date(checkIn);
    const outDate = new Date(checkOut);

    if (inDate >= outDate) {
      return { isValid: false, error: 'Check-out date must be after check-in date.' };
    }

    const diffDays = Math.round((outDate - inDate) / (1000 * 60 * 60 * 24));
    if (diffDays > 90) {
      return { isValid: false, error: 'Availability check window cannot exceed 90 days.' };
    }

    return {
      isValid: true,
      error: null,
      fromIso: toIsoWithLocalOffset(checkIn, false),
      toIso: toIsoWithLocalOffset(checkOut, true),
      daysCount: diffDays,
    };
  }, [checkIn, checkOut]);

  // Fetch availability if dates are selected and valid
  const {
    data: availability,
    isLoading: isAvailLoading,
    isError: isAvailError,
    error: availError,
  } = useQuery({
    queryKey: ['property-availability', id, dateValidation.fromIso, dateValidation.toIso],
    queryFn: () =>
      propertiesApi.getPropertyAvailability(id, dateValidation.fromIso, dateValidation.toIso),
    enabled: Boolean(id && dateValidation.isValid && dateValidation.fromIso && dateValidation.toIso),
  });

  const unavailableRanges = availability?.unavailable_ranges || [];
  const isAvailable = dateValidation.isValid && !isAvailLoading && unavailableRanges.length === 0;
  const hasConflict = dateValidation.isValid && !isAvailLoading && unavailableRanges.length > 0;

  const images = property?.images || [];
  const activeImage = images[selectedImageIndex] || (property?.cover_image_url ? { url: property.cover_image_url } : null);

  const timeZone = getUserTimeZone();
  const checkInInputId = useId();
  const checkOutInputId = useId();

  if (isPropertyLoading) {
    return (
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
        <span className="sr-only">Loading property details...</span>
      </div>
    );
  }

  if (isPropertyError || !property) {
    return (
      <div style={{ maxWidth: '600px', margin: 'var(--space-8) auto' }}>
        <ErrorMessage
          title="Property Not Found"
          message={propertyError?.message || 'This property is not available or does not exist.'}
          requestId={propertyError?.requestId}
        />
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Link to="/properties" className="btn btn-outline">
            Return to Properties
          </Link>
        </div>
      </div>
    );
  }

  const handleStartBooking = () => {
    navigate(`/book/${property.id}${checkIn && checkOut ? `?from=${checkIn}&to=${checkOut}` : ''}`);
  };

  return (
    <div className="property-detail-page">
      <div>
        <Link to="/properties" className="back-link">
          ← Back to all properties
        </Link>
      </div>

      <div className="detail-layout">
        {/* Main Content: Gallery, Title, Description, Amenities */}
        <div className="detail-main">
          {/* Image Gallery */}
          <section className="gallery-container" aria-label="Property Images">
            <div className="gallery-main-image-wrap">
              {activeImage?.url ? (
                <img
                  src={activeImage.url}
                  alt={property.title}
                  loading="lazy"
                  className="gallery-main-image"
                />
              ) : (
                <div className="gallery-placeholder">
                  <span>[No images available]</span>
                </div>
              )}
            </div>

            {images.length > 1 && (
              <div className="gallery-thumbnails" role="group" aria-label="Image thumbnails">
                {images.map((img, idx) => (
                  <button
                    key={img.id || idx}
                    type="button"
                    className={`gallery-thumb-btn ${idx === selectedImageIndex ? 'active' : ''}`}
                    onClick={() => setSelectedImageIndex(idx)}
                    aria-label={`Show image ${idx + 1}`}
                  >
                    <img
                      src={img.url}
                      alt={`${property.title} preview ${idx + 1}`}
                      loading="lazy"
                      className="gallery-thumb-img"
                    />
                  </button>
                ))}
              </div>
            )}
          </section>

          <header className="detail-header">
            <span className="detail-location">{property.location}</span>
            <h1 className="detail-title">{property.title}</h1>
            <div className="detail-badges">
              <Badge variant="accent">{property.capacity} guests</Badge>
              <Badge variant="neutral">Entire Property</Badge>
            </div>
          </header>

          <section className="detail-section" aria-label="Description">
            <h2 className="detail-section-title">About this property</h2>
            <p className="detail-description">{property.description}</p>
          </section>

          {property.amenities && property.amenities.length > 0 && (
            <section className="detail-section" aria-label="Amenities">
              <h2 className="detail-section-title">Amenities offered</h2>
              <div className="amenities-grid">
                {property.amenities.map((amenity) => (
                  <div key={amenity} className="amenity-item">
                    <span>{amenity.replace('_', ' ')}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Sidebar: Price and Availability Checker */}
        <aside className="detail-sidebar" aria-label="Booking and Availability">
          <Card className="booking-card">
            <div className="booking-price-header">
              <span className="booking-price-amount">
                {formatMoney(property.pricing_minor)}
              </span>
              <span className="booking-price-unit"> / day</span>
            </div>

            <section className="availability-form" aria-label="Check Availability">
              <h2 style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, margin: 0 }}>
                Check Availability
              </h2>

              <div className="date-inputs-row">
                <div className="input-group">
                  <label htmlFor={checkInInputId} className="input-label">
                    Check-in
                  </label>
                  <input
                    id={checkInInputId}
                    type="date"
                    className="input-control"
                    min={todayStr}
                    max={maxDateStr}
                    value={checkIn}
                    onChange={(e) => setCheckIn(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label htmlFor={checkOutInputId} className="input-label">
                    Check-out
                  </label>
                  <input
                    id={checkOutInputId}
                    type="date"
                    className="input-control"
                    min={checkIn || todayStr}
                    max={maxDateStr}
                    value={checkOut}
                    onChange={(e) => setCheckOut(e.target.value)}
                  />
                </div>
              </div>

              <p className="tz-disclaimer">
                All dates and times are shown in your local time zone ({timeZone}). Calendar availability is indicative and secured upon reservation hold.
              </p>

              {dateValidation.error && (
                <span className="input-error" role="alert">
                  {dateValidation.error}
                </span>
              )}

              {isAvailLoading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <Spinner size="sm" />
                  <span style={{ fontSize: 'var(--font-size-xs)' }}>Checking availability...</span>
                </div>
              )}

              {isAvailError && (
                <ErrorMessage
                  message={availError?.message || 'Could not verify dates.'}
                  requestId={availError?.requestId}
                />
              )}

              {isAvailable && (
                <div className="availability-status available" role="status">
                  <strong>Available:</strong> Selected dates are currently open for booking.
                </div>
              )}

              {hasConflict && (
                <div className="availability-status conflict" role="status">
                  <strong>Dates Unavailable:</strong> Conflict with existing reservation:
                  <ul className="unavailable-list">
                    {unavailableRanges.map((range, i) => (
                      <li key={i}>
                        {formatDate(range.start)} – {formatDate(range.end)} ({range.reason})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <Button
                variant="primary"
                fullWidth
                onClick={handleStartBooking}
                disabled={hasConflict}
              >
                Start Booking
              </Button>

              {isAuthenticated && user?.role !== 'CUSTOMER' && (
                <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: 0 }}>
                  Note: Signed in as {user.role}. Booking checkout is restricted to Customer accounts.
                </p>
              )}
            </section>
          </Card>
        </aside>
      </div>
    </div>
  );
}

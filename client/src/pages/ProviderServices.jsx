import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { servicesApi } from '../api/services.js';
import { formatMoney } from '../utils/money.js';
import { getFriendlyErrorMessage } from '../utils/errors.js';
import { Button } from '../components/common/Button.jsx';
import { Input } from '../components/common/Input.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { EmptyState } from '../components/common/EmptyState.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import './ProviderServices.css';

const SERVICE_CATEGORIES = [
  'catering',
  'decoration',
  'cake',
  'photography',
  'music',
  'other',
];

export function ProviderServices() {
  const queryClient = useQueryClient();

  // Load provider profile (Change #5)
  const {
    data: providerProfile,
    isLoading: isProfileLoading,
  } = useQuery({
    queryKey: ['provider-profile'],
    queryFn: () => servicesApi.getMyProviderProfile(),
  });

  // Load provider's services
  const {
    data: services,
    isLoading: isServicesLoading,
  } = useQuery({
    queryKey: ['provider-services'],
    queryFn: () => servicesApi.getMyServices(),
    enabled: !!providerProfile,
  });

  // Business profile form state
  const [profileForm, setProfileForm] = useState({
    business_name: '',
    bio: '',
  });
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [profileFormError, setProfileFormError] = useState(null);

  // New service form state
  const [serviceForm, setServiceForm] = useState({
    title: '',
    description: '',
    category: 'catering',
    kind: 'exclusive',
    price_major: 2500,
    capacity: 10,
  });
  const [isCreatingService, setIsCreatingService] = useState(false);
  const [serviceFormError, setServiceFormError] = useState(null);
  const [serviceSuccess, setServiceSuccess] = useState(null);

  // Profile creation handler
  const handleCreateProfile = async (e) => {
    e.preventDefault();
    setProfileFormError(null);
    setIsCreatingProfile(true);

    try {
      await servicesApi.createProviderProfile({
        business_name: profileForm.business_name.trim(),
        bio: profileForm.bio.trim() || undefined,
      });
      queryClient.invalidateQueries(['provider-profile']);
    } catch (err) {
      setProfileFormError(getFriendlyErrorMessage(err));
    } finally {
      setIsCreatingProfile(false);
    }
  };

  // Service creation handler
  const handleCreateService = async (e) => {
    e.preventDefault();
    setServiceFormError(null);
    setServiceSuccess(null);
    setIsCreatingService(true);

    const payload = {
      title: serviceForm.title.trim(),
      description: serviceForm.description.trim(),
      category: serviceForm.category,
      kind: serviceForm.kind,
      price_minor: Math.round(Number(serviceForm.price_major) * 100),
      capacity: serviceForm.kind === 'capacity' ? parseInt(serviceForm.capacity, 10) : undefined,
    };

    try {
      await servicesApi.createService(payload);
      queryClient.invalidateQueries(['provider-services']);
      setServiceSuccess('Service created successfully!');
      setServiceForm({
        title: '',
        description: '',
        category: 'catering',
        kind: 'exclusive',
        price_major: 2500,
        capacity: 10,
      });
    } catch (err) {
      setServiceFormError(getFriendlyErrorMessage(err));
    } finally {
      setIsCreatingService(false);
    }
  };

  if (isProfileLoading) {
    return (
      <div className="container" style={{ padding: '4rem 0', textAlign: 'center' }}>
        <Spinner size="lg" message="Loading provider dashboard..." />
      </div>
    );
  }

  // 1. If provider profile does not exist yet (Change #5), render profile onboarding form
  if (!providerProfile) {
    return (
      <div className="container provider-services-page">
        <div className="profile-card">
          <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 'bold', marginBottom: '0.5rem' }}>
            Set Up Your Vendor Profile
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: '1.5rem' }}>
            Before offering catering, music, decoration, or photography on Nestly, register your vendor business name.
          </p>

          {profileFormError && <ErrorMessage message={profileFormError} />}

          <form onSubmit={handleCreateProfile} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <Input
              label="Business / Brand Name"
              name="business_name"
              value={profileForm.business_name}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, business_name: e.target.value }))}
              placeholder="e.g. Royal Catering & Decor Co."
              required
            />

            <div>
              <label
                htmlFor="provider-bio"
                style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: '500', marginBottom: '0.5rem' }}
              >
                Business Bio (Optional)
              </label>
              <textarea
                id="provider-bio"
                rows={3}
                value={profileForm.bio}
                onChange={(e) => setProfileForm((prev) => ({ ...prev, bio: e.target.value }))}
                placeholder="Tell customers about your event experience, services offered, and team..."
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-subtle)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--font-size-base)',
                }}
              />
            </div>

            <div>
              <Button variant="primary" type="submit" disabled={isCreatingProfile}>
                {isCreatingProfile ? 'Creating Profile...' : 'Complete Vendor Profile'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="container provider-services-page">
      <div className="provider-header">
        <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 'bold' }}>
          Vendor Dashboard: {providerProfile.business_name}
        </h1>
        {providerProfile.bio && (
          <p style={{ color: 'var(--color-text-secondary)', marginTop: '0.25rem' }}>
            {providerProfile.bio}
          </p>
        )}
      </div>

      {/* Services List */}
      <section aria-labelledby="my-services-heading">
        <h2 id="my-services-heading" style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'bold', marginBottom: '1rem' }}>
          My Services ({services?.length || 0})
        </h2>

        {isServicesLoading ? (
          <Spinner message="Loading services..." />
        ) : (!services || services.length === 0) ? (
          <EmptyState
            title="No services added yet"
            message="Add your first event service below to allow organizers to bundle it with venue bookings."
          />
        ) : (
          <div className="services-list-container">
            {services.map((svc) => (
              <div key={svc.id} className="provider-service-card">
                <div>
                  <h3 style={{ fontSize: 'var(--font-size-base)', fontWeight: 'bold', margin: '0 0 0.25rem' }}>
                    {svc.title}
                  </h3>
                  <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: '0 0 0.5rem' }}>
                    {svc.description}
                  </p>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <Badge variant="neutral">{svc.category}</Badge>
                    <Badge variant={svc.kind === 'exclusive' ? 'accent' : 'neutral'}>
                      {svc.kind === 'exclusive' ? 'Exclusive' : `Capacity: ${svc.capacity || 'N/A'}`}
                    </Badge>
                    <Badge variant={svc.status === 'ACTIVE' ? 'accent' : 'neutral'}>
                      {svc.status}
                    </Badge>
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 'bold', color: 'var(--color-accent)' }}>
                    {formatMoney(svc.price_minor, svc.currency)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Add New Service Panel */}
      <section className="add-service-panel" aria-labelledby="add-service-heading">
        <h2 id="add-service-heading" style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'bold', marginBottom: '1.5rem' }}>
          Add New Event Service
        </h2>

        {serviceFormError && <ErrorMessage message={serviceFormError} />}
        {serviceSuccess && (
          <div style={{ padding: '0.75rem 1rem', background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', borderRadius: 'var(--radius-md)', marginBottom: '1rem' }}>
            {serviceSuccess}
          </div>
        )}

        <form onSubmit={handleCreateService} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <Input
            label="Service Title"
            name="title"
            value={serviceForm.title}
            onChange={(e) => setServiceForm((prev) => ({ ...prev, title: e.target.value }))}
            placeholder="e.g. Traditional Wedding Catering Package"
            required
          />

          <div>
            <label
              htmlFor="service-description"
              style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: '500', marginBottom: '0.5rem' }}
            >
              Description
            </label>
            <textarea
              id="service-description"
              rows={3}
              value={serviceForm.description}
              onChange={(e) => setServiceForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="Explain menus, equipment, set-up details, or musician arrangements..."
              style={{
                width: '100%',
                padding: '0.75rem',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border-subtle)',
                fontFamily: 'inherit',
                fontSize: 'var(--font-size-base)',
              }}
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
            <div>
              <label
                htmlFor="service-category"
                style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: '500', marginBottom: '0.5rem' }}
              >
                Category
              </label>
              <select
                id="service-category"
                value={serviceForm.category}
                onChange={(e) => setServiceForm((prev) => ({ ...prev, category: e.target.value }))}
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-subtle)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--font-size-base)',
                  backgroundColor: 'var(--color-bg-surface)',
                }}
              >
                {SERVICE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="service-kind"
                style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: '500', marginBottom: '0.5rem' }}
              >
                Booking Type
              </label>
              <select
                id="service-kind"
                value={serviceForm.kind}
                onChange={(e) => setServiceForm((prev) => ({ ...prev, kind: e.target.value }))}
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-subtle)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--font-size-base)',
                  backgroundColor: 'var(--color-bg-surface)',
                }}
              >
                <option value="exclusive">Exclusive (1 booking per date)</option>
                <option value="capacity">Capacity-based (Slots & capacity)</option>
              </select>
            </div>

            <Input
              label="Price (INR ₹)"
              type="number"
              min={1}
              value={serviceForm.price_major}
              onChange={(e) => setServiceForm((prev) => ({ ...prev, price_major: e.target.value }))}
              required
            />
          </div>

          {serviceForm.kind === 'capacity' && (
            <Input
              label="Maximum Capacity per Slot"
              type="number"
              min={1}
              value={serviceForm.capacity}
              onChange={(e) => setServiceForm((prev) => ({ ...prev, capacity: e.target.value }))}
              required
            />
          )}

          <div>
            <Button variant="primary" type="submit" disabled={isCreatingService}>
              {isCreatingService ? 'Creating Service...' : 'Add Service'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

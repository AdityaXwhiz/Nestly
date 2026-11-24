import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { propertiesApi } from '../api/properties.js';
import { uploadFileWithProgress } from '../utils/upload.js';
import { getFriendlyErrorMessage } from '../utils/errors.js';
import { Button } from '../components/common/Button.jsx';
import { Input } from '../components/common/Input.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import './HostPropertyForm.css';

export function HostPropertyForm() {
  const { id: propertyId } = useParams();
  const isNew = !propertyId || propertyId === 'new';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef(null);

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    location: '',
    capacity: 2,
    price_major: 1000,
    status: 'ACTIVE',
  });

  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  // Image upload state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [imageError, setImageError] = useState(null);

  // Load existing property data (via /properties/mine so INACTIVE properties also load cleanly)
  const { data: property, isLoading } = useQuery({
    queryKey: ['property-edit', propertyId],
    queryFn: async () => {
      const mine = await propertiesApi.getMyProperties();
      const found = mine.find((p) => p.id === propertyId);
      return found || propertiesApi.getPropertyById(propertyId);
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (property) {
      const minor = property.pricing_minor ?? property.price_minor;
      setFormData({
        title: property.title || '',
        description: property.description || '',
        location: property.location || '',
        capacity: property.capacity || 2,
        price_major: minor ? minor / 100 : 1000,
        status: property.status || 'ACTIVE',
      });
    }
  }, [property]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSaving(true);

    const payload = {
      title: formData.title.trim(),
      description: formData.description.trim(),
      location: formData.location.trim(),
      capacity: parseInt(formData.capacity, 10),
      pricing_minor: Math.round(Number(formData.price_major) * 100),
      status: formData.status,
    };

    try {
      if (isNew) {
        const created = await propertiesApi.createProperty(payload);
        queryClient.invalidateQueries(['host-properties']);
        navigate(`/host/properties/${created.id}`);
      } else {
        await propertiesApi.updateProperty(propertyId, payload);
        queryClient.invalidateQueries(['host-properties']);
        queryClient.invalidateQueries(['property-edit', propertyId]);
        setSuccessMessage('Property updated successfully.');
      }
    } catch (err) {
      setErrorMessage(getFriendlyErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  // 3-step presigned image upload flow (Change #6)
  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file || isNew) return;

    setImageError(null);

    // Client-side validation: max 5 MB, allowed types
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setImageError('Only JPEG, PNG, and WebP images are allowed.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setImageError('Image size cannot exceed 5 MB.');
      return;
    }

    try {
      setIsUploading(true);
      setUploadPercent(0);

      // Step 1: Request presigned upload URL
      const { upload_url, image_id } = await propertiesApi.requestImageUploadUrl(propertyId, {
        content_type: file.type,
        size_bytes: file.size,
      });

      // Step 2: Upload directly to S3 / MinIO via XMLHttpRequest with progress (Change #6)
      await uploadFileWithProgress({
        uploadUrl: upload_url,
        file,
        onProgress: (pct) => setUploadPercent(pct),
      });

      // Step 3: Confirm uploaded object
      await propertiesApi.confirmPropertyImage(propertyId, image_id);

      // Reset and refetch
      queryClient.invalidateQueries(['property-edit', propertyId]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setImageError(getFriendlyErrorMessage(err));
    } finally {
      setIsUploading(false);
      setUploadPercent(0);
    }
  };

  const handleDeleteImage = async (imageId) => {
    if (!confirm('Are you sure you want to delete this photo?')) return;
    try {
      await propertiesApi.deletePropertyImage(propertyId, imageId);
      queryClient.invalidateQueries(['property-edit', propertyId]);
    } catch (err) {
      setImageError(getFriendlyErrorMessage(err));
    }
  };

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '4rem 0', textAlign: 'center' }}>
        <Spinner size="lg" message="Loading property details..." />
      </div>
    );
  }

  const images = property?.images || [];

  return (
    <div className="container property-form-page">
      <div style={{ marginBottom: '1.5rem' }}>
        <Link to="/host/properties" className="btn btn-outline" style={{ fontSize: 'var(--font-size-xs)' }}>
          ← Back to My Properties
        </Link>
      </div>

      <div className="property-form-card">
        <div>
          <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 'bold' }}>
            {isNew ? 'Create New Property Listing' : `Edit: ${property?.title || 'Property'}`}
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginTop: '0.25rem' }}>
            {isNew
              ? 'Enter property specifications to publish your venue.'
              : 'Update details, manage status, and upload venue photos.'}
          </p>
        </div>

        {errorMessage && <ErrorMessage message={errorMessage} />}
        {successMessage && (
          <div style={{ padding: '0.75rem 1rem', background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', borderRadius: 'var(--radius-md)' }}>
            {successMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <Input
            label="Property Title"
            name="title"
            value={formData.title}
            onChange={handleChange}
            placeholder="e.g. Sunset Villa & Event Grounds"
            required
          />

          <div>
            <label
              htmlFor="description"
              style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: '500', marginBottom: '0.5rem' }}
            >
              Description
            </label>
            <textarea
              id="description"
              name="description"
              rows={4}
              value={formData.description}
              onChange={handleChange}
              placeholder="Describe your venue features, spaces, and amenities..."
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Input
              label="Location / City"
              name="location"
              value={formData.location}
              onChange={handleChange}
              placeholder="e.g. Goa, Mumbai, Delhi"
              required
            />
            <Input
              label="Guest Capacity"
              name="capacity"
              type="number"
              min={1}
              value={formData.capacity}
              onChange={handleChange}
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Input
              label="Price per Day (INR ₹)"
              name="price_major"
              type="number"
              min={1}
              value={formData.price_major}
              onChange={handleChange}
              required
            />

            <div>
              <label
                htmlFor="status"
                style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: '500', marginBottom: '0.5rem' }}
              >
                Listing Status
              </label>
              <select
                id="status"
                name="status"
                value={formData.status}
                onChange={handleChange}
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
                <option value="ACTIVE">ACTIVE (Visible in search)</option>
                <option value="INACTIVE">INACTIVE (Hidden)</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
            <Button variant="outline" type="button" onClick={() => navigate('/host/properties')}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isSaving}>
              {isSaving ? 'Saving...' : isNew ? 'Create Property' : 'Save Changes'}
            </Button>
          </div>
        </form>

        {/* IMAGE UPLOAD & GALLERY (for existing properties) */}
        {!isNew && (
          <section className="image-upload-section" aria-labelledby="images-heading">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 id="images-heading" style={{ fontSize: 'var(--font-size-lg)', fontWeight: 'bold' }}>
                  Property Photos ({images.length} / 10)
                </h2>
                <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                  JPEG, PNG, or WebP up to 5 MB. First photo is displayed as cover.
                </p>
              </div>
            </div>

            {imageError && (
              <div style={{ marginTop: '1rem' }}>
                <ErrorMessage message={imageError} />
              </div>
            )}

            {/* Gallery grid */}
            {images.length > 0 && (
              <div className="image-gallery-grid">
                {images.map((img) => (
                  <div key={img.id} className="image-thumbnail-card">
                    <img src={img.url} alt="Property venue" loading="lazy" />
                    <button
                      type="button"
                      className="image-delete-btn"
                      onClick={() => handleDeleteImage(img.id)}
                      aria-label="Delete image"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Upload Zone */}
            {images.length < 10 && (
              <div style={{ marginTop: '1.5rem' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                  id="property-file-input"
                  disabled={isUploading}
                />
                <label
                  htmlFor="property-file-input"
                  className="upload-dropzone"
                  style={{ display: 'block' }}
                >
                  <p style={{ margin: 0, fontWeight: '500', color: 'var(--color-accent)' }}>
                    {isUploading ? 'Uploading Image...' : '+ Click to choose a photo to upload'}
                  </p>
                  <p style={{ margin: '0.25rem 0 0', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                    Direct presigned upload to secure storage
                  </p>
                </label>

                {isUploading && (
                  <div className="upload-progress-bar" role="progressbar" aria-valuenow={uploadPercent} aria-valuemin={0} aria-valuemax={100}>
                    <div
                      className="upload-progress-fill"
                      style={{ width: `${uploadPercent}%` }}
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

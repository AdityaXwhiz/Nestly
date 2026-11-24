import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Card } from '../components/common/Card.jsx';
import { Badge } from '../components/common/Badge.jsx';

export function BookPlaceholder() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  return (
    <div style={{ maxWidth: '600px', margin: 'var(--space-8) auto' }}>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, margin: 0 }}>
            Reserve Property
          </h1>
          <Badge variant="accent">Customer Only</Badge>
        </div>

        <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
          Property reference: <code>{id}</code>
        </p>

        {from && to && (
          <div
            style={{
              padding: 'var(--space-3)',
              backgroundColor: 'var(--color-bg)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            <strong>Selected Dates:</strong> {from} to {to}
          </div>
        )}

        <div
          style={{
            padding: 'var(--space-4)',
            backgroundColor: '#f8fafc',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-main)',
            lineHeight: 1.6,
          }}
        >
          <strong>Step 12A Checkpoint:</strong>
          <br />
          Full multi-item checkout (property reservation hold, event service add-ons, price snapshot validation, and test payment gateway) will be wired in Step 12B.
        </div>

        <div>
          <Link to={`/properties/${id}`} className="btn btn-primary">
            Back to property details
          </Link>
        </div>
      </Card>
    </div>
  );
}

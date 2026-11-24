import { Link } from 'react-router-dom';
import { EmptyState } from '../components/common/EmptyState.jsx';

export function NotFound() {
  return (
    <div style={{ maxWidth: '500px', margin: 'var(--space-12) auto' }}>
      <EmptyState
        title="Page not found (404)"
        description="The page you requested does not exist or has been moved."
      >
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Link to="/properties" className="btn btn-primary">
            Back to Properties
          </Link>
        </div>
      </EmptyState>
    </div>
  );
}

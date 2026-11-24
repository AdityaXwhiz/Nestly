import { Navigate, Outlet, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Spinner } from '../components/common/Spinner.jsx';
import { Card } from '../components/common/Card.jsx';

export function RouteLoadingScreen() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '200px',
        padding: 'var(--space-8)',
      }}
    >
      <Spinner size="lg" />
      <span className="sr-only">Verifying session...</span>
    </div>
  );
}

/**
 * Route guard that requires user to be logged in.
 * Waits for auth bootstrap to complete before redirecting (Change #2).
 */
export function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <RouteLoadingScreen />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}

/**
 * Route guard that enforces specific role membership (Change #9).
 * If user has a different role, displays a clear, friendly role guidance card.
 */
export function RoleRoute({ allowedRoles = ['CUSTOMER'] }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <RouteLoadingScreen />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!allowedRoles.includes(user.role)) {
    return (
      <div style={{ maxWidth: '540px', margin: 'var(--space-8) auto' }}>
        <Card>
          <h2 style={{ fontSize: 'var(--font-size-xl)', marginBottom: 'var(--space-2)' }}>
            Customer Access Required
          </h2>
          <p style={{ marginBottom: 'var(--space-4)' }}>
            Booking is only available to customer accounts. You are currently signed in as a <strong>{user.role}</strong> ({user.email}).
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Link to="/properties" className="btn btn-primary">
              Browse Properties
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return <Outlet />;
}

/**
 * Route guard for guest-only pages (e.g. login, register).
 * Redirects already authenticated users to /properties.
 */
export function GuestRoute() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <RouteLoadingScreen />;
  }

  if (isAuthenticated) {
    return <Navigate to="/properties" replace />;
  }

  return <Outlet />;
}

import { useState, useId } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Card } from '../components/common/Card.jsx';
import { Input } from '../components/common/Input.jsx';
import { Button } from '../components/common/Button.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import './Auth.css';

export function Login() {
  const { login, sessionExpiredMessage, clearSessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState(null);
  const [requestId, setRequestId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const emailId = useId();
  const passwordId = useId();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    setRequestId(null);

    if (!email || !password) {
      setFormError('Please enter both email and password.');
      return;
    }

    setIsSubmitting(true);
    try {
      await login({ email, password });
      clearSessionExpired();
      const redirectTarget = location.state?.from?.pathname || '/properties';
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      // Change #1: A 401 from /auth/login shows an inline error, never a session-expired redirect
      setFormError(err.message || 'Invalid email or password.');
      setRequestId(err.requestId || null);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-header">
        <h1 className="auth-title">Welcome back</h1>
        <p className="auth-subtitle">Sign in to your Nestly account</p>
      </div>

      {sessionExpiredMessage && (
        <div
          style={{
            padding: 'var(--space-3)',
            backgroundColor: '#fef3c7',
            border: '1px solid #f59e0b',
            borderRadius: 'var(--radius-md)',
            color: '#92400e',
            fontSize: 'var(--font-size-sm)',
          }}
          role="status"
        >
          {sessionExpiredMessage}
        </div>
      )}

      <Card className="auth-card">
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {formError && (
            <ErrorMessage
              message={formError}
              requestId={requestId}
            />
          )}

          <Input
            id={emailId}
            label="Email address"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <Input
            id={passwordId}
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <Button type="submit" variant="primary" fullWidth loading={isSubmitting}>
            Sign in
          </Button>

          <p className="auth-footer-link">
            Don&apos;t have an account?{' '}
            <Link to="/register" className="auth-link">
              Create an account
            </Link>
          </p>
        </form>
      </Card>
    </div>
  );
}

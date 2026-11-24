import { useState, useId } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Card } from '../components/common/Card.jsx';
import { Input } from '../components/common/Input.jsx';
import { Select } from '../components/common/Select.jsx';
import { Button } from '../components/common/Button.jsx';
import { ErrorMessage } from '../components/common/ErrorMessage.jsx';
import './Auth.css';

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('CUSTOMER');
  const [formError, setFormError] = useState(null);
  const [requestId, setRequestId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const roleId = useId();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    setRequestId(null);

    if (!email || !password) {
      setFormError('Please fill in all required fields.');
      return;
    }

    if (password.length < 8) {
      setFormError('Password must be at least 8 characters long.');
      return;
    }

    setIsSubmitting(true);
    try {
      await register({ email, password, role });
      navigate('/properties', { replace: true });
    } catch (err) {
      setFormError(err.message || 'Registration failed. Please try again.');
      setRequestId(err.requestId || null);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-header">
        <h1 className="auth-title">Create an account</h1>
        <p className="auth-subtitle">Join Nestly to explore properties and event services</p>
      </div>

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
            label="Password (min 8 characters)"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            helperText="At least 8 characters"
            required
          />

          <Select
            id={roleId}
            label="I want to register as"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={[
              { value: 'CUSTOMER', label: 'Customer (Book venues & services)' },
              { value: 'HOST', label: 'Host (List property venues)' },
              { value: 'PROVIDER', label: 'Vendor (Offer event services)' },
            ]}
          />

          <Button type="submit" variant="primary" fullWidth loading={isSubmitting}>
            Create account
          </Button>

          <p className="auth-footer-link">
            Already have an account?{' '}
            <Link to="/login" className="auth-link">
              Sign in
            </Link>
          </p>
        </form>
      </Card>
    </div>
  );
}

import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button } from '../common/Button.jsx';
import { Badge } from '../common/Badge.jsx';
import './Header.css';

export function Header() {
  const { user, isAuthenticated, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <header className="app-header">
      <div className="container header-inner">
        <Link to="/properties" className="header-brand">
          <span className="header-logo">Nestly</span>
        </Link>

        <nav className="header-nav" aria-label="Main Navigation">
          <NavLink
            to="/properties"
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
          >
            Properties
          </NavLink>
          <NavLink
            to="/services"
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
          >
            Services
          </NavLink>
        </nav>

        <div className="header-auth">
          {isAuthenticated ? (
            <div className="user-identity">
              <span className="user-email" title={user.email}>
                {user.email}
              </span>
              <Badge variant="accent">{user.role}</Badge>
              <Button variant="outline" onClick={handleLogout}>
                Sign out
              </Button>
            </div>
          ) : (
            <>
              <Link to="/login" className="btn btn-outline">
                Sign in
              </Link>
              <Link to="/register" className="btn btn-primary">
                Register
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

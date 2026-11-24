import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute, RoleRoute, GuestRoute } from '../src/routes/Guards.jsx';
import * as AuthContextModule from '../src/context/AuthContext.jsx';

describe('Route Guards (Change #2 & Change #9)', () => {
  it('waits for auth bootstrap loading state before redirecting (Change #2)', () => {
    // Mock useAuth returning isLoading: true
    const useAuthSpy = vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      isAuthenticated: false,
      isLoading: true,
      user: null,
    });

    render(
      <MemoryRouter initialEntries={['/protected']}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/protected" element={<div>Protected Secret</div>} />
          </Route>
          <Route path="/login" element={<div>Login Page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // Shows loading spinner, does NOT immediately redirect to /login
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument();
    expect(screen.queryByText('Protected Secret')).not.toBeInTheDocument();

    useAuthSpy.mockRestore();
  });

  it('redirects unauthenticated user to /login after bootstrap finishes', () => {
    const useAuthSpy = vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      user: null,
    });

    render(
      <MemoryRouter initialEntries={['/protected']}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/protected" element={<div>Protected Secret</div>} />
          </Route>
          <Route path="/login" element={<div>Login Page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Login Page')).toBeInTheDocument();
    expect(screen.queryByText('Protected Secret')).not.toBeInTheDocument();

    useAuthSpy.mockRestore();
  });

  it('GuestRoute redirects authenticated user to /properties', () => {
    const useAuthSpy = vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { id: 'usr_1', role: 'CUSTOMER' },
    });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route element={<GuestRoute />}>
            <Route path="/login" element={<div>Login Page</div>} />
          </Route>
          <Route path="/properties" element={<div>Properties Catalog</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Properties Catalog')).toBeInTheDocument();
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument();

    useAuthSpy.mockRestore();
  });

  it('RoleRoute allows CUSTOMER to access customer-only route (Change #9)', () => {
    const useAuthSpy = vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { id: 'usr_customer', role: 'CUSTOMER', email: 'cust@example.com' },
    });

    render(
      <MemoryRouter initialEntries={['/book/prop-123']}>
        <Routes>
          <Route element={<RoleRoute allowedRoles={['CUSTOMER']} />}>
            <Route path="/book/:id" element={<div>Booking Checkout View</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Booking Checkout View')).toBeInTheDocument();

    useAuthSpy.mockRestore();
  });

  it('RoleRoute shows friendly role guidance for non-CUSTOMER accounts (Change #9)', () => {
    const useAuthSpy = vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { id: 'usr_host', role: 'HOST', email: 'host@example.com' },
    });

    render(
      <MemoryRouter initialEntries={['/book/prop-123']}>
        <Routes>
          <Route element={<RoleRoute allowedRoles={['CUSTOMER']} />}>
            <Route path="/book/:id" element={<div>Booking Checkout View</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // Displays customer access required message
    expect(screen.getByText('Customer Access Required')).toBeInTheDocument();
    expect(
      screen.getByText(/Booking is only available to customer accounts/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/HOST/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Browse Properties/i })).toBeInTheDocument();

    expect(screen.queryByText('Booking Checkout View')).not.toBeInTheDocument();

    useAuthSpy.mockRestore();
  });
});

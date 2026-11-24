import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../api/auth.js';
import {
  getStoredToken,
  setStoredToken,
  clearStoredToken,
  setOnSessionExpired,
} from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => getStoredToken());
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState(null);

  const logout = useCallback(() => {
    authApi.logout();
    setToken(null);
    setUser(null);
    clearStoredToken();
  }, []);

  // Change #1: Register session expired callback from apiFetch
  useEffect(() => {
    setOnSessionExpired(({ message }) => {
      setSessionExpiredMessage(message);
      logout();
    });
  }, [logout]);

  // Bootstrap user session from stored token (Change #2: Route guards wait for this)
  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      const stored = getStoredToken();
      if (!stored) {
        if (isMounted) setIsLoading(false);
        return;
      }

      try {
        const currentUser = await authApi.getMe();
        if (isMounted) {
          setUser(currentUser);
          setToken(stored);
        }
      } catch {
        if (isMounted) {
          // Token invalid or expired
          clearStoredToken();
          setToken(null);
          setUser(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    bootstrap();

    return () => {
      isMounted = false;
    };
  }, []);

  const login = async ({ email, password }) => {
    setSessionExpiredMessage(null);
    const data = await authApi.login({ email, password });
    setToken(data.accessToken);
    setStoredToken(data.accessToken);
    setUser(data.user);
    return data.user;
  };

  const register = async ({ email, password, role }) => {
    setSessionExpiredMessage(null);
    const registeredUser = await authApi.register({ email, password, role });
    // Automatically log in after registration
    await login({ email, password });
    return registeredUser;
  };

  const clearSessionExpired = () => {
    setSessionExpiredMessage(null);
  };

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        isLoading,
        isAuthenticated: Boolean(user && token),
        sessionExpiredMessage,
        clearSessionExpired,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

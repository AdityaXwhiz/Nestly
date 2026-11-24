import { apiFetch, setStoredToken, clearStoredToken } from './client.js';

export const authApi = {
  async register({ email, password, role }) {
    const data = await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, role }),
    });
    return data.user;
  },

  async login({ email, password }) {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (data.accessToken) {
      setStoredToken(data.accessToken);
    }
    return data;
  },

  async getMe() {
    const data = await apiFetch('/auth/me', {
      method: 'GET',
    });
    return data.user;
  },

  logout() {
    clearStoredToken();
  },
};

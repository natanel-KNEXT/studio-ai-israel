import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface AuthGateContextType {
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<string | null>;
  logout: () => void;
  loading: boolean;
}

const AuthGateContext = createContext<AuthGateContextType | null>(null);

const STORAGE_KEY = 'gate_session';

function getSession(): { token: string; expiresAt: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session.expiresAt > Date.now()) return session;
    localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

export function AuthGateProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setIsAuthenticated(!!getSession());
    setLoading(false);
  }, []);

  const login = async (username: string, password: string): Promise<string | null> => {
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(
        `https://${projectId}.supabase.co/functions/v1/auth-gate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }
      );
      const data = await res.json();
      if (!res.ok) return data.error || 'שגיאה בהתחברות';
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: data.token, expiresAt: data.expiresAt }));
      setIsAuthenticated(true);
      return null;
    } catch {
      return 'שגיאת רשת';
    }
  };

  const logout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setIsAuthenticated(false);
  };

  return (
    <AuthGateContext.Provider value={{ isAuthenticated, login, logout, loading }}>
      {children}
    </AuthGateContext.Provider>
  );
}

export function useAuthGate() {
  const ctx = useContext(AuthGateContext);
  if (!ctx) throw new Error('useAuthGate must be inside AuthGateProvider');
  return ctx;
}

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  loginRequest,
  logoutRequest,
  registerRequest,
  tryRefresh,
} from "./api";
import type { User } from "./types";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Update the caller's own reporting preferences (e.g. month start day). */
  updateProfile: (patch: { monthStartDay?: number }) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Restore the session from the refresh cookie on first load.
    void tryRefresh()
      .then(setUser)
      .finally(() => setLoading(false));
  }, []);

  const value: AuthContextValue = {
    user,
    loading,
    login: async (email, password) => setUser(await loginRequest(email, password)),
    register: async (email, password) =>
      setUser(await registerRequest(email, password)),
    logout: async () => {
      await logoutRequest();
      setUser(null);
    },
    updateProfile: async (patch) => {
      setUser(
        await api<User>("/auth/me", {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      );
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

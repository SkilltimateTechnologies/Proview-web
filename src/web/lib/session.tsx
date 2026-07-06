import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { authClient, setBearer, clearBearer } from "./auth";
import { api } from "./api";

export type Me = {
  user: { id: string; email: string; name: string };
  profile: {
    userId: string;
    tenantId: string | null;
    role: string;
    displayId: string;
    enabled: boolean;
    permissions: Record<string, boolean> | null;
  };
  tenant: {
    id: string;
    name: string;
    shortName: string;
    primaryColor: string;
    logoUrl: string | null;
  } | null;
};

type Ctx = {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<Ctx>(null as unknown as Ctx);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.me.$get();
      if (res.ok) {
        setMe((await res.json()) as Me);
      } else {
        setMe(null);
      }
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) return { error: res.error.message ?? "Sign in failed" };
      const token = res.data?.token;
      if (token) setBearer(token);
      await refresh();
      return {};
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await authClient.signOut();
    clearBearer();
    setMe(null);
  }, []);

  return <SessionContext.Provider value={{ me, loading, refresh, signIn, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}

/** Which nav modules a profile may see. */
export function allowed(me: Me | null, module: string): boolean {
  if (!me) return false;
  if (me.profile.role === "super_admin") return true;
  if (me.profile.role === "college_admin") return true;
  if (me.profile.role === "tpo") return !!me.profile.permissions?.[module];
  return false;
}

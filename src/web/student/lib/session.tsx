import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { StudentProfile } from "./api";

type Ctx = {
  student: StudentProfile | null;
  login: (student: StudentProfile, token: string) => void;
  logout: () => void;
  clearMustChange: () => void;
};

const SessionCtx = createContext<Ctx>({ student: null, login: () => {}, logout: () => {}, clearMustChange: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [student, setStudent] = useState<StudentProfile | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("examly:student");
    if (raw) {
      try {
        setStudent(JSON.parse(raw) as StudentProfile);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const login = (s: StudentProfile, token: string) => {
    localStorage.setItem("examly:student", JSON.stringify(s));
    localStorage.setItem("examly:token", token);
    document.documentElement.style.setProperty("--brand", s.primaryColor || "#1e3a5f");
    setStudent(s);
  };
  const logout = () => {
    localStorage.removeItem("examly:student");
    localStorage.removeItem("examly:token");
    setStudent(null);
  };
  const clearMustChange = () => {
    setStudent((prev) => {
      if (!prev) return prev;
      const next = { ...prev, mustChangePassword: false };
      localStorage.setItem("examly:student", JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    if (student?.primaryColor) document.documentElement.style.setProperty("--brand", student.primaryColor);
  }, [student]);

  return <SessionCtx.Provider value={{ student, login, logout, clearMustChange }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);

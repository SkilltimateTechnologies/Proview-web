import { createAuthClient } from "better-auth/react";

export function getBearer(): string {
  try {
    return localStorage.getItem("examly_token") ?? "";
  } catch {
    return "";
  }
}

export function setBearer(token: string) {
  try {
    localStorage.setItem("examly_token", token);
  } catch {
    /* ignore */
  }
}

export function clearBearer() {
  try {
    localStorage.removeItem("examly_token");
  } catch {
    /* ignore */
  }
}

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  fetchOptions: {
    auth: {
      type: "Bearer",
      token: () => getBearer(),
    },
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get("set-auth-token");
      if (token) setBearer(token);
    },
  },
});

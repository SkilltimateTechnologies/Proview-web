import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { db } from "./database";
import { allowedOrigins } from "./lib/http-guard";

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: process.env.WEBSITE_URL,
  database: drizzleAdapter(db, { provider: "sqlite" }),
  emailAndPassword: { enabled: true, autoSignIn: false },
  secret: process.env.BETTER_AUTH_SECRET,
  // Only our own site(s). This used to echo back whatever Origin a request
  // carried, which turned off better-auth's check against cross-site requests.
  trustedOrigins: allowedOrigins(process.env),
  plugins: [bearer()],
});

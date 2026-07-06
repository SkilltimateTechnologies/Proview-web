import { createGateway } from "ai";

export const gateway = createGateway({
  baseURL: process.env.AI_GATEWAY_BASE_URL,
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

export const MODELS = {
  anthropic: "anthropic/claude-sonnet-5",
  google: "google/gemini-3-flash",
  openai: "openai/gpt-5.4-mini",
} as const;

export function modelFor(provider?: string | null) {
  if (provider === "google") return MODELS.google;
  if (provider === "openai") return MODELS.openai;
  return MODELS.anthropic;
}

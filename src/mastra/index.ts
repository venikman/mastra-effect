/**
 * Mastra Entry Point for Studio/Playground
 *
 * This file exports the Mastra instance required by `mastra dev` to run Studio.
 * It supports both real LLM mode and mock mode via environment variables.
 *
 * Usage:
 *   npm run dev          # Real mode (requires GROK_KEY)
 *   npm run dev:studio   # Mock mode (no API key needed)
 */
import { Mastra } from "@mastra/core";
import { createLogger } from "@mastra/core/logger";
import { repoQaAgent } from "./agents/repo-qa-agent.js";

const logger = createLogger({
  name: "mastra",
  level: "info",
});

export const mastra = new Mastra({
  agents: { repoQaAgent },
  logger,
});

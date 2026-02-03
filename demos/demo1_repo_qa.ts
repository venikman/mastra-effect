/**
 * Demo 1 — Repo Q&A via Mastra server API.
 * Requires the Mastra server to be running: npm run dev
 * Connects with @mastra/client-js only; no dependency on src.
 */
import "dotenv/config";
import * as Readline from "node:readline";
import { MastraClient } from "@mastra/client-js";

const BASE_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";
const DEFAULT_QUESTION =
  "How do I run, test, and extend this repo? Cite files you used (paths and line numbers when possible).";

function ask(prompt: string, defaultValue: string): Promise<string> {
  const rl = Readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`${prompt}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function main() {
  console.log("\nDemo 1 — Repo Q&A (via Mastra API)");
  console.log(`server: ${BASE_URL}\n`);

  const question = await ask("Question", DEFAULT_QUESTION);
  console.log(`\nQuestion: ${question}\n`);

  const client = new MastraClient({ baseUrl: BASE_URL });
  const agent = client.getAgent("repoQa");

  const response = await agent.generateLegacy({ messages: question });

  console.log("\n=== FINAL ANSWER ===\n");
  console.log(response.text ?? "");
  console.log("\n====================\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

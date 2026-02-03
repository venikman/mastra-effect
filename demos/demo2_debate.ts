/**
 * Demo 2 — Two Agents + Judge via Mastra server API.
 * Requires the Mastra server to be running: npm run dev
 * Connects with @mastra/client-js only; no dependency on src.
 */
import "dotenv/config";
import * as Readline from "node:readline";
import { MastraClient } from "@mastra/client-js";

const BASE_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";
const DEFAULT_QUESTION =
  "Identify the top 3 architectural risks in this repo setup and propose fixes. Cite evidence.";

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
  console.log("\nDemo 2 — Two Agents + Judge (via Mastra API)");
  console.log(`server: ${BASE_URL}\n`);

  const question = await ask("Question", DEFAULT_QUESTION);
  console.log(`\nQuestion: ${question}\n`);

  const client = new MastraClient({ baseUrl: BASE_URL });
  const agentA = client.getAgent("debaterA");
  const agentB = client.getAgent("debaterB");
  const judgeAgent = client.getAgent("judge");

  const startWall = Date.now();
  const [resA, resB] = await Promise.all([
    agentA.generateLegacy({ messages: question }),
    agentB.generateLegacy({ messages: question }),
  ]);
  const wallMs = Date.now() - startWall;

  console.log("\n=== AGENT A ===");
  console.log(`(parallel run took ${wallMs}ms total)\n`);
  console.log(resA.text ?? "");

  console.log("\n=== AGENT B ===");
  console.log("");
  console.log(resB.text ?? "");

  const judgePrompt = [
    "You will receive two candidate answers to the same question.",
    "Pick the best parts, remove hallucinations, and output a single best answer.",
    "If neither cites evidence, explicitly say evidence is missing and ask for specific tool calls.",
    "",
    `Question: ${question}`,
    "",
    "Candidate A:",
    resA.text ?? "",
    "",
    "Candidate B:",
    resB.text ?? "",
  ].join("\n");

  const judged = await judgeAgent.generateLegacy({ messages: judgePrompt });

  console.log("\n=== JUDGE FINAL ===\n");
  console.log(judged.text ?? "");
  console.log("\n===================\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

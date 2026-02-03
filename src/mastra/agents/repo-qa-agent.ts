/**
 * Repo Q&A Agent for Mastra Studio
 *
 * This agent answers questions about the local repository by using tools
 * to list files, search text, and read file contents.
 */
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { listFilesTool, searchTextTool, readFileTool } from "../tools/repo-tools.js";

// Use OpenAI-compatible endpoint - can be real or mock via OPENAI_BASE_URL
const model = openai("gpt-4o-mini");

export const repoQaAgent = new Agent({
  id: "repo-qa",
  name: "repo-qa",
  instructions: `You answer questions about a local directory by calling tools.
Cite evidence by naming files and line numbers where possible.
Never claim you read a file unless you used readFile.
Prefer using searchText to locate relevant spots before readFile.`,
  model,
  tools: {
    listFiles: listFilesTool,
    searchText: searchTextTool,
    readFile: readFileTool,
  },
});

/**
 * Repository Tools for Mastra Studio
 *
 * These tools allow the agent to explore and analyze the local repository.
 * They mirror the Effect-based tools in src/tools.ts but use Mastra's tool format.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";

// Get target directory from env or default to current directory
const getTargetDir = () => process.env.DEMO_TARGET_DIR?.trim() || ".";

/**
 * List files in the repository
 */
export const listFilesTool = createTool({
  id: "listFiles",
  description: "Lists files in the repository. Returns file paths relative to root.",
  inputSchema: z.object({
    max: z.number().optional().default(50).describe("Maximum number of files to return"),
  }),
  execute: async (input) => {
    const targetDir = getTargetDir();
    const max = input.max ?? 50;
    const files: string[] = [];

    const walk = (dir: string) => {
      if (files.length >= max) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (files.length >= max) break;

          // Skip hidden files and common ignore patterns
          if (entry.name.startsWith(".")) continue;
          if (entry.name === "node_modules") continue;
          if (entry.name === "dist") continue;

          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(targetDir, fullPath);

          if (entry.isDirectory()) {
            walk(fullPath);
          } else {
            files.push(relativePath);
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    walk(targetDir);
    return { files, count: files.length, truncated: files.length >= max };
  },
});

/**
 * Search for text patterns in files
 */
export const searchTextTool = createTool({
  id: "searchText",
  description: "Search for a text pattern in repository files. Returns matching lines with file paths.",
  inputSchema: z.object({
    query: z.string().describe("Text pattern to search for (case-insensitive)"),
    maxMatches: z.number().optional().default(20).describe("Maximum matches to return"),
  }),
  execute: async (input) => {
    const targetDir = getTargetDir();
    const query = input.query.toLowerCase();
    const maxMatches = input.maxMatches ?? 20;
    const matches: Array<{ file: string; line: number; content: string }> = [];

    const searchFile = (filePath: string) => {
      if (matches.length >= maxMatches) return;

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
          const line = lines[i];
          if (line && line.toLowerCase().includes(query)) {
            matches.push({
              file: path.relative(targetDir, filePath),
              line: i + 1,
              content: line.trim().slice(0, 200),
            });
          }
        }
      } catch {
        // Ignore read errors (binary files, etc.)
      }
    };

    const walk = (dir: string) => {
      if (matches.length >= maxMatches) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= maxMatches) break;

          if (entry.name.startsWith(".")) continue;
          if (entry.name === "node_modules") continue;
          if (entry.name === "dist") continue;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            // Only search text files
            const ext = path.extname(entry.name).toLowerCase();
            const textExts = [".ts", ".js", ".tsx", ".jsx", ".json", ".md", ".txt", ".yaml", ".yml", ".toml", ".env"];
            if (textExts.includes(ext) || entry.name === "package.json") {
              searchFile(fullPath);
            }
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    walk(targetDir);
    return { matches, count: matches.length, truncated: matches.length >= maxMatches };
  },
});

/**
 * Read file contents
 */
export const readFileTool = createTool({
  id: "readFile",
  description: "Read the contents of a file. Returns the file content with line numbers.",
  inputSchema: z.object({
    path: z.string().describe("Path to the file (relative to repository root)"),
    startLine: z.number().optional().describe("Start reading from this line (1-indexed)"),
    endLine: z.number().optional().describe("Stop reading at this line (inclusive)"),
  }),
  execute: async (input) => {
    const targetDir = getTargetDir();
    const filePath = path.resolve(targetDir, input.path);

    // Security: ensure file is within target directory
    if (!filePath.startsWith(path.resolve(targetDir))) {
      return { error: "Access denied: path outside repository" };
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      const start = Math.max(1, input.startLine ?? 1);
      const end = Math.min(lines.length, input.endLine ?? lines.length);

      const selectedLines = lines.slice(start - 1, end);
      const numberedContent = selectedLines
        .map((line, i) => `${start + i}| ${line}`)
        .join("\n");

      return {
        path: input.path,
        totalLines: lines.length,
        startLine: start,
        endLine: end,
        content: numberedContent,
      };
    } catch (err) {
      return { error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

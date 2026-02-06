/**
 * E2E Test: Mock Server
 *
 * Tests the full flow: start mock server → call API → verify response.
 * No real AI calls are made.
 */
import { describe, it, expect, beforeAll, afterAll } from "@rstest/core";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";

const PORT = 4222; // Use different port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`;

// Helper to make HTTP requests
const request = (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> =>
  new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(
      url,
      {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              data: data ? JSON.parse(data) : null,
            });
          } catch {
            resolve({ status: res.statusCode ?? 0, data });
          }
        });
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });

// Helper to wait for server to be ready
const waitForServer = async (
  maxAttempts = 30,
  delayMs = 200,
): Promise<void> => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { status } = await request("GET", "/");
      if (status === 200) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Server not ready after ${maxAttempts} attempts`);
};

describe("E2E: Mock Server", () => {
  let serverProcess: ChildProcess;

  beforeAll(async () => {
    // Start the mock server
    serverProcess = spawn("npx", ["tsx", "mock/standalone-server.ts"], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    // Capture output for debugging
    serverProcess.stdout?.on("data", (data) => {
      if (process.env.DEBUG) {
        console.log(`[Server stdout]: ${data}`);
      }
    });
    serverProcess.stderr?.on("data", (data) => {
      if (process.env.DEBUG) {
        console.error(`[Server stderr]: ${data}`);
      }
    });

    // Wait for server to be ready
    await waitForServer();
  }, 30_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      // Wait a bit for cleanup
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  describe("Health & Discovery", () => {
    it("returns health check", async () => {
      const { status, data } = await request("GET", "/");

      expect(status).toBe(200);
      expect(data).toMatchObject({
        status: "ok",
        mock: true,
        scenario: "smart",
      });
    });

    it("lists available agents", async () => {
      const { status, data } = await request("GET", "/api/agents");

      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data).toContainEqual(
        expect.objectContaining({
          id: "repoQa",
          name: "repo-qa",
        }),
      );
    });

    it("returns agent details", async () => {
      const { status, data } = await request("GET", "/api/agents/repoQa");

      expect(status).toBe(200);
      expect(data).toMatchObject({
        id: "repoQa",
        name: "repo-qa",
      });
    });

    it("returns 404 for unknown agent", async () => {
      const { status, data } = await request("GET", "/api/agents/unknownAgent");

      expect(status).toBe(404);
      expect(data).toMatchObject({
        error: expect.stringContaining("not found"),
      });
    });
  });

  describe("Generate Legacy Endpoint", () => {
    it("generates response for simple question", async () => {
      const { status, data } = await request(
        "POST",
        "/api/agents/repoQa/generate-legacy",
        { messages: "How do I run this project?" },
      );

      expect(status).toBe(200);
      expect(data).toMatchObject({
        text: expect.stringContaining("Mock Response"),
      });
      // Should mention running the project
      expect((data as any).text).toMatch(/npm|run|install/i);
    }, 30_000);

    it("generates response for structure question", async () => {
      const { status, data } = await request(
        "POST",
        "/api/agents/repoQa/generate-legacy",
        { messages: "What is the structure of this project?" },
      );

      expect(status).toBe(200);
      expect(data).toMatchObject({
        text: expect.stringContaining("Mock Response"),
      });
      // Should mention directories/files
      expect((data as any).text).toMatch(/src|test|directory|structure/i);
    }, 30_000);

    it("returns 404 for unknown agent", async () => {
      const { status, data } = await request(
        "POST",
        "/api/agents/unknownAgent/generate-legacy",
        { messages: "Hello" },
      );

      expect(status).toBe(404);
      expect(data).toMatchObject({
        error: expect.stringContaining("not found"),
      });
    });

    it("handles empty messages with error", async () => {
      const { status } = await request(
        "POST",
        "/api/agents/repoQa/generate-legacy",
        { messages: "" },
      );

      // Empty messages cause an error (expected behavior)
      expect(status).toBe(500);
    }, 30_000);
  });

  describe("Generate Endpoint (non-legacy)", () => {
    it("generates response via /generate endpoint", async () => {
      const { status, data } = await request(
        "POST",
        "/api/agents/repoQa/generate",
        { messages: "Tell me about this project" },
      );

      expect(status).toBe(200);
      expect(data).toMatchObject({
        text: expect.stringContaining("Mock Response"),
      });
    }, 30_000);
  });

  describe("CORS", () => {
    it("responds to OPTIONS preflight", async () => {
      const { status } = await new Promise<{ status: number }>(
        (resolve, reject) => {
          const url = new URL("/api/agents/repoQa/generate-legacy", BASE_URL);
          const req = http.request(url, { method: "OPTIONS" }, (res) => {
            resolve({ status: res.statusCode ?? 0 });
          });
          req.on("error", reject);
          req.end();
        },
      );

      expect(status).toBe(204);
    });
  });
});

describe("E2E: Mock Server with MastraClient", () => {
  let serverProcess: ChildProcess;

  beforeAll(async () => {
    serverProcess = spawn("npx", ["tsx", "mock/standalone-server.ts"], {
      env: { ...process.env, PORT: String(PORT + 1) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    await waitForServerOnPort(PORT + 1);
  }, 30_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("works with MastraClient", async () => {
    // Dynamic import to avoid issues if client not available
    const { MastraClient } = await import("@mastra/client-js");

    const client = new MastraClient({
      baseUrl: `http://localhost:${PORT + 1}`,
    });
    const agent = client.getAgent("repoQa");

    const response = await agent.generateLegacy({
      messages: "How do I test this?",
    });

    expect(response.text).toBeDefined();
    expect(response.text).toContain("Mock Response");
  }, 30_000);
});

// Helper for second test suite
const waitForServerOnPort = async (
  port: number,
  maxAttempts = 30,
  delayMs = 200,
): Promise<void> => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await new Promise<number>((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/`, (res) => {
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
      });
      if (result === 200) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `Server on port ${port} not ready after ${maxAttempts} attempts`,
  );
};

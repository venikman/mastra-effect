import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { describe, expect, it } from "@rstest/core";
import { Effect } from "effect";
import { makeRepoTools, EventLogSilent } from "../src/tools.js";

const makeTempDir = async (): Promise<string> => {
  const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "mastra-effect-"));
  return dir;
};

const isReadFileOut = (
  out: unknown,
): out is { truncated: boolean; content: string } =>
  typeof out === "object" &&
  out !== null &&
  typeof (out as any).truncated === "boolean" &&
  typeof (out as any).content === "string";

describe("tools", () => {
  it("denies reading .env", async () => {
    const dir = await makeTempDir();
    await Fs.writeFile(Path.join(dir, ".env"), "SECRET=1\n", "utf8");

    const tools = await Effect.runPromise(
      makeRepoTools(dir).pipe(Effect.provide([EventLogSilent] as const)),
    );
    await expect(
      tools.readFile.execute!({ path: ".env" } as any, undefined as any),
    ).rejects.toMatchObject({
      _tag: "ToolDeniedError",
    });
  });

  it("truncates readFile with maxBytes", async () => {
    const dir = await makeTempDir();
    const p = Path.join(dir, "big.txt");
    await Fs.writeFile(p, "0123456789ABCDEFGHIJ", "utf8");

    const tools = await Effect.runPromise(
      makeRepoTools(dir).pipe(Effect.provide([EventLogSilent] as const)),
    );
    const out = await tools.readFile.execute!(
      { path: "big.txt", maxBytes: 10 } as any,
      undefined as any,
    );

    expect(isReadFileOut(out)).toBe(true);
    if (!isReadFileOut(out)) throw new Error("Unexpected validation error");
    expect(out.truncated).toBe(true);
    expect(out.content).toBe("0123456789");
  });
});

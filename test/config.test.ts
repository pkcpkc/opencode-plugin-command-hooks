import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { loadChainConfig } from "../src/utils/config.js";

const tempDir = join(process.cwd(), "temp-config-test-dir");

describe("Utility: loadChainConfig", () => {
  const mockLog = vi.fn();

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should return null if the config file does not exist", async () => {
    const result = await loadChainConfig(tempDir, "non-existent-cmd", mockLog);
    expect(result).toBeNull();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("should parse and return ChainConfig if file exists with valid JSON", async () => {
    const config = {
      pre: ["/cmd1", "/cmd2"],
      post: ["/cmd3"]
    };
    await fs.writeFile(
      join(tempDir, "test-cmd.commands.json"),
      JSON.stringify(config)
    );

    const result = await loadChainConfig(tempDir, "test-cmd", mockLog);
    expect(result).toEqual(config);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("should log error and return null if config file contains malformed JSON", async () => {
    await fs.writeFile(
      join(tempDir, "broken-cmd.commands.json"),
      "{ invalid: json "
    );

    const result = await loadChainConfig(tempDir, "broken-cmd", mockLog);
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse chain config"),
      "error",
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it("should normalize the command name by stripping leading slash", async () => {
    const config = { pre: ["/test"] };
    await fs.writeFile(
      join(tempDir, "slashed-cmd.commands.json"),
      JSON.stringify(config)
    );

    const resultWithSlash = await loadChainConfig(tempDir, "/slashed-cmd", mockLog);
    expect(resultWithSlash).toEqual(config);

    const resultWithoutSlash = await loadChainConfig(tempDir, "slashed-cmd", mockLog);
    expect(resultWithoutSlash).toEqual(config);
  });
});

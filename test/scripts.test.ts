import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { logToSession, runScript, PluginContext } from "../src/utils/scripts.js";

const tempDir = join(process.cwd(), "temp-scripts-test-dir");

describe("Utility: scripts", () => {
  let mockClient: any;
  let mockShellExitCode = 0;
  let mockShellStdout = "success stdout";
  let mockShellStderr = "some stderr";
  let mockShellHistory: { strings: TemplateStringsArray; values: any[] }[] = [];
  let mockShellCwdHistory: string[] = [];

  const mockShell = (strings: TemplateStringsArray, ...values: any[]) => {
    mockShellHistory.push({ strings, values });
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: (dir: string) => {
        mockShellCwdHistory.push(dir);
        return chain;
      },
      then(onfulfilled?: (value: any) => any) {
        return Promise.resolve({
          exitCode: mockShellExitCode,
          stdout: { toString: () => mockShellStdout },
          stderr: { toString: () => mockShellStderr }
        }).then(onfulfilled);
      }
    };
    return chain;
  };

  const mockCtx = (): PluginContext => ({
    client: mockClient,
    $: mockShell as any,
    commandsDir: tempDir,
    log: vi.fn(),
    showToast: vi.fn()
  });

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    vi.clearAllMocks();
    mockShellExitCode = 0;
    mockShellStdout = "success stdout";
    mockShellStderr = "some stderr";
    mockShellHistory = [];
    mockShellCwdHistory = [];
    mockClient = {
      session: {
        prompt: vi.fn().mockResolvedValue({})
      }
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("logToSession", () => {
    it("should combine stdout and stderr and send to session.prompt", async () => {
      const ctx = mockCtx();
      await logToSession(ctx, "session-123", "Title", {
        stdout: " hello  ",
        stderr: "  world ",
        exitCode: 0
      });

      expect(mockClient.session.prompt).toHaveBeenCalledWith({
        path: { id: "session-123" },
        body: {
          parts: [{ type: "text", text: "hello\nworld" }],
          noReply: true
        }
      });
    });

    it("should do nothing if both stdout and stderr are empty", async () => {
      const ctx = mockCtx();
      await logToSession(ctx, "session-123", "Title", {
        stdout: "   ",
        stderr: "",
        exitCode: 0
      });

      expect(mockClient.session.prompt).not.toHaveBeenCalled();
    });

    it("should log error to console/file if session.prompt throws", async () => {
      mockClient.session.prompt.mockRejectedValueOnce(new Error("Network disconnect"));
      const ctx = mockCtx();
      await logToSession(ctx, "session-123", "Title", {
        stdout: "something",
        stderr: "",
        exitCode: 0
      });

      expect(ctx.log).toHaveBeenCalledWith(
        "Failed to log to session",
        "error",
        expect.objectContaining({ error: "Network disconnect" })
      );
    });
  });

  describe("runScript", () => {
    it("should return null immediately if script file does not exist", async () => {
      const ctx = mockCtx();
      const result = await runScript(ctx, "pre", "non-existent-cmd");
      expect(result).toBeNull();
      expect(ctx.log).not.toHaveBeenCalled();
    });

    it("should run pre-script successfully and return stdout", async () => {
      const ctx = mockCtx();
      const scriptPath = join(tempDir, "my-cmd.pre.sh");
      await fs.writeFile(scriptPath, "echo 'hello'");
      await fs.chmod(scriptPath, 0o755);

      const result = await runScript(ctx, "pre", "my-cmd", "session-123", "arg1 arg2");

      expect(result).toBe("success stdout");
      expect(ctx.log).toHaveBeenCalledWith(
        "Pre-script finished",
        "info",
        expect.objectContaining({ exitCode: 0, stdout: "success stdout" })
      );
      expect(ctx.showToast).toHaveBeenLastCalledWith("Pre-script my-cmd finished", "success", 3000);
      expect(mockClient.session.prompt).toHaveBeenCalled();
      
      // Verify parsed args are passed to mockShell
      expect(mockShellHistory.length).toBe(1);
      expect(mockShellHistory[0].values[1]).toEqual(["arg1", "arg2"]);
    });

    it("should throw error when pre-script fails (exit code > 0)", async () => {
      const ctx = mockCtx();
      const scriptPath = join(tempDir, "fail-cmd.pre.sh");
      await fs.writeFile(scriptPath, "exit 1");
      await fs.chmod(scriptPath, 0o755);

      mockShellExitCode = 3;
      mockShellStdout = "";
      mockShellStderr = "Syntax error";

      await expect(
        runScript(ctx, "pre", "fail-cmd", "session-123", "")
      ).rejects.toThrow("Pre-script fail-cmd failed with exit code 3");

      expect(ctx.showToast).toHaveBeenCalledWith("Pre-script fail-cmd failed", "error", 5000);
    });

    it("should handle post-script failure gracefully (exit code > 0) without throwing", async () => {
      const ctx = mockCtx();
      const scriptPath = join(tempDir, "fail-cmd.post.sh");
      await fs.writeFile(scriptPath, "exit 5");
      await fs.chmod(scriptPath, 0o755);

      mockShellExitCode = 5;
      mockShellStdout = "";
      mockShellStderr = "Post action failed";

      const result = await runScript(ctx, "post", "fail-cmd", "session-123", "");
      expect(result).toBe("");
      expect(ctx.showToast).toHaveBeenCalledWith("Post-script fail-cmd failed", "error", 5000);
    });

    it("should log error to session and throw if a script exists but is not executable", async () => {
      const ctx = mockCtx();
      const scriptPath = join(tempDir, "no-exec.pre.sh");
      await fs.writeFile(scriptPath, "echo 'hello'");
      // Set to non-executable (0o644)
      await fs.chmod(scriptPath, 0o644);

      await expect(
        runScript(ctx, "pre", "no-exec", "session-123", "")
      ).rejects.toThrow("but is not executable");

      // Verify it called session.prompt with the error message
      expect(mockClient.session.prompt).toHaveBeenCalled();
      const promptArg = mockClient.session.prompt.mock.calls[0][0];
      expect(promptArg.body.parts[0].text).toContain("but is not executable");
      expect(promptArg.body.parts[0].text).toContain("chmod +x");
    });

    it("should strip leading slash from command name when locating script path", async () => {
      const ctx = mockCtx();
      const scriptPath = join(tempDir, "my-cmd.pre.sh");
      await fs.writeFile(scriptPath, "echo");
      await fs.chmod(scriptPath, 0o755);

      const result = await runScript(ctx, "pre", "/my-cmd");
      expect(result).toBe("success stdout");
    });

    it("should run scripts with the directory containing the script as the working directory (cwd)", async () => {
      const ctx = mockCtx();
      const subDir = join(tempDir, "sub");
      await fs.mkdir(subDir, { recursive: true });
      const scriptPath = join(subDir, "my-cmd.pre.sh");
      await fs.writeFile(scriptPath, "echo");
      await fs.chmod(scriptPath, 0o755);

      await runScript(ctx, "pre", "sub/my-cmd");
      expect(mockShellCwdHistory).toContain(subDir);
    });
  });
});

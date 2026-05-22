import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { promises as fs, existsSync } from "fs";
import { CommandHooksPlugin, parseArguments, resolveCommandAndArgs } from "../src/index.js";

const tempDir = join(process.cwd(), "temp-test-dir");

let mockShellExitCode = 0;
let mockShellStdout = "success output";
let mockShellStderr = "";

const mockShell = (strings: TemplateStringsArray, ...values: any[]) => {
  const chain = {
    quiet: () => chain,
    nothrow: () => chain,
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

describe("Command Hooks Plugin", () => {
  const mockClient = {
    app: {
      log: vi.fn().mockResolvedValue({})
    },
    tui: {
      showToast: vi.fn().mockResolvedValue({})
    },
    session: {
      prompt: vi.fn().mockResolvedValue({}),
      command: vi.fn().mockResolvedValue({})
    }
  };

  beforeEach(async () => {
    await fs.mkdir(join(tempDir, "commands"), { recursive: true });
    await fs.mkdir(join(tempDir, "logs"), { recursive: true });
    vi.clearAllMocks();
    mockShellExitCode = 0;
    mockShellStdout = "success output";
    mockShellStderr = "";
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should initialize and log to file", async () => {
    const plugin = await CommandHooksPlugin({
      $: mockShell as any,
      client: mockClient as any,
      directory: tempDir,
      project: {} as any,
      worktree: tempDir,
      experimental_workspace: {} as any,
      serverUrl: new URL("http://localhost")
    }, {
      commandsDirectory: "commands",
      logFilePath: "logs/commandHooks.log",
      logLevel: "debug"
    });

    expect(plugin.name).toBe("Command Hooks");
    expect(existsSync(join(tempDir, "logs/commandHooks.log"))).toBe(true);
    const logContent = await fs.readFile(join(tempDir, "logs/commandHooks.log"), "utf8");
    expect(logContent).toContain("Plugin initialized - Tracking commands");
  });

  describe("Utility: parseArguments", () => {
    it("should split normal arguments", () => {
      expect(parseArguments("foo bar baz")).toEqual(["foo", "bar", "baz"]);
    });

    it("should respect double quotes", () => {
      expect(parseArguments('foo "bar baz"')).toEqual(["foo", "bar baz"]);
    });

    it("should respect single quotes", () => {
      expect(parseArguments("foo 'bar baz'")).toEqual(["foo", "bar baz"]);
    });

    it("should handle escaped quotes", () => {
      expect(parseArguments('foo \\"bar')).toEqual(["foo", '"bar']);
    });

    it("should handle empty arguments in quotes", () => {
      expect(parseArguments('foo "" bar')).toEqual(["foo", "", "bar"]);
    });
  });

  describe("Utility: resolveCommandAndArgs", () => {
    it("should map positional placeholders", () => {
      const resolved = resolveCommandAndArgs("/pre-cmd $2 $1", "foo bar");
      expect(resolved).toEqual({
        command: "/pre-cmd",
        arguments: "bar foo"
      });
    });

    it("should substitute $args with full string", () => {
      const resolved = resolveCommandAndArgs("/pre-cmd $args", "foo bar");
      expect(resolved).toEqual({
        command: "/pre-cmd",
        arguments: "foo bar"
      });
    });

    it("should quote substituted arguments containing spaces", () => {
      const resolved = resolveCommandAndArgs("/pre-cmd $2", "foo \"bar baz\"");
      expect(resolved).toEqual({
        command: "/pre-cmd",
        arguments: "\"bar baz\""
      });
    });

    it("should return empty arguments if none specified", () => {
      const resolved = resolveCommandAndArgs("/pre-cmd", "foo bar");
      expect(resolved).toEqual({
        command: "/pre-cmd",
        arguments: ""
      });
    });
  });

  describe("command.execute.before hook", () => {
    it("should execute fine when no configs exist", async () => {
      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      await expect(plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: "args"
      }, { parts: [] })).resolves.not.toThrow();

      expect(mockClient.session.command).not.toHaveBeenCalled();
    });

    it("should execute JSON pre-commands successfully", async () => {
      // Create a commands.json
      const config = {
        pre: ["/dep-cmd-1", "/dep-cmd-2"],
        post: ["/dep-cmd-post"]
      };
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify(config)
      );

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      await plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: "args"
      }, { parts: [] });

      expect(mockClient.session.command).toHaveBeenCalledTimes(2);
      expect(mockClient.session.command).toHaveBeenNthCalledWith(1, {
        path: { id: "session-123" },
        body: { command: "/dep-cmd-1", arguments: "" }
      });
      expect(mockClient.session.command).toHaveBeenNthCalledWith(2, {
        path: { id: "session-123" },
        body: { command: "/dep-cmd-2", arguments: "" }
      });
    });

    it("should execute JSON pre-commands with positional parameters (Design B)", async () => {
      const config = {
        pre: ["/dep-cmd-1 $2 $3", "/dep-cmd-2 $1", "/dep-cmd-3 $args"],
      };
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify(config)
      );

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      await plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: "foo \"bar baz\" qux"
      }, { parts: [] });

      expect(mockClient.session.command).toHaveBeenCalledTimes(3);
      expect(mockClient.session.command).toHaveBeenNthCalledWith(1, {
        path: { id: "session-123" },
        body: { command: "/dep-cmd-1", arguments: "\"bar baz\" qux" }
      });
      expect(mockClient.session.command).toHaveBeenNthCalledWith(2, {
        path: { id: "session-123" },
        body: { command: "/dep-cmd-2", arguments: "foo" }
      });
      expect(mockClient.session.command).toHaveBeenNthCalledWith(3, {
        path: { id: "session-123" },
        body: { command: "/dep-cmd-3", arguments: "foo \"bar baz\" qux" }
      });
    });

    it("should abort and throw when a JSON pre-command fails", async () => {
      const config = {
        pre: ["/dep-cmd-fail"]
      };
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify(config)
      );

      mockClient.session.command.mockRejectedValueOnce(new Error("Command failed"));

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      await expect(plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: "args"
      }, { parts: [] })).rejects.toThrow("Chain aborted due to error in pre-command /dep-cmd-fail: Command failed");
    });

    it("should run pre shell script successfully", async () => {
      // Create .pre.sh
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.pre.sh"),
        "echo 'pre-script hello'"
      );

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      mockShellExitCode = 0;
      mockShellStdout = "pre-script ran successfully";

      await plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: "args"
      }, { parts: [] });

      const logContent = await fs.readFile(join(tempDir, "logs/commandHooks.log"), "utf8");
      expect(logContent).toContain("Pre-script finished");
    });

    it("should abort and throw when pre shell script fails", async () => {
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.pre.sh"),
        "exit 1"
      );

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      mockShellExitCode = 1;
      mockShellStdout = "";
      mockShellStderr = "Permission denied";

      await expect(plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: "args"
      }, { parts: [] })).rejects.toThrow("Pre-script test-cmd failed with exit code 1");

      // Verify failure logs were posted to the session
      expect(mockClient.session.prompt).toHaveBeenCalled();
      const promptArg = mockClient.session.prompt.mock.calls[0][0];
      expect(promptArg.path.id).toBe("session-123");
      expect(promptArg.body.parts[0].text).toContain("Permission denied");
    });
  });

  describe("event hook (command.executed)", () => {
    it("should execute post-script successfully", async () => {
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.post.sh"),
        "echo 'post-scripthello'"
      );

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      mockShellExitCode = 0;
      mockShellStdout = "post-script ran successfully";

      await plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "test-cmd",
            sessionID: "session-123",
            text: "args"
          }
        }
      } as any);

      const logContent = await fs.readFile(join(tempDir, "logs/commandHooks.log"), "utf8");
      expect(logContent).toContain("Post-script finished");
    });

    it("should handle post-script failure without throwing", async () => {
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.post.sh"),
        "exit 5"
      );

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      mockShellExitCode = 5;
      mockShellStdout = "";
      mockShellStderr = "Failed post action";

      await expect(plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "test-cmd",
            sessionID: "session-123",
            text: "args"
          }
        }
      } as any)).resolves.not.toThrow();

      expect(mockClient.session.prompt).toHaveBeenCalled();
      const promptArg = mockClient.session.prompt.mock.calls[0][0];
      expect(promptArg.path.id).toBe("session-123");
      expect(promptArg.body.parts[0].text).toContain("Failed post action");
    });

    it("should run JSON post-commands", async () => {
      const config = {
        post: ["/dep-post-1"]
      };
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify(config)
      );

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      await plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "test-cmd",
            sessionID: "session-123",
            text: "args"
          }
        }
      } as any);

      expect(mockClient.session.command).toHaveBeenCalledTimes(1);
      expect(mockClient.session.command).toHaveBeenCalledWith({
        path: { id: "session-123" },
        body: { command: "/dep-post-1", arguments: "" }
      });
    });

    it("should run JSON post-commands with positional parameters", async () => {
      const config = {
        post: ["/dep-post-1 $2"]
      };
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify(config)
      );

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: tempDir,
        project: {} as any,
        worktree: tempDir,
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logFilePath: "logs/commandHooks.log",
        logLevel: "debug"
      });

      await plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "test-cmd",
            sessionID: "session-123",
            text: "val1 val2"
          }
        }
      } as any);

      expect(mockClient.session.command).toHaveBeenCalledTimes(1);
      expect(mockClient.session.command).toHaveBeenCalledWith({
        path: { id: "session-123" },
        body: { command: "/dep-post-1", arguments: "val2" }
      });
    });
  });
});

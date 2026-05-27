import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { promises as fs, existsSync } from "fs";
import { CommandHooksPlugin } from "../src/index.js";
import { parseArguments, resolveCommandAndArgs } from "../src/utils/args.js";

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

  let activePlugin: any = null;

  beforeEach(async () => {
    await fs.mkdir(join(tempDir, "commands"), { recursive: true });
    await fs.mkdir(join(tempDir, "logs"), { recursive: true });
    vi.clearAllMocks();
    mockShellExitCode = 0;
    mockShellStdout = "success output";
    mockShellStderr = "";
    activePlugin = null;

    mockClient.session.command.mockImplementation(async (payload: any) => {
      if (activePlugin) {
        process.nextTick(() => {
          activePlugin.event!({
            event: {
              type: "command.executed",
              properties: {
                name: payload.body.command,
                sessionID: payload.path.id,
                text: payload.body.arguments,
                exitCode: 0
              }
            }
          } as any);
        });
      }
      return {};
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should initialize and call logging API", async () => {
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
      logLevel: "debug"
    });

    expect(plugin.name).toBe("Command Hooks");
    expect(mockClient.app.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          message: expect.stringContaining("Initializing plugin")
        })
      })
    );
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

    it("should resolve missing positional placeholders to empty string", () => {
      const resolved = resolveCommandAndArgs("/pre-cmd $9", "foo bar");
      expect(resolved).toEqual({
        command: "/pre-cmd",
        arguments: ""
      });
    });

    it("should resolve duplicate positional placeholders correctly", () => {
      const resolved = resolveCommandAndArgs("/pre-cmd $1 $1 $2", "foo bar");
      expect(resolved).toEqual({
        command: "/pre-cmd",
        arguments: "foo foo bar"
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
        logLevel: "debug"
      });
      activePlugin = plugin;

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
        logLevel: "debug"
      });
      activePlugin = plugin;

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
        logLevel: "debug"
      });

      mockShellExitCode = 0;
      mockShellStdout = "pre-script ran successfully";

      await plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: "args"
      }, { parts: [] });

      expect(mockClient.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            message: "Pre-script finished"
          })
        })
      );
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

    it("should clean up and reject when client.session.command throws an error", async () => {
      const config = {
        pre: ["/dep-cmd-throw"]
      };
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify(config)
      );

      mockClient.session.command.mockRejectedValueOnce(new Error("Network Error"));

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
        logLevel: "debug"
      });
      activePlugin = plugin;

      await expect(plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: ""
      }, { parts: [] })).rejects.toThrow("Network Error");
    });

    it("should handle malformed JSON configuration gracefully and skip it", async () => {
      // Write malformed JSON
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        "{ invalid json {"
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
        logLevel: "debug"
      });
      activePlugin = plugin;

      // Executing before hook should succeed without running any pre-commands
      await expect(plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: ""
      }, { parts: [] })).resolves.not.toThrow();

      expect(mockClient.session.command).not.toHaveBeenCalled();
      expect(mockClient.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "error",
            message: expect.stringContaining("Failed to parse chain config")
          })
        })
      );
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

      expect(mockClient.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            message: "Post-script finished"
          })
        })
      );
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
        logLevel: "debug"
      });
      activePlugin = plugin;

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
        logLevel: "debug"
      });
      activePlugin = plugin;

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

    it("should execute pre-commands strictly sequentially", async () => {
      const config = {
        pre: ["/first-cmd", "/second-cmd"]
      };
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify(config)
      );

      const executionOrder: string[] = [];

      mockClient.session.command.mockImplementation(async (payload: any) => {
        const cmdName = payload.body.command;
        executionOrder.push(`start:${cmdName}`);
        
        // Simulate completion after a slight delay
        setTimeout(() => {
          executionOrder.push(`end:${cmdName}`);
          activePlugin.event!({
            event: {
              type: "command.executed",
              properties: {
                name: cmdName,
                sessionID: payload.path.id,
                text: payload.body.arguments,
                exitCode: 0
              }
            }
          } as any);
        }, 10);
        return {};
      });

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
        logLevel: "debug"
      });
      activePlugin = plugin;

      await plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: ""
      }, { parts: [] });

      expect(executionOrder).toEqual([
        "start:/first-cmd",
        "end:/first-cmd",
        "start:/second-cmd",
        "end:/second-cmd"
      ]);
    });

    it("should support concurrent/multi-instance FIFO queueing for identical commands", async () => {
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
        logLevel: "debug"
      });
      activePlugin = plugin;

      // Create pre-commands configuration to trigger identical commands
      const config = {
        pre: ["/wiki-lint", "/wiki-lint"]
      };
      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify(config)
      );

      // Intercept the execution and let the plugin start both.
      // Since it's sequential, the second one will only start after the first one is resolved.
      mockClient.session.command.mockImplementation(async (payload: any) => {
        return {};
      });

      // We will trigger command.execute.before, which awaits all pre-commands.
      // To simulate FIFO resolution without hanging, we can trigger the events in process.nextTick or setTimeout
      setTimeout(() => {
        // Event for first execution
        plugin.event!({
          event: {
            type: "command.executed",
            properties: {
              name: "wiki-lint",
              sessionID: "session-123",
              exitCode: 0
            }
          }
        } as any);

        // Event for second execution
        setTimeout(() => {
          plugin.event!({
            event: {
              type: "command.executed",
              properties: {
                name: "wiki-lint",
                sessionID: "session-123",
                exitCode: 0
              }
            }
          } as any);
        }, 10);
      }, 10);

      await plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-123",
        arguments: ""
      }, { parts: [] });

      expect(mockClient.session.command).toHaveBeenCalledTimes(2);
    });

    it("should isolate separate concurrent commands and not interfere", async () => {
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
        logLevel: "debug"
      });
      activePlugin = plugin;

      // Define pre-configs for two different commands
      await fs.writeFile(
        join(tempDir, "commands/cmd-a.commands.json"),
        JSON.stringify({ pre: ["/sub-a"] })
      );
      await fs.writeFile(
        join(tempDir, "commands/cmd-b.commands.json"),
        JSON.stringify({ pre: ["/sub-b"] })
      );

      const running: string[] = [];

      mockClient.session.command.mockImplementation(async (payload: any) => {
        const cmdName = payload.body.command;
        running.push(cmdName);
        return {};
      });

      // Trigger pre-commands for cmd-a and cmd-b
      const p1 = plugin["command.execute.before"]!({
        command: "cmd-a",
        sessionID: "session-123",
        arguments: ""
      }, { parts: [] });

      const p2 = plugin["command.execute.before"]!({
        command: "cmd-b",
        sessionID: "session-123",
        arguments: ""
      }, { parts: [] });

      // Simulate event execution completes for sub-b first, then sub-a after a small delay to let configs load
      setTimeout(() => {
        plugin.event!({
          event: {
            type: "command.executed",
            properties: {
              name: "sub-b",
              sessionID: "session-123",
              exitCode: 0
            }
          }
        } as any);

        setTimeout(() => {
          plugin.event!({
            event: {
              type: "command.executed",
              properties: {
                name: "sub-a",
                sessionID: "session-123",
                exitCode: 0
              }
            }
          } as any);
        }, 10);
      }, 10);

      await expect(p1).resolves.not.toThrow();
      await expect(p2).resolves.not.toThrow();

      expect(running).toContain("/sub-a");
      expect(running).toContain("/sub-b");
    });
  });
});

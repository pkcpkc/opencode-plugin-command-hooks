import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { promises as fs, existsSync } from "fs";
import { CommandHooksPlugin } from "../src/index.js";

const tempDir = join(process.cwd(), "temp-test-dir");

let mockShellExitCode = 0;
let mockShellStdout = "success output";
let mockShellStderr = "";
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
    mockShellHistory = [];
    mockShellCwdHistory = [];
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
        body: { command: "/dep-cmd-1", arguments: "", args: "" },
        query: { directory: join(tempDir, "commands") }
      });
      expect(mockClient.session.command).toHaveBeenNthCalledWith(2, {
        path: { id: "session-123" },
        body: { command: "/dep-cmd-2", arguments: "", args: "" },
        query: { directory: join(tempDir, "commands") }
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
        body: { command: "/dep-cmd-1", arguments: "\"bar baz\" qux", args: "\"bar baz\" qux" },
        query: { directory: join(tempDir, "commands") }
      });
      expect(mockClient.session.command).toHaveBeenNthCalledWith(2, {
        path: { id: "session-123" },
        body: { command: "/dep-cmd-2", arguments: "foo", args: "foo" },
        query: { directory: join(tempDir, "commands") }
      });
      expect(mockClient.session.command).toHaveBeenNthCalledWith(3, {
        path: { id: "session-123" },
        body: { command: "/dep-cmd-3", arguments: "foo \"bar baz\" qux", args: "foo \"bar baz\" qux" },
        query: { directory: join(tempDir, "commands") }
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

    it("should run chained commands with correct resolved nested directory", async () => {
      const config = {
        pre: ["/subfolder/dep-cmd"]
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
        arguments: ""
      }, { parts: [] });

      expect(mockClient.session.command).toHaveBeenCalledWith({
        path: { id: "session-123" },
        body: { command: "/subfolder/dep-cmd", arguments: "", args: "" },
        query: { directory: join(tempDir, "commands/subfolder") }
      });
    });

    it("should run pre shell script successfully", async () => {
      // Create .pre.sh
      const scriptPath = join(tempDir, "commands/test-cmd.pre.sh");
      await fs.writeFile(
        scriptPath,
        "echo 'pre-script hello'"
      );
      await fs.chmod(scriptPath, 0o755);

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
      const scriptPath = join(tempDir, "commands/test-cmd.pre.sh");
      await fs.writeFile(
        scriptPath,
        "exit 1"
      );
      await fs.chmod(scriptPath, 0o755);

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
      const scriptPath = join(tempDir, "commands/test-cmd.post.sh");
      await fs.writeFile(
        scriptPath,
        "echo 'post-scripthello'"
      );
      await fs.chmod(scriptPath, 0o755);

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
      const scriptPath = join(tempDir, "commands/test-cmd.post.sh");
      await fs.writeFile(
        scriptPath,
        "exit 5"
      );
      await fs.chmod(scriptPath, 0o755);

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
        body: { command: "/dep-post-1", arguments: "", args: "" },
        query: { directory: join(tempDir, "commands") }
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
        body: { command: "/dep-post-1", arguments: "val2", args: "val2" },
        query: { directory: join(tempDir, "commands") }
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

    it("should completely isolate separate concurrent sessions from interfering with identical commands", async () => {
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

      await fs.writeFile(
        join(tempDir, "commands/test-cmd.commands.json"),
        JSON.stringify({ pre: ["/wiki-lint"] })
      );

      const running: string[] = [];
      mockClient.session.command.mockImplementation(async (payload: any) => {
        const sid = payload.path.id;
        running.push(sid);
        if (sid === "session-2") {
          // Auto-resolve session-2 first
          process.nextTick(() => {
            plugin.event!({
              event: {
                type: "command.executed",
                properties: {
                  name: payload.body.command,
                  sessionID: sid,
                  exitCode: 0
                }
              }
            } as any);
          });
        }
        return {};
      });

      // Session 1 starts running wiki-lint
      const p1 = plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-1",
        arguments: ""
      }, { parts: [] });

      // Session 2 starts running wiki-lint
      const p2 = plugin["command.execute.before"]!({
        command: "test-cmd",
        sessionID: "session-2",
        arguments: ""
      }, { parts: [] });

      // Verify Session 2 is resolved, and Session 1 is still pending
      await expect(p2).resolves.not.toThrow();

      let p1Resolved = false;
      p1.then(() => { p1Resolved = true; });
      // A small delay to ensure p1 has not resolved
      await new Promise(r => setTimeout(r, 10));
      expect(p1Resolved).toBe(false);

      // Trigger completion for Session 1 manually now
      await plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "wiki-lint",
            sessionID: "session-1",
            exitCode: 0
          }
        }
      } as any);

      await expect(p1).resolves.not.toThrow();
      expect(running).toContain("session-1");
      expect(running).toContain("session-2");
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

  describe("Robust Argument Fallbacks and Payload Properties", () => {
    it("should fallback to input.args or input.text in command.execute.before hook", async () => {
      const scriptPath = join(tempDir, "commands/test-args-cmd.pre.sh");
      await fs.writeFile(
        scriptPath,
        "echo 'pre-script hello'"
      );
      await fs.chmod(scriptPath, 0o755);

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

      // 1. Test input.args
      mockShellHistory = [];
      await plugin["command.execute.before"]!({
        command: "test-args-cmd",
        sessionID: "session-123",
        arguments: ""
      } as any, { parts: [] });

      // Note: first index of mockShellHistory's values is the script path, the second is parsedArgs
      expect(mockShellHistory.length).toBe(1);
      expect(mockShellHistory[0].values.length).toBe(1); // empty args not passed to shell

      // 2. Test input.args populated
      mockShellHistory = [];
      await plugin["command.execute.before"]!({
        command: "test-args-cmd",
        sessionID: "session-123",
        arguments: "",
        args: "Tech"
      } as any, { parts: [] });

      expect(mockShellHistory.length).toBe(1);
      expect(mockShellHistory[0].values[1]).toEqual(["Tech"]);

      // 3. Test input.text populated
      mockShellHistory = [];
      await plugin["command.execute.before"]!({
        command: "test-args-cmd",
        sessionID: "session-123",
        arguments: "",
        text: "Tech"
      } as any, { parts: [] });

      expect(mockShellHistory.length).toBe(1);
      expect(mockShellHistory[0].values[1]).toEqual(["Tech"]);
    });

    it("should fallback to props.args or props.text in event hook", async () => {
      const config = {
        post: ["/dep-post-1 $1"]
      };
      await fs.writeFile(
        join(tempDir, "commands/test-event-cmd.commands.json"),
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

      // 1. Test props.args
      mockClient.session.command.mockClear();
      await plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "test-event-cmd",
            sessionID: "session-123",
            args: "Tech"
          }
        }
      } as any);

      expect(mockClient.session.command).toHaveBeenCalledTimes(1);
      expect(mockClient.session.command).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          command: "/dep-post-1",
          arguments: "Tech",
          args: "Tech"
        })
      }));

      // 2. Test props.text
      mockClient.session.command.mockClear();
      await plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "test-event-cmd",
            sessionID: "session-123",
            text: "Tech"
          }
        }
      } as any);

      expect(mockClient.session.command).toHaveBeenCalledTimes(1);
      expect(mockClient.session.command).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          command: "/dep-post-1",
          arguments: "Tech",
          args: "Tech"
        })
      }));
    });
  });

  describe("Integrated CWD Isolation Validation", () => {
    it("should resolve and execute chained pre/post commands and scripts with correct nested directory relative to worktree", async () => {
      // Create nested command JSON config, pre-script, and post-script in tempDir
      const nestedCmdDir = join(tempDir, "commands/nested");
      await fs.mkdir(nestedCmdDir, { recursive: true });

      // Config: validate-cwd.commands.json
      await fs.writeFile(
        join(tempDir, "commands/validate-cwd.commands.json"),
        JSON.stringify({
          pre: ["nested/child-cmd"]
        })
      );

      // Pre-script: nested/child-cmd.pre.sh
      const prePath = join(nestedCmdDir, "child-cmd.pre.sh");
      await fs.writeFile(
        prePath,
        "echo child-cmd.pre.sh"
      );
      await fs.chmod(prePath, 0o755);

      // Post-script: nested/child-cmd.post.sh
      const postPath = join(nestedCmdDir, "child-cmd.post.sh");
      await fs.writeFile(
        postPath,
        "echo child-cmd.post.sh"
      );
      await fs.chmod(postPath, 0o755);

      const plugin = await CommandHooksPlugin({
        $: mockShell as any,
        client: mockClient as any,
        directory: join(tempDir, "commands/nested"), // Active directory is nested
        project: {} as any,
        worktree: tempDir, // Worktree root is main project root
        experimental_workspace: {} as any,
        serverUrl: new URL("http://localhost")
      }, {
        commandsDirectory: "commands",
        logLevel: "debug"
      });
      activePlugin = plugin;

      // Reset mocks and shell history
      mockClient.session.command.mockClear();
      mockShellCwdHistory = [];

      // Execute command.execute.before hook
      await plugin["command.execute.before"]!({
        command: "validate-cwd",
        sessionID: "session-123",
        arguments: ""
      }, { parts: [] });

      // 1. Verify chained command resolves relative to worktree/commands and runs in its correct nested folder
      expect(mockClient.session.command).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          command: "nested/child-cmd"
        }),
        query: {
          directory: join(tempDir, "commands/nested")
        }
      }));

      // 2. Trigger event hook to simulate execution completion of validate-cwd
      mockClient.session.command.mockClear();
      await plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "validate-cwd",
            sessionID: "session-123",
            exitCode: 0
          }
        }
      } as any);

      // 3. Trigger command.execute.before for nested/child-cmd (simulated child execution)
      await plugin["command.execute.before"]!({
        command: "nested/child-cmd",
        sessionID: "session-123",
        arguments: ""
      }, { parts: [] });

      // Verify that child-cmd's pre-script ran with the child-cmd directory as its working directory (cwd)
      expect(mockShellCwdHistory).toContain(join(tempDir, "commands/nested"));

      // 4. Trigger event hook to simulate completion of nested/child-cmd
      mockShellCwdHistory = [];
      await plugin.event!({
        event: {
          type: "command.executed",
          properties: {
            name: "nested/child-cmd",
            sessionID: "session-123",
            exitCode: 0
          }
        }
      } as any);

      // Verify that child-cmd's post-script ran with the child-cmd directory as its working directory (cwd)
      expect(mockShellCwdHistory).toContain(join(tempDir, "commands/nested"));
    });
  });
});

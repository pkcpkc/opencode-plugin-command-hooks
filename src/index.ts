import { Plugin } from "@opencode-ai/plugin";
import { join } from "path";
import { resolveCommandAndArgs } from "./utils/args.js";
import { loadChainConfig } from "./utils/config.js";
import { runScript, PluginContext } from "./utils/scripts.js";


export interface CommandHooksOptions {
  /**
   * The directory where command chain configurations (.commands.json) and scripts (.pre.sh / .post.sh) are stored.
   * Defaults to ".opencode/commands"
   */
  commandsDirectory?: string;
  /**
   * Verbosity level for file logging and toast notifications.
   * Defaults to "error"
   */
  logLevel?: "debug" | "info" | "warn" | "error";
}

export const CommandHooksPlugin: Plugin = async ({ $, client, directory }, options: CommandHooksOptions = {}) => {
  const commandsDirectory = options.commandsDirectory || ".opencode/commands";
  const commandsDir = join(directory, commandsDirectory);
  
  const pendingCommands = new Map<string, { resolve: () => void; reject: (err: Error) => void }[]>();

  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  const CURRENT_LOG_LEVEL = options.logLevel || "error";

  const log = (
    message: string,
    level: "info" | "debug" | "warn" | "error" = "info",
    extra?: any,
  ) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[CURRENT_LOG_LEVEL]) return;
    client.app
      .log({
        body: { service: "command-hooks", level, message, extra },
      })
      .catch(() => {});
  };

  const showToast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", duration = 3000) => {
    if (client && client.tui && typeof client.tui.showToast === "function") {
      client.tui.showToast({
        body: { message, variant, duration }
      }).catch((e: any) => {
        log(`Failed to show TUI toast: ${e.message}`, "error");
      });
    }
  };

  // Build the clean context object to inject dependencies into helpers
  const ctx: PluginContext = {
    client,
    $,
    commandsDir,
    log,
    showToast
  };

  log(`Initializing plugin. CURRENT_LOG_LEVEL = ${CURRENT_LOG_LEVEL}, commandsDir = ${commandsDir}`, "info");

  const executeCommandAndWait = async (sessionID: string, command: string, argumentsStr: string) => {
    return new Promise<void>(async (resolve, reject) => {
      const normCmd = command.startsWith("/") ? command.slice(1) : command;

      if (!pendingCommands.has(normCmd)) {
        pendingCommands.set(normCmd, []);
      }
      
      pendingCommands.get(normCmd)!.push({ resolve, reject });

      try {
        await client.session.command({
          path: { id: sessionID },
          body: { command, arguments: argumentsStr }
        });
      } catch (err: any) {
        const resolvers = pendingCommands.get(normCmd) || [];
        const index = resolvers.findIndex(r => r.resolve === resolve);
        if (index !== -1) resolvers.splice(index, 1);
        reject(err);
      }
    });
  };

  const runPreCommands = async (cmdName: string, sessionID?: string, args: string = "") => {
    if (!sessionID) return;
    const config = await loadChainConfig(commandsDir, cmdName, log);
    if (config?.pre && config.pre.length > 0) {
      for (const preCmd of config.pre) {
        log(`[Chain] Starting dependent pre-command: ${preCmd}`, "info");
        showToast(`Running pre-command: ${preCmd}...`, "info", 5000);
        try {
          const resolved = resolveCommandAndArgs(preCmd, args);
          await executeCommandAndWait(sessionID, resolved.command, resolved.arguments);
        } catch (err: any) {
          log(`[Chain] Pre-command ${preCmd} failed`, "error", { error: err.message });
          showToast(`Pre-command ${preCmd} failed`, "error", 5000);
          throw new Error(`Chain aborted due to error in pre-command ${preCmd}: ${err.message}`);
        }
      }
    }
  };

  const runPostCommands = async (cmdName: string, sessionID?: string, args: string = "") => {
    if (!sessionID) return;
    const config = await loadChainConfig(commandsDir, cmdName, log);
    if (config?.post && config.post.length > 0) {
      for (const postCmd of config.post) {
        log(`[Chain] Starting dependent post-command: ${postCmd}`, "info");
        showToast(`Running post-command: ${postCmd}...`, "info", 5000);
        try {
          const resolved = resolveCommandAndArgs(postCmd, args);
          await executeCommandAndWait(sessionID, resolved.command, resolved.arguments);
        } catch (err: any) {
          log(`[Chain] Post-command ${postCmd} failed`, "error", { error: err.message });
          showToast(`Post-command ${postCmd} failed`, "error", 5000);
        }
      }
    }
  };

  log("Plugin initialized - Tracking commands");

  return {
    name: "Command Hooks",
    description: "Automatically executes pre/post scripts and commands for OpenCode commands.",
    "command.execute.before": async (input) => {
      const args = input.arguments || "";
      log(`Command execution started: ${input.command}`, "debug");
      
      // 1. JSON check and pre-commands execution
      await runPreCommands(input.command, input.sessionID, args);
      
      // 2. Main command's pre-script execution
      await runScript(ctx, "pre", input.command, input.sessionID, args);
    },
    event: async ({ event }) => {
      if (event.type === "command.executed") {
        const props = (event as any).properties || (event as any).data || {};
        const rawCmdName = props.name || props.command;
        if (!rawCmdName) return;

        const cmdName = rawCmdName.startsWith("/") ? rawCmdName.slice(1) : rawCmdName;
        const sessionID = props.sessionID;
        const args = props.text || props.arguments || "";

        // 1. If this was a chained command, resolve its pending execution promise
        if (pendingCommands.has(cmdName)) {
          const resolvers = pendingCommands.get(cmdName);
          const resolver = resolvers?.shift();
          if (resolvers && resolvers.length === 0) {
            pendingCommands.delete(cmdName);
          }
          if (resolver) {
            const isFailure = props.exitCode !== undefined && props.exitCode !== 0;
            if (isFailure) {
              resolver.reject(new Error(`Command ${cmdName} failed with exit code ${props.exitCode}`));
            } else {
              resolver.resolve();
            }
          }
        }

        // 2. Trigger the standard post hooks for the command that just completed
        await runScript(ctx, "post", cmdName, sessionID, args);
        await runPostCommands(cmdName, sessionID, args);
      }
    },
  };
};

export default CommandHooksPlugin;

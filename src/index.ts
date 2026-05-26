import { Plugin } from "@opencode-ai/plugin";
import { existsSync, promises as fs } from "fs";
import { join } from "path";

export function parseArguments(argsStr: string): string[] {
  const result: string[] = [];
  let current = "";
  let inDoubleQuotes = false;
  let inSingleQuotes = false;
  let escaped = false;
  let seenCharInToken = false;

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];

    if (escaped) {
      current += char;
      escaped = false;
      seenCharInToken = true;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      seenCharInToken = true;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      seenCharInToken = true;
      continue;
    }

    if (char === ' ' && !inDoubleQuotes && !inSingleQuotes) {
      if (seenCharInToken || current.length > 0) {
        result.push(current);
        current = "";
        seenCharInToken = false;
      }
    } else {
      current += char;
      seenCharInToken = true;
    }
  }

  if (seenCharInToken || current.length > 0) {
    result.push(current);
  }

  return result;
}

export function resolveCommandAndArgs(preCmd: string, parentArgsStr: string): { command: string, arguments: string } {
  const parsedPreCmd = parseArguments(preCmd);
  if (parsedPreCmd.length === 0) {
    return { command: "", arguments: "" };
  }

  const childCmdName = parsedPreCmd[0];
  const childCmdArgTemplates = parsedPreCmd.slice(1);
  const parsedParentArgs = parseArguments(parentArgsStr);

  const substitutedArgs = childCmdArgTemplates.map(argTemplate => {
    let resolved = argTemplate.replace(/\$(\d+)/g, (_, num) => {
      const idx = parseInt(num, 10) - 1;
      return parsedParentArgs[idx] !== undefined ? parsedParentArgs[idx] : "";
    });

    const isFullArgsPlaceholder = /\$(args|@|\*)/.test(resolved);
    resolved = resolved.replace(/\$(args|@|\*)/g, () => {
      return parentArgsStr;
    });
    
    // If the resolved argument contains spaces and is not already quoted, we quote it
    // But we bypass this if the placeholder represented the entire arguments string ($args, etc.)
    if (!isFullArgsPlaceholder && resolved.includes(" ") && !resolved.startsWith('"') && !resolved.startsWith("'")) {
      return `"${resolved.replace(/"/g, '\\"')}"`;
    }
    return resolved;
  });

  return {
    command: childCmdName,
    arguments: substitutedArgs.join(" ")
  };
}

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
  
  let lastCommandName: string | null = null;

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

  log(`Initializing plugin. CURRENT_LOG_LEVEL = ${CURRENT_LOG_LEVEL}, commandsDir = ${commandsDir}`, "info");

  const showToast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", duration = 3000) => {
    if (client && client.tui && typeof client.tui.showToast === "function") {
      client.tui.showToast({
        body: { message, variant, duration }
      }).catch((e: any) => {
        log(`Failed to show TUI toast: ${e.message}`, "error");
      });
    }
  };

  const logToSession = async (sessionID: string, title: string, result: { stdout: string, stderr: string, exitCode: number }) => {
    const output = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
    if (!output) return;

    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: output }],
          noReply: true
        }
      });
    } catch (e: any) {
      log(`Failed to log to session`, "error", { error: e.message });
    }
  };

  log("Plugin initialized - Tracking commands");

  const loadChainConfig = async (commandName: string): Promise<{ pre?: string[]; post?: string[] } | null> => {
    const normalized = commandName.startsWith("/") ? commandName.slice(1) : commandName;
    const configPath = join(commandsDir, `${normalized}.commands.json`);
    if (!existsSync(configPath)) return null;
    try {
      const content = await fs.readFile(configPath, "utf-8");
      return JSON.parse(content);
    } catch (e: any) {
      log(`Failed to parse chain config: ${configPath}`, "error", { error: e.message });
      return null;
    }
  };

  const runPreCommands = async (cmdName: string, sessionID?: string, args: string = "") => {
    if (!sessionID) return;
    const config = await loadChainConfig(cmdName);
    if (config?.pre && config.pre.length > 0) {
      for (const preCmd of config.pre) {
        log(`[Chain] Starting dependent pre-command: ${preCmd}`, "info");
        showToast(`Running pre-command: ${preCmd}...`, "info", 5000);
        try {
          const resolved = resolveCommandAndArgs(preCmd, args);
          await client.session.command({
            path: { id: sessionID },
            body: { command: resolved.command, arguments: resolved.arguments }
          });
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
    const config = await loadChainConfig(cmdName);
    if (config?.post && config.post.length > 0) {
      for (const postCmd of config.post) {
        log(`[Chain] Starting dependent post-command: ${postCmd}`, "info");
        showToast(`Running post-command: ${postCmd}...`, "info", 5000);
        try {
          const resolved = resolveCommandAndArgs(postCmd, args);
          await client.session.command({
            path: { id: sessionID },
            body: { command: resolved.command, arguments: resolved.arguments }
          });
        } catch (err: any) {
          log(`[Chain] Post-command ${postCmd} failed`, "error", { error: err.message });
          showToast(`Post-command ${postCmd} failed`, "error", 5000);
        }
      }
    }
  };

  const runPreScript = async (cmdName: string, sessionID?: string, args: string = "") => {
    const normalized = cmdName.startsWith("/") ? cmdName.slice(1) : cmdName;
    const preScript = join(commandsDir, `${normalized}.pre.sh`);

    if (existsSync(preScript)) {
      log(`Running pre-script for ${normalized}`, "info", { script: preScript });
      showToast(`Running pre-script for ${normalized}...`, "info", 600000);
      
      try {
        const parsedArgs = parseArguments(args);
        const result = await $`bash ${preScript} ${parsedArgs}`.quiet().nothrow();
        const stdout = result.stdout.toString();
        const stderr = result.stderr.toString();
        
        log(`Pre-script finished`, "info", {
          exitCode: result.exitCode,
          stdout,
          stderr,
        });

        if (sessionID) {
          await logToSession(sessionID, `Pre-script: ${normalized}`, {
            stdout,
            stderr,
            exitCode: result.exitCode
          });
        }
        
        if (result.exitCode === 0) {
          showToast(`Pre-script ${normalized} finished`, "success", 3000);
        } else {
          showToast(`Pre-script ${normalized} failed`, "error", 5000);
          throw new Error(`Pre-script ${normalized} failed with exit code ${result.exitCode}`);
        }
        
        return stdout;
      } catch (error: any) {
        log(`Pre-script error`, "error", { error: error.message });
        showToast(`Pre-script error for ${normalized}`, "error", 5000);
        throw error;
      }
    }
    return null;
  };

  const runPostScript = async (cmdName: string, sessionID?: string, args: string = "") => {
    const normalized = cmdName.startsWith("/") ? cmdName.slice(1) : cmdName;
    const postScript = join(commandsDir, `${normalized}.post.sh`);

    if (existsSync(postScript)) {
      log(`Running post-script for ${normalized}`, "info", { script: postScript });
      showToast(`Running post-script for ${normalized}...`, "info", 600000);

      try {
        const parsedArgs = parseArguments(args);
        const result = await $`bash ${postScript} ${parsedArgs}`.quiet().nothrow();
        const stdout = result.stdout.toString();
        const stderr = result.stderr.toString();

        log(`Post-script finished`, "info", {
          exitCode: result.exitCode,
          stdout,
          stderr,
        });

        if (sessionID) {
          await logToSession(sessionID, `Post-script: ${normalized}`, {
            stdout,
            stderr,
            exitCode: result.exitCode
          });
        }
        
        if (result.exitCode === 0) {
          showToast(`Post-script ${normalized} finished`, "success", 3000);
        } else {
          showToast(`Post-script ${normalized} failed`, "error", 5000);
        }
      } catch (error: any) {
        log(`Post-script error`, "error", { error: error.message });
        showToast(`Post-script error for ${normalized}`, "error", 5000);
      }
    }
  };

  return {
    name: "Command Hooks",
    description: "Automatically executes pre/post scripts and commands for OpenCode commands.",
    "command.execute.before": async (input) => {
      lastCommandName = input.command;
      const args = input.arguments || "";
      log(`Command execution started: ${lastCommandName}`, "debug");
      
      // 1. JSON check and pre-commands execution
      await runPreCommands(lastCommandName, input.sessionID, args);
      
      // 2. Main command's pre.sh script execution
      await runPreScript(lastCommandName, input.sessionID, args);
    },
    event: async ({ event }) => {
      if (event.type === "command.executed") {
        const props = (event as any).properties || (event as any).data || {};
        const cmdName = props.name || props.command || lastCommandName;
        const sessionID = props.sessionID;
        const args = props.text || props.arguments || "";
        
        if (cmdName) {
          // 3. Main command's post.sh script execution
          await runPostScript(cmdName, sessionID, args);
          
          // 4. JSON check and post-commands execution
          await runPostCommands(cmdName, sessionID, args);
          
          if (cmdName === lastCommandName) lastCommandName = null;
        }
      }
    },
  };
};

export default CommandHooksPlugin;

import { Plugin } from "@opencode-ai/plugin";
import { existsSync, appendFileSync, promises as fs } from "fs";
import { join } from "path";

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
  /**
   * Path to the log file.
   * Defaults to ".opencode/plugins/commandHooks.log"
   */
  logFilePath?: string;
}

export const CommandHooksPlugin: Plugin = async ({ $, client, directory }, options: CommandHooksOptions = {}) => {
  const commandsDirectory = options.commandsDirectory || ".opencode/commands";
  const logFilePath = options.logFilePath || ".opencode/plugins/commandHooks.log";
  
  const commandsDir = join(directory, commandsDirectory);
  const logFile = join(directory, logFilePath);
  
  let lastCommandName: string | null = null;

  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  const CURRENT_LOG_LEVEL = options.logLevel || "error";

  const log = (
    message: string,
    level: "info" | "debug" | "warn" | "error" = "info",
    extra?: any,
  ) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[CURRENT_LOG_LEVEL]) return;
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}][${level.toUpperCase()}] ${message} ${extra ? JSON.stringify(extra) : ""}\n`;
    try {
      // Ensure parents exist and write
      appendFileSync(logFile, logEntry);
    } catch (e) {}
    client.app
      .log({
        body: { service: "command-hooks", level, message, extra },
      })
      .catch(() => {});
  };

  const showToast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", duration = 3000) => {
    const variantLevel = variant === "success" ? "info" : variant === "warning" ? "warn" : variant;
    if (LOG_LEVELS[variantLevel] < LOG_LEVELS[CURRENT_LOG_LEVEL]) return;

    client.tui.showToast({
      body: { message, variant, duration }
    }).catch(() => {});
  };

  const logToSession = async (sessionID: string, title: string, result: { stdout: string, stderr: string, exitCode: number }) => {
    const isSuccess = result.exitCode === 0;
    const divider = "----------------------------------------";

    let text = `${divider}\n`;
    text += `${title}\n`;
    text += `${divider}\n\n`;

    if (result.stdout.trim() || result.stderr.trim()) {
      if (result.stdout.trim()) text += `${result.stdout.trim()}\n`;
      if (result.stderr.trim()) text += `${result.stderr.trim()}\n`;
    } else {
      text += `(No output)\n`;
    }

    text += `\n${divider}\n`;
    if (isSuccess) {
      text += `[OK] Success`;
    } else {
      text += `[FAIL] Exit code: ${result.exitCode}`;
    }

    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text }],
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
          await client.session.command({
            path: { id: sessionID },
            body: { command: preCmd, arguments: args }
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
          await client.session.command({
            path: { id: sessionID },
            body: { command: postCmd, arguments: args }
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
        const result = await $`bash ${preScript} ${args}`.quiet().nothrow();
        const stdout = result.stdout.toString();
        const stderr = result.stderr.toString();
        
        log(`Pre-script finished`, "info", {
          exitCode: result.exitCode,
          stdout,
          stderr,
        });

        if (sessionID && (result.exitCode !== 0 || LOG_LEVELS["info"] >= LOG_LEVELS[CURRENT_LOG_LEVEL])) {
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
        const result = await $`bash ${postScript} ${args}`.quiet().nothrow();
        const stdout = result.stdout.toString();
        const stderr = result.stderr.toString();

        log(`Post-script finished`, "info", {
          exitCode: result.exitCode,
          stdout,
          stderr,
        });

        if (sessionID && (result.exitCode !== 0 || LOG_LEVELS["info"] >= LOG_LEVELS[CURRENT_LOG_LEVEL])) {
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

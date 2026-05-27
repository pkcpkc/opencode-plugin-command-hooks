import { existsSync } from "fs";
import { join } from "path";
import { parseArguments } from "./args.js";

export interface PluginContext {
  client: any;
  $: any;
  commandsDir: string;
  log: (message: string, level?: "info" | "debug" | "warn" | "error", extra?: any) => void;
  showToast: (message: string, variant?: "info" | "success" | "warning" | "error", duration?: number) => void;
}

export const logToSession = async (
  ctx: PluginContext,
  sessionID: string,
  title: string,
  result: { stdout: string, stderr: string, exitCode: number }
) => {
  const output = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
  if (!output) return;

  try {
    await ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: output }],
        noReply: true
      }
    });
  } catch (e: any) {
    ctx.log(`Failed to log to session`, "error", { error: e.message });
  }
};

export const runScript = async (
  ctx: PluginContext,
  type: "pre" | "post",
  cmdName: string,
  sessionID?: string,
  args: string = ""
): Promise<string | null> => {
  const normalized = cmdName.startsWith("/") ? cmdName.slice(1) : cmdName;
  const scriptPath = join(ctx.commandsDir, `${normalized}.${type}.sh`);
  const label = type === "pre" ? "Pre-script" : "Post-script";

  if (existsSync(scriptPath)) {
    ctx.log(`Running ${type}-script for ${normalized}`, "info", { script: scriptPath });
    ctx.showToast(`Running ${type}-script for ${normalized}...`, "info", 600000);

    try {
      const parsedArgs = parseArguments(args);
      const result = await ctx.$`bash ${scriptPath} ${parsedArgs}`.quiet().nothrow();
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();

      ctx.log(`${label} finished`, "info", {
        exitCode: result.exitCode,
        stdout,
        stderr,
      });

      if (sessionID) {
        await logToSession(ctx, sessionID, `${label}: ${normalized}`, {
          stdout,
          stderr,
          exitCode: result.exitCode
        });
      }

      if (result.exitCode === 0) {
        ctx.showToast(`${label} ${normalized} finished`, "success", 3000);
      } else {
        ctx.showToast(`${label} ${normalized} failed`, "error", 5000);
        if (type === "pre") {
          throw new Error(`${label} ${normalized} failed with exit code ${result.exitCode}`);
        }
      }

      return stdout;
    } catch (error: any) {
      ctx.log(`${label} error`, "error", { error: error.message });
      ctx.showToast(`${label} error for ${normalized}`, "error", 5000);
      if (type === "pre") {
        throw error;
      }
    }
  }
  return null;
};

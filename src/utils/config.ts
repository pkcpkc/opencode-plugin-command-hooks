import { existsSync, promises as fs } from "fs";
import { join } from "path";

export interface ChainConfig {
  pre?: string[];
  post?: string[];
}

export const loadChainConfig = async (
  commandsDir: string,
  commandName: string,
  log: (message: string, level?: "info" | "debug" | "warn" | "error", extra?: any) => void
): Promise<ChainConfig | null> => {
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

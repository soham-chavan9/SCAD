import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ScadConfig = {
  apiUrl: string;
  pat: string;
};

export function defaultConfigPath(): string {
  return (
    process.env["SCAD_CONFIG"] ?? join(homedir(), ".config", "scad", "config.json")
  );
}

export async function loadConfig(path = defaultConfigPath()): Promise<ScadConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ScadConfig;
    if (typeof parsed.apiUrl === "string" && typeof parsed.pat === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveConfig(
  config: ScadConfig,
  path = defaultConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

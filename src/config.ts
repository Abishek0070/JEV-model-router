import fs from "node:fs";
import YAML from "yaml";
import type { AppConfig } from "./types.js";

export function loadConfig(): AppConfig {
  const path = process.env.CONFIG_PATH || "./config.example.yaml";
  const raw = fs.readFileSync(path, "utf8");
  const cfg = YAML.parse(raw) as AppConfig;
  const port = Number(process.env.PORT || cfg.server?.port || 4000);
  cfg.server.port = port;
  return cfg;
}

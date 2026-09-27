#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// jev-model-router CLI: `init` scaffolds config, `start` runs the gateway.
// Usage:
//   npx @abishek0070/jev-router init [--config ./jev-router.config.yaml]
//   npx @abishek0070/jev-router start [--port 4000] [--config ./jev-router.config.yaml]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pkgRoot(): string {
  // dist/src/cli.js -> package root
  return path.resolve(__dirname, "..", "..");
}

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => {
    rl.close();
    res(a.trim());
  }));
}

async function init(): Promise<void> {
  const cwd = process.cwd();
  const configTarget = path.resolve(cwd, arg("--config") || "./jev-router.config.yaml");
  if (!fs.existsSync(configTarget)) {
    fs.copyFileSync(path.join(pkgRoot(), "config.example.yaml"), configTarget);
    console.log(`created ${configTarget}`);
  } else {
    console.log(`kept existing ${configTarget}`);
  }

  const envPath = path.join(cwd, ".env");
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const need = (k: string, v: string): void => {
    if (!new RegExp(`^${k}=`, "m").test(env)) env += `${env.endsWith("\n") || env === "" ? "" : "\n"}${k}=${v}\n`;
  };

  let key = process.env.JEV_API_KEY || "";
  if (!key && process.stdin.isTTY) {
    key = await ask("JEV API key (TypeSafe, Enter to skip — local heuristic routes until then): ");
  }
  need("JEV_API_KEY", key);
  need("CONFIG_PATH", path.relative(cwd, configTarget) || "./jev-router.config.yaml");
  need("PORT", "4000");
  fs.writeFileSync(envPath, env);
  console.log(`wrote ${envPath}`);
  console.log("\nNext:");
  console.log("  1. Add one LLM key to .env (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY) or run Ollama.");
  console.log("  2. npx @abishek0070/jev-router start");
  console.log("  3. Verify routing (no LLM spend): POST /v1/routing/decision");
}

async function start(): Promise<void> {
  const { loadDotEnv } = await import("./dotenv.js");
  loadDotEnv();
  const port = arg("--port");
  const config = arg("--config");
  if (port) process.env.PORT = port;
  if (config) process.env.CONFIG_PATH = config;
  await import("./server.js");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || "start";
  if (cmd === "init") return init();
  if (cmd === "start" || cmd === "--help" || cmd === "-h") {
    if (cmd !== "start") {
      console.log("jev-model-router: init | start [--port 4000] [--config ./jev-router.config.yaml]");
      return;
    }
    return start();
  }
  console.error(`unknown command: ${cmd} (use init | start)`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

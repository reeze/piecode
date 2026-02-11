#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(opts.env || {}) };
    const child = spawn(cmd, args, {
      ...opts,
      stdio: "inherit",
      shell: false,
      env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function getArg(flag, argv) {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  return argv[index + 1] || null;
}

async function resolveTarball(cwd) {
  const manifestPath = path.join(cwd, "dist", "build-manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest?.tarball) {
    throw new Error("build-manifest.json missing tarball field. Run npm run build first.");
  }
  return path.join(cwd, "dist", String(manifest.tarball));
}

async function main() {
  const argv = process.argv.slice(2);
  const skipBuild = argv.includes("--skip-build");
  const prefixArg = getArg("--prefix", argv);
  const prefix = path.resolve(prefixArg || path.join(os.homedir(), ".local", "piecode"));

  const cwd = process.cwd();
  const npmCacheDir = path.join(cwd, ".npm-cache");
  const npmEnv = {
    NPM_CONFIG_CACHE: npmCacheDir,
    npm_config_cache: npmCacheDir,
  };
  await fs.mkdir(npmCacheDir, { recursive: true });

  if (!skipBuild) {
    await run("npm", ["run", "build", "--", "--skip-tests"], { cwd, env: npmEnv });
  }

  const tarballPath = await resolveTarball(cwd);
  await fs.mkdir(prefix, { recursive: true });

  await run("npm", ["install", "--prefix", prefix, "--omit=dev", tarballPath], {
    cwd,
    env: npmEnv,
  });

  const binDir = path.join(prefix, "bin");
  console.log(`Installed to: ${prefix}`);
  console.log(`Binary path: ${path.join(binDir, "piecode")}`);
  console.log(`Add to PATH if needed: export PATH="${binDir}:$PATH"`);
}

main().catch((err) => {
  console.error(`install-local failed: ${err.message}`);
  process.exit(1);
});

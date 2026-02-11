#!/usr/bin/env node
import { promises as fs } from "node:fs";
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

async function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(opts.env || {}) };
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d || "");
    });
    child.stderr.on("data", (d) => {
      stderr += String(d || "");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code})\n${stderr}`));
    });
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const skipTests = args.has("--skip-tests");
  const workspace = process.cwd();
  const distDir = path.join(workspace, "dist");
  const npmCacheDir = path.join(workspace, ".npm-cache");
  const npmEnv = {
    NPM_CONFIG_CACHE: npmCacheDir,
    npm_config_cache: npmCacheDir,
  };

  const pkgRaw = await fs.readFile(path.join(workspace, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);

  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });
  await fs.mkdir(npmCacheDir, { recursive: true });

  if (!skipTests) {
    await run("npm", ["test", "--", "--runInBand"], { cwd: workspace, env: npmEnv });
  }

  const { stdout: packStdout } = await runCapture(
    "npm",
    ["pack", "--json", "--pack-destination", distDir],
    { cwd: workspace, env: npmEnv }
  );

  let packEntry = null;
  try {
    const parsed = JSON.parse(packStdout);
    if (Array.isArray(parsed) && parsed.length > 0) {
      packEntry = parsed[0];
    }
  } catch {
    // ignore parse failures
  }

  const tarball = packEntry?.filename ? path.join(distDir, packEntry.filename) : null;
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    tarball: tarball ? path.basename(tarball) : null,
    files: packEntry?.files?.length || null,
    size: packEntry?.size || null,
  };
  await fs.writeFile(path.join(distDir, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const readme = [
    `Build complete for ${pkg.name}@${pkg.version}`,
    tarball ? `Tarball: ${path.relative(workspace, tarball)}` : "Tarball: (not found)",
    "Manifest: dist/build-manifest.json",
  ].join("\n");
  await fs.writeFile(path.join(distDir, "README.txt"), `${readme}\n`, "utf8");

  console.log(readme);
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
});

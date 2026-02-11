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

function getArg(flag, argv) {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  return argv[index + 1] || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const publish = argv.includes("--publish");
  const skipBuild = argv.includes("--skip-build");
  const skipTests = argv.includes("--skip-tests");
  const tag = getArg("--tag", argv);
  const otp = getArg("--otp", argv);

  const cwd = process.cwd();
  const npmCacheDir = path.join(cwd, ".npm-cache");
  const npmEnv = {
    NPM_CONFIG_CACHE: npmCacheDir,
    npm_config_cache: npmCacheDir,
  };
  await fs.mkdir(npmCacheDir, { recursive: true });
  if (!skipBuild) {
    const buildArgs = ["run", "build"];
    if (skipTests) buildArgs.push("--", "--skip-tests");
    await run("npm", buildArgs, { cwd, env: npmEnv });
  }

  const manifestPath = path.join(cwd, "dist", "build-manifest.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);
  if (!manifest?.tarball) {
    throw new Error("build-manifest.json does not contain tarball info");
  }
  const tarballPath = path.join(cwd, "dist", manifest.tarball);

  if (!publish) {
    console.log("Release dry-run complete.");
    console.log(`Artifact: ${path.relative(cwd, tarballPath)}`);
    console.log("To publish:");
    console.log(`  npm run release -- --publish${tag ? ` --tag ${tag}` : ""}${otp ? " --otp <code>" : ""}`);
    return;
  }

  const publishArgs = ["publish", tarballPath];
  if (tag) publishArgs.push("--tag", tag);
  if (otp) publishArgs.push("--otp", otp);
  await run("npm", publishArgs, { cwd, env: npmEnv });

  console.log(`Published ${manifest.name}@${manifest.version}`);
}

main().catch((err) => {
  console.error(`release failed: ${err.message}`);
  process.exit(1);
});

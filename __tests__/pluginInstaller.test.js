import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { discoverPlugins } from "../src/lib/plugins.js";
import { installPlugin, updatePlugin, derivePluginNameFromSource } from "../src/lib/pluginInstaller.js";

describe("plugin installer", () => {
  test("installs a local plugin directory by copying it into target root", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-plugin-install-"));
    const source = path.join(tmp, "source-plugin");
    const targetRoot = path.join(tmp, "installed");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(source + "/PLUGIN.md", "---\nname: demo-plugin\ndescription: Demo\n---\n\nDemo plugin\n", "utf8");

    const result = await installPlugin({ source, targetRoot });

    expect(result).toMatchObject({ ok: true, name: "demo-plugin" });
    const index = await discoverPlugins([targetRoot]);
    expect(index.has("demo-plugin")).toBe(true);
  });

  test("derives a safe plugin name from git and path sources", () => {
    expect(derivePluginNameFromSource("https://github.com/acme/super-plugin.git")).toBe("super-plugin");
    expect(derivePluginNameFromSource("/tmp/My Plugin")).toBe("my-plugin");
  });

  test("update runs git pull for git-backed plugins", async () => {
    const calls = [];
    const plugin = { name: "demo", baseDir: "/plugins/demo" };
    const execFile = async (bin, args) => {
      calls.push([bin, args]);
      return { stdout: "Already up to date.\n", stderr: "" };
    };
    const exists = async (target) => target === "/plugins/demo/.git";

    const result = await updatePlugin({ plugin, execFile, pathExists: exists });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([["git", ["-C", "/plugins/demo", "pull", "--ff-only"]]]);
  });

  test("update reports unsupported for non-git plugin directories", async () => {
    const result = await updatePlugin({
      plugin: { name: "demo", baseDir: "/plugins/demo" },
      pathExists: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-git");
  });
});

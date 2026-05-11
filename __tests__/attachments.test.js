import { promises as fs } from "node:fs";

describe("clipboard attachment support", () => {
  test("linux clipboard reader tries wl-paste, xclip, and xsel", async () => {
    const script = await fs.readFile("src/lib/attachments.js", "utf8");

    expect(script).toContain('command: "wl-paste"');
    expect(script).toContain('command: "xclip"');
    expect(script).toContain('command: "xsel"');
    expect(script).toContain('["--no-newline", "--type", "image/png"]');
    expect(script).toContain('["-selection", "clipboard", "-t", "image/png", "-o"]');
    expect(script).toContain('["--clipboard", "--output", "--mime-type", "image/png"]');
    expect(script).toContain('No supported clipboard image command found on Linux (tried wl-paste, xclip, xsel).');
  });

  test("tui attach image failure hint mentions the expanded Linux command set", async () => {
    const script = await fs.readFile("src/cli.js", "utf8");

    expect(script).toContain('hint: on Linux install wl-paste, xclip, or xsel, then copy an image to the clipboard');
    expect(script).toContain('hint: copy an image to the macOS clipboard, then run /attach image');
    expect(script).toContain('hint: copy an image to the Windows clipboard, then run /attach image');
  });
});

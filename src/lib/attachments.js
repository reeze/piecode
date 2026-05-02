import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CLIPBOARD_IMAGE_BYTES = Math.max(
  1,
  Number.parseInt(process.env.PIECODE_CLIPBOARD_IMAGE_MAX_BYTES || "10485760", 10) || 10485760
);

const IMAGE_SIGNATURES = [
  { mimeType: "image/png", ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: "image/jpeg", ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/gif", ext: "gif", ascii: "GIF" },
  { mimeType: "image/webp", ext: "webp", asciiAt: [0, "RIFF"], asciiAt2: [8, "WEBP"] },
];

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.bytes && sig.bytes.every((byte, idx) => buffer[idx] === byte)) {
      return { mimeType: sig.mimeType, ext: sig.ext };
    }
    if (sig.ascii && buffer.subarray(0, sig.ascii.length).toString("ascii") === sig.ascii) {
      return { mimeType: sig.mimeType, ext: sig.ext };
    }
    if (
      sig.asciiAt &&
      sig.asciiAt2 &&
      buffer.subarray(sig.asciiAt[0], sig.asciiAt[0] + sig.asciiAt[1].length).toString("ascii") === sig.asciiAt[1] &&
      buffer.subarray(sig.asciiAt2[0], sig.asciiAt2[0] + sig.asciiAt2[1].length).toString("ascii") === sig.asciiAt2[1]
    ) {
      return { mimeType: sig.mimeType, ext: sig.ext };
    }
  }
  return null;
}

async function runClipboardCommand(command, args, { encoding = "buffer" } = {}) {
  const { stdout } = await execFileAsync(command, args, {
    encoding,
    maxBuffer: Math.max(MAX_CLIPBOARD_IMAGE_BYTES + 1024 * 1024, 2 * 1024 * 1024),
    timeout: 5000,
  });
  return stdout;
}

async function readClipboardImageMac() {
  const tempPath = path.join(
    os.tmpdir(),
    `piecode-clipboard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.img`
  );
  const escapedPath = tempPath.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const script = [
    "set imageTypes to {«class PNGf», «class JPEG», GIF picture}",
    "repeat with imageType in imageTypes",
    "  try",
    "    set imageData to the clipboard as imageType",
    `    set outFile to open for access POSIX file \"${escapedPath}\" with write permission`,
    "    set eof of outFile to 0",
    "    write imageData to outFile",
    "    close access outFile",
    "    return",
    "  on error",
    "    try",
    "      close access outFile",
    "    end try",
    "  end try",
    "end repeat",
    "error \"Clipboard does not contain an image.\"",
  ].join("\n");
  try {
    await runClipboardCommand("osascript", ["-e", script], { encoding: "utf8" });
    return await fs.readFile(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function readClipboardImageLinux() {
  const attempts = [
    ["png", ["-selection", "clipboard", "-t", "image/png", "-o"]],
    ["png", ["-selection", "clipboard", "-t", "image/jpeg", "-o"]],
  ];
  let lastErr = null;
  for (const [, args] of attempts) {
    try {
      return await runClipboardCommand("xclip", args);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Clipboard does not contain an image.");
}

async function readClipboardImageWindows() {
  const tempPath = path.join(
    os.tmpdir(),
    `piecode-clipboard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  );
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $img) { exit 2 }",
    `$img.Save('${tempPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join("; ");
  try {
    await runClipboardCommand("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    return await fs.readFile(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

export async function readClipboardImage() {
  let buffer;
  if (process.platform === "darwin") buffer = await readClipboardImageMac();
  else if (process.platform === "win32") buffer = await readClipboardImageWindows();
  else buffer = await readClipboardImageLinux();

  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || "", "binary");
  if (buffer.length === 0) throw new Error("Clipboard does not contain image data.");
  if (buffer.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error(
      `Clipboard image is too large (${buffer.length} bytes; max ${MAX_CLIPBOARD_IMAGE_BYTES} bytes).`
    );
  }
  const detected = detectImageType(buffer);
  if (!detected) throw new Error("Clipboard data is not a supported image (png, jpeg, gif, webp).");
  return {
    type: "image",
    source: "clipboard",
    mimeType: detected.mimeType,
    data: buffer.toString("base64"),
    bytes: buffer.length,
  };
}

export function formatAttachmentSummary(attachment) {
  if (!attachment || attachment.type !== "image") return "attachment";
  const kb = Math.max(1, Math.round(Number(attachment.bytes || 0) / 1024));
  return `${attachment.mimeType} ${kb}KB`;
}

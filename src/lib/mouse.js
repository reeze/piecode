export function consumeMouseWheelDeltas(chunk, previousRemainder = "") {
  const input = `${previousRemainder}${String(chunk || "")}`;
  const deltas = [];
  let remainder = "";
  let cursor = 0;

  while (cursor < input.length) {
    const escIndex = input.indexOf("\x1b[<", cursor);
    if (escIndex === -1) {
      break;
    }

    const candidate = input.slice(escIndex);
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/.exec(candidate);
    if (!match) {
      // Incomplete SGR mouse sequence: keep tail for next chunk.
      remainder = candidate;
      break;
    }

    const buttonCode = Number.parseInt(match[1], 10);
    const eventType = match[4];
    // Wheel events are reported with bit 6 set; low 2 bits encode direction.
    if (eventType === "M" && (buttonCode & 64) === 64) {
      const wheelDirection = buttonCode & 3;
      if (wheelDirection === 0) deltas.push(1);
      else if (wheelDirection === 1) deltas.push(-1);
    }

    cursor = escIndex + match[0].length;
  }

  return { deltas, remainder };
}

export function stripMouseInputNoise(text) {
  let out = String(text || "");
  // Full SGR mouse sequences.
  out = out.replace(/\x1b\[<\d+;\d+;\d+[mM]/g, "");
  // Incomplete SGR mouse sequence tails.
  out = out.replace(/\x1b\[<[\d;]*$/g, "");
  // Legacy X10/VT200 mouse sequence: ESC [ M Cb Cx Cy
  out = out.replace(/\x1b\[M[\x00-\xff]{3}/g, "");
  // Incomplete legacy mouse tails.
  out = out.replace(/\x1b\[M[\x00-\xff]{0,2}$/g, "");
  // Generic CSI/SS3 control sequences that may leak into readline input.
  out = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  out = out.replace(/\x1bO[@-~]/g, "");
  // Partial trailing escapes.
  out = out.replace(/\x1b\[[0-9;?]*$/g, "");
  out = out.replace(/\x1bO?$/g, "");
  // Some readline paths can leave the payload without ESC.
  out = out.replace(/\[<\d+;\d+;\d+[mM]/g, "");
  out = out.replace(/\[<[\d;]*$/g, "");
  out = out.replace(/\[M[\x00-\xff]{3}/g, "");
  out = out.replace(/\[M[\x00-\xff]{0,2}$/g, "");
  // Some terminals/readline paths can leak bare SGR payload tokens without ESC/CSI.
  // Example: "0;44;13M0;47;13M"
  out = out.replace(/<?\d+;\d+;\d+[mM]/g, "");
  // Remove any remaining raw ESC.
  out = out.replace(/\x1b/g, "");
  // Strip remaining C0 controls that should never be in prompt text.
  out = out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return out;
}

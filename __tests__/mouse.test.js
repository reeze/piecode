import { consumeMouseWheelDeltas, stripMouseInputNoise } from "../src/lib/mouse.js";

describe("mouse wheel parser", () => {
  test("parses wheel up/down SGR events", () => {
    const input = "\x1b[<64;40;10M\x1b[<65;40;11M";
    const parsed = consumeMouseWheelDeltas(input, "");
    expect(parsed.deltas).toEqual([1, -1]);
    expect(parsed.remainder).toBe("");
  });

  test("supports modifier wheel events", () => {
    // 68 = 64 (wheel) + 4 (shift), still wheel-up.
    const parsed = consumeMouseWheelDeltas("\x1b[<68;20;5M", "");
    expect(parsed.deltas).toEqual([1]);
    expect(parsed.remainder).toBe("");
  });

  test("keeps incomplete sequences as remainder", () => {
    const first = consumeMouseWheelDeltas("abc\x1b[<64;10", "");
    expect(first.deltas).toEqual([]);
    expect(first.remainder).toBe("\x1b[<64;10");

    const second = consumeMouseWheelDeltas(";3M", first.remainder);
    expect(second.deltas).toEqual([1]);
    expect(second.remainder).toBe("");
  });

  test("strips mouse escape/control noise from input buffer", () => {
    const noisy = "hello\x1b[<64;40;10M world";
    expect(stripMouseInputNoise(noisy)).toBe("hello world");

    const leftover = "abc[<65;20;5M";
    expect(stripMouseInputNoise(leftover)).toBe("abc");

    const partial = "typed\x1b[<64;20";
    expect(stripMouseInputNoise(partial)).toBe("typed");

    const legacy = `abc\x1b[M${String.fromCharCode(32)}${String.fromCharCode(33)}${String.fromCharCode(34)}def`;
    expect(stripMouseInputNoise(legacy)).toBe("abcdef");

    const csi = "x\x1b[1;5Ay";
    expect(stripMouseInputNoise(csi)).toBe("xy");

    const bareSgrPayload = "0;44;13M0;44;13m0;47;13M0;50;12m";
    expect(stripMouseInputNoise(bareSgrPayload)).toBe("");
  });
});

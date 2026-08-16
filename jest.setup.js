// Terminal rendering tests assert on glyphs, widths and separators, all of
// which depend on whether the host terminal is treated as unicode-capable.
// Pin a UTF-8 capable TERM so the suite behaves the same on a developer
// machine, in CI, and inside a container where TERM defaults to "linux".
// Tests that exercise ASCII mode still opt in explicitly via PIECODE_TUI_ASCII.
process.env.TERM = process.env.PIECODE_TEST_TERM || 'xterm-256color';
process.env.LANG = process.env.LANG || 'en_US.UTF-8';

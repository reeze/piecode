---
name: rtk-token-saver
description: Transparently rewrites supported shell commands through RTK to reduce model-visible tool output.
enabledByDefault: true
context:
  mode: when-enabled
  maxChars: 1200
permissions:
  tools:
    allow: [shell]
---

RTK Token Saver uses a `PreToolUse` hook to rewrite supported shell commands via `rtk rewrite` before execution.

It is a thin adapter: all command selection and safety heuristics come from the installed `rtk` binary. If `rtk` is unavailable or does not support a command, the hook fails open and leaves the original command unchanged.

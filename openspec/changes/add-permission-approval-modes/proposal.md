# add-permission-approval-modes

## Summary

Improve shell permission management from simple yes/no approval to explicit approval modes: allow once, remember command for the current session, allow all for the current session, and auto mode that relies on command safety classification.

## Motivation

PieCode currently asks for shell approval with a binary yes/no flow. Users need a smoother workflow for repetitive safe commands while still protecting against destructive operations. The desired behavior is similar to Codex-style approval control: auto-detect safe commands, remember decisions when requested, and make dangerous commands stand out.

## Proposed Changes

- Introduce a session-scoped permission state for shell commands.
- Support these approval decisions when a command requires user interaction:
  - No / deny once.
  - Yes / allow once.
  - Remember command for current session.
  - Allow all shell commands for current session.
- Preserve existing `/approve on|off` behavior as auto-approval for unclassified commands.
- Keep safe commands auto-approved by existing command classifier.
- Keep dangerous commands approval-gated unless the user explicitly chooses allow-all for the session.
- Show clearer approval UI hints in TUI for once/session/all choices.
- Add non-TUI approval prompt that supports the same choices.

## Permission Modes

- `auto`: default behavior; safe commands are auto-approved, unclassified commands depend on `/approve on|off`, dangerous commands ask.
- `allow_all_session`: all shell commands are approved for the rest of the session.
- `remembered_commands`: exact normalized shell commands approved for the rest of the session.

## Safety Notes

- Persistence is session-only for this change. No disk persistence is added yet.
- Exact command matching is used for remembered commands to avoid accidentally approving broader patterns.
- Dangerous command classification should still be displayed in the approval prompt.

## Impact

- Repetitive commands such as test runs can be approved once and remembered for the session.
- Users can choose an explicit accept-all style flow when they trust the current task/session.
- Dangerous commands remain visible and intentional.

## Open Questions

- Should remembered commands eventually persist across sessions in `~/.piecode/settings.json`?
- Should remembered commands support patterns or only exact normalized commands?
- Should there be separate allow-all scopes for safe/unclassified/dangerous commands?

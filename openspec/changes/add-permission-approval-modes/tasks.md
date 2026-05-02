# add-permission-approval-modes Tasks

## Spec/design

- [x] Define session-scoped approval decisions.
- [x] Define interaction choices for TUI and non-TUI modes.
- [x] Keep existing command classifier semantics as the safety base.

## Implementation

- [x] Add shell permission session state.
- [x] Normalize commands before checking remembered approvals.
- [x] Extend `askApproval` return values beyond boolean while keeping compatibility.
- [x] Update shell approval logic to handle allow once, remember, and allow all.
- [x] Update TUI approval prompt hints for choice keys.
- [x] Update non-TUI approval prompt to accept once/session/all choices.
- [ ] Add or update slash command status for permission mode if needed.

## Validation

- [x] Add tests for remembered command approval.
- [x] Add tests for allow-all session approval.
- [x] Add tests that dangerous commands still ask unless explicitly allowed.
- [x] Run targeted tests for tools/CLI approval behavior.
- [x] Run full Jest suite.

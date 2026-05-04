# add-remote-control Tasks

## Spec/design

- [x] Create initial proposal for remote-control capability.
- [ ] Decide initial transport and message protocol.
- [ ] Define authentication and binding rules for local vs network access.
- [ ] Define remote permissions for prompts, slash commands, cancellation, and approval responses.
- [ ] Add spec deltas for remote-control behavior and protocol once design decisions are accepted.

## Implementation

- [ ] Add remote-control server lifecycle module.
- [ ] Add CLI/settings wiring to enable, configure, and display remote-control endpoint details.
- [ ] Route remote prompt and slash-command messages through existing session input handling.
- [ ] Publish session events to connected remote clients.
- [ ] Integrate approval request/response handling according to accepted permission design.
- [ ] Add cleanup on session exit and client disconnect.
- [ ] Update user documentation with setup, security notes, and client examples.

## Validation

- [ ] Add unit tests for remote-control server start/stop and configuration validation.
- [ ] Add tests for authentication/token rejection and accepted clients.
- [ ] Add tests for remote prompt/slash-command routing.
- [ ] Add tests for event streaming and approval behavior.
- [ ] Run targeted Jest tests for remote control and affected CLI/session modules.
- [ ] Run full Jest suite.

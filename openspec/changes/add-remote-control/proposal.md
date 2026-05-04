# add-remote-control

## Summary

Add an optional remote-control interface for PieCode so an external client can observe a running agent session and submit user commands/prompts without directly attaching to the local terminal UI.

## Motivation

PieCode currently centers on local terminal interaction. Remote control would enable integrations such as companion UIs, editor extensions, mobile/local-network control, automation dashboards, or supervised long-running sessions. The feature should preserve PieCode's existing safety model while exposing a small, explicit control surface.

## Proposed Changes

- Add an opt-in remote-control mode that starts a local control endpoint for an active PieCode session.
- Support remote clients sending user prompts or slash commands into the same session input path used by the interactive UI.
- Stream or publish session events to remote clients, including assistant output, tool calls, approval requests, command status, errors, and completion notifications.
- Require explicit local enablement before any remote-control endpoint is started.
- Bind locally by default and require explicit configuration for non-localhost binding.
- Protect the endpoint with a per-session authentication token or comparable shared secret.
- Keep shell/tool approval gates intact; remote clients may respond to approval prompts only when authorized for that session.
- Provide CLI configuration for enabling remote control, showing endpoint information, and disabling/stopping remote control.
- Keep the initial protocol minimal and versioned so clients can evolve independently.

## Impact

- Introduces a new optional runtime control surface and associated security boundary.
- Requires factoring session input/output events so both TUI/local CLI and remote clients can interact with the same running session safely.
- Adds tests for remote-control server lifecycle, authentication, message routing, and approval behavior.
- May require documentation updates for configuration, security expectations, and client protocol examples.

## Open Questions

- Should the transport be WebSocket, Server-Sent Events plus HTTP POST, stdio over a spawned process, or another protocol?
- Should remote control support only localhost in the first version, or allow explicitly configured network binding?
- Should a remote client be allowed to answer shell approval prompts, or should approvals remain local-only by default?
- Should this feature control an already-running TUI session, launch a headless session, or support both?
- Where should remote-control settings live: CLI flags only, `~/.piecode/settings.json`, project config, or all of these?

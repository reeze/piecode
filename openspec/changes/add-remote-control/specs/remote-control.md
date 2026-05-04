# Remote Control Spec Delta

## ADDED Requirements

### Requirement: Remote control is opt-in

PieCode SHALL NOT start a remote-control endpoint unless the user explicitly enables it for the current invocation or through configuration.

#### Scenario: Default startup

- **WHEN** PieCode starts without remote-control enablement
- **THEN** no remote-control listener is started
- **AND** no remote-control endpoint or token is exposed

#### Scenario: Explicit enablement

- **WHEN** the user starts PieCode with remote control enabled
- **THEN** PieCode starts a remote-control endpoint for the active session
- **AND** displays or logs connection details appropriate to the active UI mode

### Requirement: Remote control is authenticated

PieCode SHALL require a per-session authentication mechanism before accepting remote-control commands or exposing session events.

#### Scenario: Missing or invalid authentication

- **WHEN** a remote client connects without valid authentication
- **THEN** PieCode rejects command submission
- **AND** does not stream session content to that client

#### Scenario: Valid authentication

- **WHEN** a remote client connects with valid session authentication
- **THEN** PieCode may accept supported remote-control messages
- **AND** may stream authorized session events to that client

### Requirement: Remote commands use existing session semantics

Remote prompts and supported slash commands SHALL be processed through the same session input and command handling paths as local interactive input.

#### Scenario: Remote prompt submission

- **WHEN** an authenticated remote client submits a user prompt
- **THEN** PieCode queues or processes it as user input for the active session
- **AND** preserves normal agent turn, tool, approval, and cancellation semantics

### Requirement: Existing safety gates remain active

Remote control SHALL NOT bypass shell approval, workspace sandboxing, tool safety classification, or configured permission modes.

#### Scenario: Remote prompt triggers approval-gated command

- **WHEN** a remote-submitted prompt causes a shell command that requires approval
- **THEN** PieCode creates an approval request using the existing approval flow
- **AND** does not execute the command until an authorized approval response is received

### Requirement: Remote protocol is versioned

The remote-control protocol SHALL include a version identifier so incompatible future changes can be detected.

#### Scenario: Unsupported protocol version

- **WHEN** a remote client declares an unsupported protocol version
- **THEN** PieCode rejects the client or returns a protocol-version error
- **AND** does not process remote commands from that client

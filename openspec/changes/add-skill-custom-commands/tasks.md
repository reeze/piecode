# add-skill-custom-commands Tasks

## Spec/design

- [x] Define how skills expose commands by default and via frontmatter.
- [x] Define OpenSpec skill command names and workflow expectations.
- [x] Initialize minimal OpenSpec workspace.

## Implementation

- [x] Add skill command discovery and resolution.
- [x] Add `/skills commands` listing.
- [x] Add slash suggestion support for skill commands.
- [x] Route unknown slash commands to skill-backed agent turns.
- [x] Add project-local OpenSpec skill.

## Validation

- [x] Run Jest test suite after command support changes.
- [ ] Manually verify `/skills commands` and `/openspec <request>` in interactive TUI with project-local skill path enabled.
- [ ] Decide whether `.piecode/skills` should become a default skill root.

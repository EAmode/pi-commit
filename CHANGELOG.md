# Changelog

All notable changes to this project are documented manually in this file.

## Unreleased

## 1.3.0 - 2026-07-02

### Added

- In-process commit-message generation using pi's model API instead of spawning a child `pi` process.
- Timing profiles via `/autocommit --profile` and the `profile` config option.
- Fallback reasons in autocommit plans and results.
- Configurable AI generation budget with `messageMaxTokens` / `--message-max-tokens`.
- Configurable final commit-message length with `maxMessageChars` / `--max-message-chars`, including AI shortening and local enforcement.
- Manual `CHANGELOG.md` included in the npm package.

### Changed

- Default AI generation cap increased to 1024 tokens to better support local models that emit reasoning tokens.
- Commit-message prompts now ask models not to output reasoning or alternatives.
- Commit-message generation now passes git changes as user content and keeps generation rules in the system prompt.

### Fixed

- Fallbacks now explain model failures such as context-window errors, empty text responses, invalid Conventional Commit output, and timeouts.

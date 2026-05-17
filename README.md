# pi-commit

A [pi](https://github.com/earendil-works/pi-coding-agent) extension for generating automatic, changelog-friendly Conventional Commits from your repository changes.

`/autocommit` inspects git changes, handles nested submodules, generates a commit message with an isolated model, and runs `git commit` with hooks enabled by default.

## Installation

### From git

Install directly from the GitHub repository:

```bash
pi install git:https://github.com/EAmode/pi-commit.git
# or
pi install https://github.com/EAmode/pi-commit.git
```

For a project-local install that can be committed in `.pi/settings.json`:

```bash
pi install -l git:https://github.com/EAmode/pi-commit.git
```

Use a ref to pin a version:

```bash
pi install git:https://github.com/EAmode/pi-commit.git@v0.1.0
```

### From npm

Install the pi package from npm:

```bash
pi install npm:@eamode/pi-commit
```

For a project-local install that can be committed in `.pi/settings.json`:

```bash
pi install -l npm:@eamode/pi-commit
```

### Local development

The extension source lives in:

```txt
src/index.ts
```

Run it directly for testing:

```bash
pi -e ./src/index.ts
```

Or install this checkout as a local pi package:

```bash
pi install ./
```

For a project-local install that records the package in `.pi/settings.json`:

```bash
pi install -l ./
```

Then reload pi if it is already running:

```txt
/reload
```

## Usage

```txt
/autocommit
```

By default, `/autocommit` commits staged changes recursively and includes recent pi user prompts as compact context for message generation.

Flow:

1. Inspect the current git repository.
2. Process dirty submodules before their parent repository.
3. Generate or fall back to a Conventional Commit message.
4. Preview/confirm the commit in interactive mode.
5. Run `git commit` with hooks enabled.
6. Stop and report hook output if lint/test hooks fail.

## Command options

```txt
/autocommit --staged              # commit only staged changes
/autocommit --all                 # stage all changes before committing
/autocommit --recursive           # include nested submodules
/autocommit --no-recursive        # only commit the current/root repo
/autocommit --dry-run             # preview without staging or committing
/autocommit --no-verify           # explicitly bypass git hooks
/autocommit --model <provider/model>
/autocommit --model=<provider/model>
/autocommit --context none|recent|session
/autocommit --yes                 # skip confirmation prompts
```

Default behavior:

```txt
/autocommit --staged --recursive --context recent
```

## Development

TypeScript extension files are loaded directly by pi; no compile or bundle step is required for local use or pi package installation.

Useful commands:

```bash
npm install
npm run typecheck
npm run pack:dry-run
```

## Release from local

Releases are managed by [semantic-release](https://semantic-release.gitbook.io/) from Conventional Commits on `main` and publish to npmjs.

Before releasing locally:

1. Log in to npmjs for the `@eamode` scope:

   ```bash
   npm login --scope=@eamode --registry=https://registry.npmjs.org/
   ```

   Or export an npm automation token:

   ```bash
   export NPM_TOKEN=YOUR_NPM_TOKEN
   ```

2. Make sure `main` is clean and up to date:

   ```bash
   git checkout main
   git pull --ff-only
   npm ci
   npm run typecheck
   npm run release:dry-run
   ```

3. Publish from your machine:

   ```bash
   npm run release:local
   ```

`release:local` runs `semantic-release --no-ci`, computes the next version from commits, creates the git tag, and publishes `@eamode/pi-commit` to npm.

## Configuration

Optional `.pi-commit.json` in the working directory:

```json
{
  "model": "openai-codex/gpt-5.4-mini",
  "defaultMode": "staged",
  "recursive": true,
  "contextMode": "recent",
  "recentPromptCount": 5,
  "maxContextBytes": 8000,
  "maxDiffBytes": 30000,
  "confirmBeforeCommit": true
}
```

Config keys:

| Key | Values | Default | Description |
| --- | --- | --- | --- |
| `model` | pi model id, for example `openai-codex/gpt-5.4-mini` | current pi model | Model used to generate the commit message. Use `openai-codex/...` for ChatGPT Plus/Pro login, or `openai/...` only when an OpenAI API key is configured. If unset, `/autocommit` uses the current parent pi model. If no model is available, or if generation fails, the extension uses a deterministic fallback message. |
| `defaultMode` | `"staged"` or `"all"` | `"staged"` | Change selection mode. `"staged"` commits only already staged changes. `"all"` stages tracked and untracked changes before committing. |
| `recursive` | `true` or `false` | `true` | Whether to discover and commit dirty nested submodules before committing the parent repository. |
| `contextMode` | `"none"`, `"recent"`, or `"session"` | `"recent"` | How much pi conversation context to include in commit-message generation. `"none"` includes no prompts, `"recent"` includes the latest user prompts, and `"session"` includes all available user prompts up to `maxContextBytes`. |
| `recentPromptCount` | number | `5` | Number of recent user prompts to include when `contextMode` is `"recent"`. |
| `maxContextBytes` | number | `8000` | Maximum size of conversation context passed to the message generator. |
| `maxDiffBytes` | number | `30000` | Maximum size of staged diff passed to the message generator for each repository. |
| `confirmBeforeCommit` | `true` or `false` | `true` | Whether to ask for confirmation before creating commits in interactive UI mode. Set to `false` to behave like `--yes`. |

Command-line flags override config values for a single `/autocommit` run. Omit `model` to inherit the current parent pi model.

## Commit messages

Generated messages use Conventional Commits and are optimized for future changelog generation:

- accurate type selection, such as `feat`, `fix`, `refactor`, `docs`, or `chore`
- meaningful scopes inferred from repo paths and changed files
- subject usually under 90 characters, with a hard cap around 120
- descriptive subject phrasing that states what changed, not imperative task wording
- optional body when it clarifies motivation, behavior, or impact

Example:

```txt
feat(autocommit): nested submodule commits generated deepest-first

Recursive dirty-repo discovery was added so submodules are committed before
the superproject and parent gitlink updates are captured correctly.
```

## Git hooks

Hooks are enabled by default. If a pre-commit hook fails because linting or tests fail, `/autocommit` stops and shows the command output.

Use `--no-verify` only when you intentionally want to bypass hooks.

## Submodule support

Repositories with nested submodules are committed deepest-first:

```txt
nested submodule -> submodule -> parent repository
```

This ensures the parent repository can commit updated submodule gitlink pointers after submodule commits succeed.

## Implementation plan

See [`plans/autocommit-extension-plan.md`](plans/autocommit-extension-plan.md) for the detailed build plan and design notes.

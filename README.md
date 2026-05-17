# pi-commit

A [pi](https://github.com/earendil-works/pi-coding-agent) extension for generating automatic, changelog-friendly Conventional Commits from your repository changes.

`/autocommit` inspects git changes, handles nested submodules, generates a commit message with an isolated cheap model when configured, and runs `git commit` with hooks enabled by default.

## Installation

### From npm/Gitea package

After publishing `@eamode/pi-commit` to the Gitea npm registry, configure npm for the scope:

```bash
npm login --scope=@eamode --registry=https://dev.eamode.com/api/packages/eamode/npm/
```

Then install the pi package:

```bash
pi install npm:@eamode/pi-commit
```

For a project-local install that can be committed in `.pi/settings.json`:

```bash
pi install -l npm:@eamode/pi-commit
```

If your Gitea package owner is not `eamode`, replace `eamode` in the registry URL and package scope. See `.npmrc.example`.

### From git

You can also install directly from a Gitea git repository:

```bash
pi install git:git@dev.eamode.com:<owner>/pi-commit.git
# or
pi install https://dev.eamode.com/<owner>/pi-commit.git
```

Use a ref to pin a version:

```bash
pi install git:git@dev.eamode.com:<owner>/pi-commit.git@v0.1.0
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

Publish to the configured Gitea npm registry:

```bash
npm publish
```

## Configuration

Optional `.pi-commit.json` in the working directory:

```json
{
  "model": "anthropic/claude-haiku-4-5",
  "defaultMode": "staged",
  "recursive": true,
  "contextMode": "recent",
  "recentPromptCount": 5,
  "maxContextBytes": 8000,
  "maxDiffBytes": 30000,
  "confirmBeforeCommit": true
}
```

If no `model` is configured or passed with `--model`, the extension uses a deterministic fallback message instead of calling a model.

## Commit messages

Generated messages use Conventional Commits and are optimized for future changelog generation:

- accurate type selection, such as `feat`, `fix`, `refactor`, `docs`, or `chore`
- meaningful scopes inferred from repo paths and changed files
- subject usually under 90 characters, with a hard cap around 120
- optional body when it clarifies motivation, behavior, or impact

Example:

```txt
feat(autocommit): generate commits across nested submodules

Adds recursive dirty-repo discovery and commits submodules before the
superproject so parent gitlink updates are captured correctly.
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

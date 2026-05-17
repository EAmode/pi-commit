# pi-commit

A planned [pi](https://github.com/earendil-works/pi-coding-agent) extension for generating automatic, changelog-friendly Conventional Commits from your repository changes.

The extension will expose a `/autocommit` command that inspects git changes, optionally handles nested submodules, generates a commit message with a cheap isolated model, and runs `git commit` with hooks enabled by default.

## Target developer experience

```txt
/autocommit
```

Expected result:

1. pi inspects the current git repository.
2. Dirty submodules are handled before the parent repository.
3. A Conventional Commit message is generated from the diff plus recent user intent.
4. You preview/confirm the commit in interactive mode.
5. `git commit` runs normally, including your existing hooks.
6. If lint/test hooks fail, the command stops and reports the hook output.

## Planned command options

```txt
/autocommit --staged              # commit only staged changes
/autocommit --all                 # stage all changes before committing
/autocommit --recursive           # include nested submodules
/autocommit --dry-run             # preview without committing
/autocommit --no-verify           # explicitly bypass git hooks
/autocommit --model <provider/model>
/autocommit --context none|recent|session
/autocommit --yes                 # skip confirmation prompts
```

Recommended default behavior:

```txt
/autocommit --staged --recursive --context recent
```

## Message generation strategy

Commit-message generation should run in an isolated cheap-model subprocess, not in the main pi conversation. This keeps your primary context clean while allowing the generator to receive compact, relevant context such as:

- changed files
- git diff stat
- truncated relevant diff
- recent user prompts from the current pi session

Messages are intended to be useful for future changelog generation, so the extension should prefer clear Conventional Commit messages over overly short subjects. The current target is:

- subject usually under 90 characters
- hard cap around 120 characters
- optional body when it clarifies motivation, behavior, or impact

Example:

```txt
feat(autocommit): generate commits across nested submodules

Adds recursive dirty-repo discovery and commits submodules before the
superproject so parent gitlink updates are captured correctly.
```

## Git hooks

Hooks are enabled by default. If a pre-commit hook fails because linting or tests fail, `/autocommit` should stop and show the command output. It should not continue to parent repositories after a submodule commit fails.

Use `--no-verify` only when you intentionally want to bypass hooks.

## Submodule support

The extension is designed for repositories with multiple submodules, including nested submodules. Commits should be created deepest-first:

```txt
nested submodule -> submodule -> parent repository
```

This ensures the parent repository can commit updated submodule gitlink pointers after submodule commits succeed.

## Implementation plan

See [`plans/autocommit-extension-plan.md`](plans/autocommit-extension-plan.md) for the detailed build plan, architecture, command flow, and milestones.

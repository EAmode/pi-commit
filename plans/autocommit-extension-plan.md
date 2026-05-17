# pi-commit Autocommit Extension Plan

## Goal

Build a pi extension that provides `/autocommit`: a deterministic git automation command that creates high-quality Conventional Commits for a repository, including repositories with nested git submodules.

The extension should handle git orchestration itself and use an isolated, cheap model subprocess only for commit-message generation. This keeps the main pi conversation context clean while still allowing the message generator to use relevant recent user intent.

## User-facing command

Primary command:

```txt
/autocommit
```

Planned options:

```txt
/autocommit --staged
/autocommit --all
/autocommit --recursive
/autocommit --dry-run
/autocommit --no-verify
/autocommit --model <provider/model>
/autocommit --context none|recent|session
/autocommit --yes
```

Recommended initial defaults:

```txt
/autocommit --staged --recursive --context recent
```

Behavior notes:

- Use `/autocommit`, not `/commit`, to avoid collisions with future/built-in commands and to make automation explicit.
- Do not bypass git hooks unless the user explicitly passes `--no-verify`.
- In interactive mode, show a preview and ask for confirmation unless `--yes` is supplied.
- In `--dry-run`, show planned commits/messages without staging or committing.

## Architecture

Suggested project structure:

```txt
src/
  index.ts              # extension entry, registers /autocommit
  git.ts                # repo/submodule discovery, status, diff helpers
  message.ts            # isolated cheap-model message generation
  conventional.ts       # validation and fallback message formatting
  context.ts            # recent pi session/user prompt extraction
  types.ts
README.md
plans/
  autocommit-extension-plan.md
```

## Commit flow

1. Wait for pi to be idle in the command handler.
2. Discover the root git repository:
   ```bash
   git rev-parse --show-toplevel
   ```
3. Discover submodules recursively when enabled:
   ```bash
   git submodule status --recursive
   ```
4. Build a commit plan ordered deepest submodules first, then parent/root.
5. For each repo in the plan:
   - Inspect branch/HEAD state.
   - Detect staged/unstaged/untracked changes.
   - Stage according to mode (`--staged` vs `--all`).
   - Skip if nothing is staged.
   - Collect changed files, diff stat, and truncated relevant diff.
   - Extract recent pi user intent according to context mode.
   - Generate a Conventional Commit message with the isolated message helper.
   - Validate/repair/fallback the generated message.
   - Commit with hooks enabled by default.
6. Stop on the first commit failure, especially hook failures.
7. Report successful commits and any failure details.

## Submodule handling

Submodules must be committed before their parent repository so the parent commit can capture updated gitlink pointers.

Important cases:

- Nested submodules: process deepest path first.
- Detached HEAD in a submodule: warn or fail by default; later add `--allow-detached` if needed.
- Dirty submodule with hook failure: stop before parent commit.
- Parent repo may have only submodule pointer changes after submodule commits; still generate a parent commit if staged changes exist.

## Git hooks

Hooks are part of the expected workflow.

Default commit command:

```bash
git -C <repo> commit -F <message-file>
```

With explicit bypass:

```bash
git -C <repo> commit --no-verify -F <message-file>
```

If hooks fail:

- Treat it as a normal blocked commit result, not an extension crash.
- Preserve staged changes.
- Show repo path, attempted message, exit code, stdout, and stderr.
- Do not continue to parent repos after a submodule failure.

## Message generation

Use a cheap isolated model subprocess, not the main agent context.

Possible invocation shape:

```bash
pi --mode json -p --no-session --model <cheap-model> --tools none <prompt>
```

Benefits:

- No main context pollution.
- Cheap model can be selected independently.
- Message generation prompt stays compact and task-specific.
- Failures/timeouts can fall back to deterministic local messages.

### Inputs to the message helper

Include:

- Repository path relative to root.
- Changed files.
- Git diff stat.
- Truncated relevant diff.
- Recent user intent extracted from `ctx.sessionManager.getBranch()`.

Do not include the full pi session by default.

Recommended context modes:

- `none`: only git changes.
- `recent`: last N meaningful user prompts, default.
- `session`: summarized session context, future enhancement.

Initial config values:

```json
{
  "contextMode": "recent",
  "recentPromptCount": 5,
  "maxContextBytes": 8000,
  "maxDiffBytes": 30000
}
```

### Prompt target

The generator should optimize for changelog-quality commits:

```txt
You generate high-quality Conventional Commit messages.

Use the git changes plus recent user intent to infer the essence of the change.
Optimize for future changelog generation.

Output only the commit message.

Rules:
- Use Conventional Commits.
- Subject should usually be <= 90 chars and never exceed 120.
- Add a body when it clarifies motivation, behavior, or impact.
- Do not invent issue numbers.
- Do not use markdown fences.
- Prefer user/maintainer-relevant meaning over low-level implementation detail.
```

Example output:

```txt
feat(autocommit): generate commits across nested submodules

Adds recursive dirty-repo discovery and commits submodules before the
superproject so parent gitlink updates are captured correctly.
```

## Conventional Commit validation

Validate generated messages against Conventional Commits:

```txt
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

Allowed initial types:

```txt
feat, fix, refactor, docs, test, chore, build, ci, perf, style
```

If invalid:

1. Attempt simple cleanup, e.g. remove code fences/quotes.
2. Re-check.
3. Fall back to a deterministic message from changed paths, e.g.:
   ```txt
   chore(extension): update autocommit implementation
   ```

## Changelog considerations

For future changelog generation, prioritize:

- Accurate `type` selection.
- Stable, meaningful scopes.
- Descriptive subject lines over overly short ones.
- Commit bodies for non-trivial motivation/impact.
- Avoid noisy implementation-only messages when the change has user-visible behavior.

A strict 72-character subject limit is too restrictive for this goal. Use 90 characters as a soft target and 120 as a hard cap.

## Initial implementation milestones

### Milestone 1: Command skeleton

- Register `/autocommit`.
- Parse basic flags.
- Verify git repo.
- Support `--dry-run` and no-op reporting.

### Milestone 2: Single-repo staged commits

- Inspect staged changes.
- Generate message with isolated helper.
- Validate fallback.
- Commit with hooks enabled.
- Report hook failures.

### Milestone 3: `--all` staging and confirmations

- Add `git add -A` mode.
- Add preview UI and `--yes` bypass.
- Protect against accidental empty commits.

### Milestone 4: Recursive submodules

- Discover nested submodules.
- Process deepest-first.
- Stop on submodule failure.
- Commit parent gitlink changes.

### Milestone 5: Context-aware generation

- Extract recent user prompts from pi session branch.
- Add context modes and byte limits.
- Add config file support.

### Milestone 6: Packaging and docs

- Document installation as a pi extension.
- Add examples.
- Add troubleshooting for hooks, detached submodules, and invalid model config.

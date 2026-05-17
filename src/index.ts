import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractRecentIntent } from "./context.js";
import { isConventionalCommit } from "./conventional.js";
import { collectChangeSet, commitRepo, discoverRepos, findGitRoot } from "./git.js";
import { generateCommitMessage } from "./message.js";
import type { AutocommitOptions, CommitResult, PiCommitConfig, PlannedCommit } from "./types.js";

const DEFAULT_OPTIONS: AutocommitOptions = {
	stageMode: "staged",
	recursive: true,
	dryRun: false,
	noVerify: false,
	yes: false,
	contextMode: "recent",
	recentPromptCount: 5,
	maxContextBytes: 8000,
	maxDiffBytes: 30000,
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("autocommit", {
		description: "Generate Conventional Commits for staged/all git changes, including submodules.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			let options: AutocommitOptions;
			try {
				const config = await loadConfig(ctx.cwd);
				options = parseArgs(args, config);
			} catch (error) {
				ctx.ui.notify(`autocommit: ${(error as Error).message}`, "error");
				return;
			}

			ctx.ui.setStatus("autocommit", "planning");
			try {
				const root = await findGitRoot(pi, ctx.cwd);
				const repos = await discoverRepos(pi, root, options.recursive);
				const recentIntent = extractRecentIntent(ctx, options);
				const planned: PlannedCommit[] = [];

				for (const repo of repos) {
					const changeSet = await collectChangeSet(pi, repo, options);
					if (!changeSet) continue;
					if (changeSet.detached && !repo.isRoot) {
						ctx.ui.notify(`Skipping detached submodule ${repo.relativePath}; checkout a branch first.`, "warning");
						continue;
					}
					ctx.ui.setStatus("autocommit", `message ${repo.relativePath}`);
					const message = await generateCommitMessage({
						changeSet,
						recentIntent,
						model: options.model,
						signal: ctx.signal,
					});
					planned.push({ changeSet, message });
				}

				if (planned.length === 0) {
					ctx.ui.notify(
						options.stageMode === "staged"
							? "No staged changes to commit. Use /autocommit --all to stage changes."
							: "No changes to commit.",
						"info",
					);
					return;
				}

				const preview = formatPlan(planned, options);
				if (options.dryRun) {
					pi.sendMessage({ customType: "autocommit", content: preview, display: true });
					return;
				}

				if (!options.yes && ctx.hasUI) {
					const ok = await ctx.ui.confirm("Create commits?", preview);
					if (!ok) {
						ctx.ui.notify("autocommit canceled", "info");
						return;
					}
				}

				ctx.ui.setStatus("autocommit", "committing");
				const results: CommitResult[] = [];
				for (const item of planned) {
					const messageFile = await writeMessageFile(item.message);
					try {
						const result = await commitRepo(pi, item.changeSet.repo, messageFile, options.noVerify);
						const commitResult: CommitResult = {
							repo: item.changeSet.repo,
							message: item.message,
							success: result.code === 0,
							exitCode: result.code,
							stdout: result.stdout,
							stderr: result.stderr,
						};
						results.push(commitResult);
						if (!commitResult.success) {
							pi.sendMessage({ customType: "autocommit", content: formatResults(results), display: true });
							ctx.ui.notify(`Commit failed in ${item.changeSet.repo.relativePath}`, "error");
							return;
						}
					} finally {
						await fs.rm(messageFile, { force: true });
					}
				}

				pi.sendMessage({ customType: "autocommit", content: formatResults(results), display: true });
				ctx.ui.notify(`autocommit created ${results.length} commit${results.length === 1 ? "" : "s"}`, "info");
			} catch (error) {
				ctx.ui.notify(`autocommit failed: ${(error as Error).message}`, "error");
			} finally {
				ctx.ui.setStatus("autocommit", undefined);
			}
		},
	});
}

async function loadConfig(cwd: string): Promise<PiCommitConfig> {
	const configPath = path.join(cwd, ".pi-commit.json");
	try {
		const text = await fs.readFile(configPath, "utf8");
		return JSON.parse(text) as PiCommitConfig;
	} catch (error: any) {
		if (error?.code === "ENOENT") return {};
		throw new Error(`Failed to read .pi-commit.json: ${error.message}`);
	}
}

function parseArgs(rawArgs: string, config: PiCommitConfig): AutocommitOptions {
	const options: AutocommitOptions = {
		...DEFAULT_OPTIONS,
		stageMode: config.defaultMode ?? DEFAULT_OPTIONS.stageMode,
		recursive: config.recursive ?? DEFAULT_OPTIONS.recursive,
		model: config.model,
		contextMode: config.contextMode ?? DEFAULT_OPTIONS.contextMode,
		recentPromptCount: config.recentPromptCount ?? DEFAULT_OPTIONS.recentPromptCount,
		maxContextBytes: config.maxContextBytes ?? DEFAULT_OPTIONS.maxContextBytes,
		maxDiffBytes: config.maxDiffBytes ?? DEFAULT_OPTIONS.maxDiffBytes,
		yes: config.confirmBeforeCommit === false,
	};

	const tokens = tokenize(rawArgs || "");
	for (let i = 0; i < tokens.length; i++) {
		let token = tokens[i];
		let inlineValue: string | undefined;
		if (token.startsWith("--") && token.includes("=")) {
			const [flag, ...rest] = token.split("=");
			token = flag;
			inlineValue = rest.join("=");
		}
		switch (token) {
			case "--staged":
				options.stageMode = "staged";
				break;
			case "--all":
				options.stageMode = "all";
				break;
			case "--recursive":
				options.recursive = true;
				break;
			case "--no-recursive":
				options.recursive = false;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--no-verify":
				options.noVerify = true;
				break;
			case "--yes":
			case "-y":
				options.yes = true;
				break;
			case "--model":
				options.model = inlineValue ?? requireValue(tokens, ++i, "--model");
				break;
			case "--context": {
				const value = inlineValue ?? requireValue(tokens, ++i, "--context");
				if (value !== "none" && value !== "recent" && value !== "session") {
					throw new Error("--context must be one of: none, recent, session");
				}
				options.contextMode = value;
				break;
			}
			default:
				throw new Error(`Unknown option: ${token}`);
		}
	}

	return options;
}

function tokenize(input: string): string[] {
	const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return matches.map((value) => value.replace(/^(["'])(.*)\1$/, "$2"));
}

function requireValue(tokens: string[], index: number, flag: string): string {
	const value = tokens[index];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function formatPlan(planned: PlannedCommit[], options: AutocommitOptions): string {
	const lines = [
		options.dryRun ? "autocommit dry run" : "autocommit plan",
		`mode: ${options.stageMode}, recursive: ${options.recursive}, hooks: ${options.noVerify ? "disabled" : "enabled"}`,
		"",
	];
	for (const item of planned) {
		const conventional = isConventionalCommit(item.message) ? "" : " [fallback]";
		lines.push(`${item.changeSet.repo.relativePath}${conventional}`);
		lines.push(indent(item.message, "  "));
		if (item.changeSet.unstaged || item.changeSet.untracked.length > 0) {
			lines.push("  note: unstaged/untracked changes remain outside this staged commit");
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function formatResults(results: CommitResult[]): string {
	const lines = ["autocommit results", ""];
	for (const result of results) {
		lines.push(`${result.success ? "✓" : "✗"} ${result.repo.relativePath} (exit ${result.exitCode})`);
		lines.push(indent(result.message, "  "));
		const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
		if (output) lines.push("", indent(output, "  "));
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function indent(text: string, prefix: string): string {
	return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

async function writeMessageFile(message: string): Promise<string> {
	const file = path.join(os.tmpdir(), `pi-autocommit-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
	await fs.writeFile(file, `${message.trim()}\n`, "utf8");
	return file;
}

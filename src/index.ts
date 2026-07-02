import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { extractRecentIntent } from "./context.js";
import { isConventionalCommit } from "./conventional.js";
import { collectChangeSet, commitRepo, discoverRepos, findGitRoot, stageSubmoduleGitlinks } from "./git.js";
import { generateCommitMessage, type MessageGeneratorContext } from "./message.js";
import type { AutocommitOptions, CommitResult, PiCommitConfig, PlannedCommit } from "./types.js";

const DEFAULT_OPTIONS: AutocommitOptions = {
	stageMode: "all",
	recursive: true,
	dryRun: false,
	noVerify: false,
	yes: false,
	messageMode: "ai",
	messageTimeoutMs: 45000,
	messageMaxTokens: 1024,
	maxMessageChars: 600,
	contextMode: "recent",
	recentPromptCount: 5,
	maxContextBytes: 8000,
	maxDiffBytes: 30000,
	profile: false,
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("autocommit", {
		description: "Generate Conventional Commits for staged/all git changes, including submodules.",
		handler: async (args, ctx) => {
			const profile = new TimingProfile();
			let options: AutocommitOptions | undefined;
			let profileEnabled = hasProfileFlag(args);

			try {
				await profile.measure("wait for idle", () => ctx.waitForIdle());
				await profile.measure("load config and parse args", async () => {
					const config = await loadConfig(ctx.cwd);
					profileEnabled = config.profile ?? profileEnabled;
					options = parseArgs(args, config);
					if (options.messageMode === "ai") options.model ??= currentModelId(ctx.model);
					profileEnabled = options.profile;
				});

				if (!options) throw new Error("Failed to parse autocommit options");

				ctx.ui.setStatus("autocommit", "planning");
				const root = await profile.measure("find git root", () => findGitRoot(pi, ctx.cwd));
				const repos = await profile.measure("discover repositories", () => discoverRepos(pi, root, options!.recursive));
				const recentIntent = profile.measureSync("extract conversation context", () =>
					options!.messageMode === "ai" ? extractRecentIntent(ctx, options!) : "",
				);
				let messageGenerator: MessageGeneratorContext | undefined;
				const planned: PlannedCommit[] = [];

				for (const repo of repos) {
					const repoLabel = formatRepoLabel(repo);
					const changeSet = await profile.measure(`collect changes ${repoLabel}`, () => collectChangeSet(pi, repo, options!));
					if (!changeSet) continue;
					if (changeSet.detached && !repo.isRoot) {
						ctx.ui.notify(`Skipping detached submodule ${repo.relativePath}; checkout a branch first.`, "warning");
						continue;
					}
					ctx.ui.setStatus("autocommit", `message ${repoLabel}`);
					messageGenerator ??= await profile.measure("resolve message model", () => resolveMessageModel(ctx, options!));
					const generated = await profile.measure(`generate message ${repoLabel}`, () =>
						generateCommitMessage({
							changeSet,
							recentIntent,
							generator: messageGenerator!,
							messageTimeoutMs: options!.messageTimeoutMs,
							messageMaxTokens: options!.messageMaxTokens,
							maxMessageChars: options!.maxMessageChars,
							signal: ctx.signal,
						}),
					);
					planned.push({
						changeSet,
						message: generated.message,
						messageSource: generated.source,
						fallbackReason: generated.fallbackReason,
						messageModel: generated.model,
					});
				}

				if (planned.length === 0) {
					ctx.ui.notify(
						options.stageMode === "staged"
							? "No staged changes to commit. Use /autocommit --all to stage changes."
							: "No changes to commit.",
						"info",
					);
					if (options.profile) sendAutocommitMessage(pi, profile.format("autocommit timing profile"));
					return;
				}

				const preview = formatPlan(planned, options);
				if (options.dryRun) {
					sendAutocommitMessage(pi, appendProfile(preview, profile, options));
					return;
				}

				if (!options.yes && ctx.hasUI) {
					const ok = await profile.measure("confirmation", () => ctx.ui.confirm("Create commits?", preview));
					if (!ok) {
						ctx.ui.notify("autocommit canceled", "info");
						if (options.profile) sendAutocommitMessage(pi, appendProfile("autocommit canceled", profile, options));
						return;
					}
				}

				ctx.ui.setStatus("autocommit", "committing");
				const results: CommitResult[] = [];
				for (const item of planned) {
					const repoLabel = formatRepoLabel(item.changeSet.repo);
					const gitlinkStage = await profile.measure(`stage submodule gitlinks ${repoLabel}`, () =>
						stageSubmoduleGitlinks(pi, item.changeSet.repo),
					);
					if (gitlinkStage && gitlinkStage.code !== 0) {
						sendAutocommitMessage(pi, appendProfile(formatResults(results), profile, options));
						ctx.ui.notify(`Failed to stage submodule gitlinks in ${item.changeSet.repo.relativePath}`, "error");
						return;
					}

					const messageFile = await profile.measure(`write message file ${repoLabel}`, () => writeMessageFile(item.message));
					try {
						const result = await profile.measure(`git commit ${repoLabel}`, () =>
							commitRepo(pi, item.changeSet.repo, messageFile, options!.noVerify),
						);
						const commitResult: CommitResult = {
							repo: item.changeSet.repo,
							message: item.message,
							messageSource: item.messageSource,
							fallbackReason: item.fallbackReason,
							messageModel: item.messageModel,
							success: result.code === 0,
							exitCode: result.code,
							stdout: result.stdout,
							stderr: result.stderr,
						};
						results.push(commitResult);
						if (!commitResult.success) {
							sendAutocommitMessage(pi, appendProfile(formatResults(results), profile, options));
							ctx.ui.notify(`Commit failed in ${item.changeSet.repo.relativePath}`, "error");
							return;
						}
					} finally {
						await fs.rm(messageFile, { force: true });
					}
				}

				sendAutocommitMessage(pi, appendProfile(formatResults(results), profile, options));
				ctx.ui.notify(`autocommit created ${results.length} commit${results.length === 1 ? "" : "s"}`, "info");
			} catch (error) {
				if (profileEnabled) sendAutocommitMessage(pi, profile.format("autocommit timing profile before failure"));
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
		const errors: ParseError[] = [];
		const config = parse(text, errors, { allowTrailingComma: true });
		if (errors.length > 0) {
			throw new Error(formatJsoncErrors(text, errors));
		}
		return (config ?? {}) as PiCommitConfig;
	} catch (error: any) {
		if (error?.code === "ENOENT") return {};
		throw new Error(`Failed to read .pi-commit.json: ${error.message}`);
	}
}

function formatJsoncErrors(text: string, errors: ParseError[]): string {
	return errors
		.map((error) => {
			const line = text.slice(0, error.offset).split(/\r?\n/).length;
			const lineStart = Math.max(text.lastIndexOf("\n", error.offset - 1), text.lastIndexOf("\r", error.offset - 1)) + 1;
			const column = error.offset - lineStart + 1;
			return `${printParseErrorCode(error.error)} at ${line}:${column}`;
		})
		.join(", ");
}

async function resolveMessageModel(
	ctx: ExtensionCommandContext,
	options: AutocommitOptions,
): Promise<MessageGeneratorContext> {
	if (options.messageMode !== "ai") {
		return { unavailableReason: "AI disabled by --no-ai/messageMode=fallback" };
	}

	const requested = options.model?.trim();
	if (!requested) {
		return { unavailableReason: "no model selected; set .pi-commit.json model or pass --model" };
	}

	let model: Model<Api> | undefined;
	if (ctx.model && currentModelId(ctx.model) === requested) {
		model = ctx.model as Model<Api>;
	} else {
		const parsed = parseModelId(requested);
		if (!parsed) {
			return { unavailableReason: `invalid model id "${requested}"; expected provider/model` };
		}
		model = ctx.modelRegistry.find(parsed.provider, parsed.model) as Model<Api> | undefined;
	}

	if (!model) {
		return { unavailableReason: `model not found: ${requested}` };
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { unavailableReason: `auth failed for ${requested}: ${auth.error}` };
	}

	return {
		model,
		modelLabel: currentModelId(model) ?? requested,
		auth: {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
		},
	};
}

function currentModelId(model: any): string | undefined {
	if (!model?.provider || !model?.id) return undefined;
	return `${model.provider}/${model.id}`;
}

function parseModelId(value: string): { provider: string; model: string } | null {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return null;
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function parseArgs(rawArgs: string, config: PiCommitConfig): AutocommitOptions {
	const options: AutocommitOptions = {
		...DEFAULT_OPTIONS,
		stageMode: config.defaultMode ?? DEFAULT_OPTIONS.stageMode,
		recursive: config.recursive ?? DEFAULT_OPTIONS.recursive,
		model: config.model,
		messageMode: config.messageMode ?? DEFAULT_OPTIONS.messageMode,
		messageTimeoutMs: config.messageTimeoutMs ?? DEFAULT_OPTIONS.messageTimeoutMs,
		messageMaxTokens: config.messageMaxTokens ?? DEFAULT_OPTIONS.messageMaxTokens,
		maxMessageChars: config.maxMessageChars ?? DEFAULT_OPTIONS.maxMessageChars,
		contextMode: config.contextMode ?? DEFAULT_OPTIONS.contextMode,
		recentPromptCount: config.recentPromptCount ?? DEFAULT_OPTIONS.recentPromptCount,
		maxContextBytes: config.maxContextBytes ?? DEFAULT_OPTIONS.maxContextBytes,
		maxDiffBytes: config.maxDiffBytes ?? DEFAULT_OPTIONS.maxDiffBytes,
		yes: config.confirmBeforeCommit === false,
		profile: config.profile ?? DEFAULT_OPTIONS.profile,
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
			case "--profile":
				options.profile = true;
				break;
			case "--no-profile":
				options.profile = false;
				break;
			case "--model":
				options.model = inlineValue ?? requireValue(tokens, ++i, "--model");
				options.messageMode = "ai";
				break;
			case "--ai":
				options.messageMode = "ai";
				break;
			case "--no-ai":
			case "--fallback-message":
				options.messageMode = "fallback";
				break;
			case "--message-timeout":
			case "--message-timeout-ms":
				options.messageTimeoutMs = parseNonNegativeInteger(inlineValue ?? requireValue(tokens, ++i, token), token);
				break;
			case "--message-max-tokens":
			case "--max-message-tokens":
				options.messageMaxTokens = parseNonNegativeInteger(inlineValue ?? requireValue(tokens, ++i, token), token);
				break;
			case "--max-message-chars":
			case "--message-max-chars":
				options.maxMessageChars = parseNonNegativeInteger(inlineValue ?? requireValue(tokens, ++i, token), token);
				break;
			case "--max-diff-bytes":
				options.maxDiffBytes = parseNonNegativeInteger(inlineValue ?? requireValue(tokens, ++i, "--max-diff-bytes"), "--max-diff-bytes");
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

function parseNonNegativeInteger(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
	return parsed;
}

function formatPlan(planned: PlannedCommit[], options: AutocommitOptions): string {
	const lines = [
		options.dryRun ? "autocommit dry run" : "autocommit plan",
		`mode: ${options.stageMode}, recursive: ${options.recursive}, messages: ${options.messageMode}, hooks: ${options.noVerify ? "disabled" : "enabled"}`,
		"",
	];
	for (const item of planned) {
		const flags: string[] = [];
		if (item.messageSource === "fallback") flags.push("fallback");
		else if (!isConventionalCommit(item.message)) flags.push("non-conventional");
		lines.push(`${formatRepoLabel(item.changeSet.repo)}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`);
		lines.push(indent(item.message, "  "));
		if (item.fallbackReason) lines.push(`  fallback reason: ${formatReason(item.fallbackReason)}`);
		if (item.changeSet.unstaged || item.changeSet.untracked.length > 0) {
			lines.push("  note: unstaged/untracked changes remain outside this staged commit");
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function formatRepoLabel(repo: { path: string; relativePath: string }): string {
	const repoName = path.basename(repo.path);
	const repoPath = repo.relativePath === "." ? "./" : `${repo.relativePath}/`;
	return `${repoPath} (${repoName})`;
}

function formatResults(results: CommitResult[]): string {
	const lines = ["autocommit results", ""];
	for (const result of results) {
		const flags = result.messageSource === "fallback" ? " [fallback]" : "";
		lines.push(`${result.success ? "✓" : "✗"} ${formatRepoLabel(result.repo)} (exit ${result.exitCode})${flags}`);
		lines.push(indent(result.message, "  "));
		if (result.fallbackReason) lines.push(`  fallback reason: ${formatReason(result.fallbackReason)}`);
		const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
		if (output) lines.push("", indent(output, "  "));
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function appendProfile(text: string, profile: TimingProfile, options: AutocommitOptions): string {
	if (!options.profile) return text;
	return `${text}\n\n${profile.format("autocommit timing profile")}`.trimEnd();
}

function sendAutocommitMessage(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({ customType: "autocommit", content, display: true });
}

function indent(text: string, prefix: string): string {
	return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function formatReason(reason: string): string {
	const singleLine = reason.replace(/\s+/g, " ").trim();
	if (singleLine.length <= 180) return singleLine;
	return `${singleLine.slice(0, 177)}...`;
}

function hasProfileFlag(args: string): boolean {
	return tokenize(args || "").includes("--profile");
}

async function writeMessageFile(message: string): Promise<string> {
	const file = path.join(os.tmpdir(), `pi-autocommit-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
	await fs.writeFile(file, `${message.trim()}\n`, "utf8");
	return file;
}

interface TimingSpan {
	label: string;
	ms: number;
}

class TimingProfile {
	private readonly started = performance.now();
	private readonly spans: TimingSpan[] = [];

	async measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
		const start = performance.now();
		try {
			return await fn();
		} finally {
			this.spans.push({ label, ms: performance.now() - start });
		}
	}

	measureSync<T>(label: string, fn: () => T): T {
		const start = performance.now();
		try {
			return fn();
		} finally {
			this.spans.push({ label, ms: performance.now() - start });
		}
	}

	format(title: string): string {
		const lines = [title, ""];
		for (const span of this.spans) {
			lines.push(`- ${span.label}: ${formatDuration(span.ms)}`);
		}
		lines.push(`- total: ${formatDuration(performance.now() - this.started)}`);
		return lines.join("\n");
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

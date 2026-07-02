import { complete, type Api, type AssistantMessage, type Model, type ProviderEnv, type ProviderHeaders } from "@earendil-works/pi-ai/compat";
import type { MessageGenerationResult, RepoChangeSet } from "./types.js";
import { cleanModelMessage, fallbackMessage, repairConventionalCommit } from "./conventional.js";

const DEFAULT_MESSAGE_MAX_TOKENS = 1024;

export interface MessageGeneratorContext {
	model?: Model<Api>;
	modelLabel?: string;
	auth?: {
		apiKey?: string;
		headers?: ProviderHeaders;
		env?: ProviderEnv;
	};
	unavailableReason?: string;
}

type TextOnlyContext = {
	systemPrompt: string;
	messages: Array<{ role: "user"; content: string; timestamp: number }>;
};

export async function generateCommitMessage(input: {
	changeSet: RepoChangeSet;
	recentIntent: string;
	generator: MessageGeneratorContext;
	messageTimeoutMs?: number;
	messageMaxTokens?: number;
	maxMessageChars?: number;
	signal?: AbortSignal;
}): Promise<MessageGenerationResult> {
	if (!input.generator.model) {
		return fallback(input.changeSet, input.generator.unavailableReason ?? "no model selected");
	}

	const context: TextOnlyContext = {
		systemPrompt: buildSystemPrompt(input.maxMessageChars),
		messages: [
			{
				role: "user",
				content: buildUserPrompt(input.changeSet, input.recentIntent),
				timestamp: Date.now(),
			},
		],
	};

	try {
		const response = await completeWithTimeout(input.generator.model, context, {
			apiKey: input.generator.auth?.apiKey,
			headers: input.generator.auth?.headers,
			env: input.generator.auth?.env,
			messageTimeoutMs: input.messageTimeoutMs,
			maxTokens: input.messageMaxTokens,
			signal: input.signal,
		});

		if (response.stopReason === "error") {
			return fallback(input.changeSet, `model error: ${truncateReason(response.errorMessage || "unknown error")}`);
		}
		if (response.stopReason === "aborted") {
			return fallback(input.changeSet, "message generation aborted");
		}

		const raw = extractText(response);
		if (!raw.trim()) {
			return fallback(input.changeSet, describeEmptyTextResponse(response));
		}

		const repaired = repairConventionalCommit(raw);
		if (repaired) {
			const message = await shortenCommitMessageIfNeeded({
				message: repaired,
				maxMessageChars: input.maxMessageChars,
				generator: input.generator,
				messageTimeoutMs: input.messageTimeoutMs,
				messageMaxTokens: input.messageMaxTokens,
				signal: input.signal,
			});
			return {
				message,
				source: "ai",
				model: input.generator.modelLabel,
			};
		}

		const cleaned = cleanModelMessage(raw);
		const suffix = response.stopReason === "length" ? " (response hit max tokens)" : "";
		return fallback(input.changeSet, `invalid Conventional Commit output${suffix}: ${truncateReason(cleaned)}`);
	} catch (error) {
		const reason = error instanceof Error ? error.message || "message generation failed" : String(error);
		return fallback(input.changeSet, truncateReason(reason || "message generation failed"));
	}
}

function buildSystemPrompt(maxMessageChars?: number): string {
	const lengthRule = maxMessageChars && maxMessageChars > 0
		? [`- Keep the complete commit message at or below ${maxMessageChars} characters. If needed, omit the body.`]
		: [];
	return [
		"You generate high-quality Conventional Commit messages.",
		"",
		"Use the git changes plus recent user intent to infer the essence of the change.",
		"Optimize for future changelog generation.",
		"",
		"Output only the commit message.",
		"Do not output reasoning, explanations, or alternatives.",
		"",
		"Rules:",
		"- Use Conventional Commits: <type>(<scope>): <description>.",
		"- Allowed types: feat, fix, refactor, docs, test, chore, build, ci, perf, style.",
		"- Subject should usually be <= 90 chars and never exceed 120.",
		...lengthRule,
		"- Describe what changed, not an instruction or task title.",
		"- Prefer past-tense or result-oriented phrasing (for example: 'parent model inheritance added', 'README config docs updated').",
		"- Avoid imperative task verbs like add, update, fix, implement, or inherit as the first word of the subject.",
		"- Add a body only when it clarifies motivation, behavior, or impact.",
		"- Do not invent issue numbers.",
		"- Do not use markdown fences.",
		"- Prefer user/maintainer-relevant meaning over low-level implementation detail.",
	].join("\n");
}

function buildUserPrompt(changeSet: RepoChangeSet, recentIntent: string): string {
	return [
		`Repository: ${changeSet.repo.relativePath}`,
		`Branch: ${changeSet.branch}${changeSet.detached ? " (detached HEAD)" : ""}`,
		"",
		"Recent user intent:",
		recentIntent || "(none provided)",
		"",
		"Changed files:",
		changeSet.changedFiles.map((file) => `- ${file}`).join("\n") || "(none)",
		"",
		"Diff stat:",
		changeSet.diffStat || "(none)",
		"",
		"Relevant staged diff:",
		changeSet.diff || "(none)",
	].join("\n");
}

async function shortenCommitMessageIfNeeded(input: {
	message: string;
	maxMessageChars?: number;
	generator: MessageGeneratorContext;
	messageTimeoutMs?: number;
	messageMaxTokens?: number;
	signal?: AbortSignal;
}): Promise<string> {
	const maxMessageChars = input.maxMessageChars ?? 0;
	if (maxMessageChars <= 0 || input.message.length <= maxMessageChars || !input.generator.model) {
		return input.message;
	}

	const context: TextOnlyContext = {
		systemPrompt: buildShortenSystemPrompt(maxMessageChars),
		messages: [
			{
				role: "user",
				content: [
					`Shorten this Conventional Commit message to at most ${maxMessageChars} characters total.`,
					"Preserve the type/scope and the user-visible meaning.",
					"If the body does not fit, omit it.",
					"Output only the shortened commit message.",
					"",
					"Commit message:",
					input.message,
				].join("\n"),
				timestamp: Date.now(),
			},
		],
	};

	try {
		const response = await completeWithTimeout(input.generator.model, context, {
			apiKey: input.generator.auth?.apiKey,
			headers: input.generator.auth?.headers,
			env: input.generator.auth?.env,
			messageTimeoutMs: input.messageTimeoutMs,
			maxTokens: input.messageMaxTokens,
			signal: input.signal,
		});
		const shortened = repairConventionalCommit(extractText(response));
		if (shortened) return enforceMaxMessageChars(shortened, maxMessageChars);
	} catch {
		// Keep the original AI message and enforce the configured length locally below.
	}

	return enforceMaxMessageChars(input.message, maxMessageChars);
}

function buildShortenSystemPrompt(maxMessageChars: number): string {
	return [
		"You shorten Conventional Commit messages.",
		"Output only one valid Conventional Commit message.",
		"Do not output reasoning, explanations, or alternatives.",
		"",
		"Rules:",
		"- Preserve the existing Conventional Commit type and scope when possible.",
		"- Preserve the user-visible meaning.",
		`- Keep the complete commit message at or below ${maxMessageChars} characters.`,
		"- If a body does not fit, omit it.",
		"- The first line must remain: <type>(<scope>): <description>.",
	].join("\n");
}

async function completeWithTimeout(
	model: Model<Api>,
	context: TextOnlyContext,
	options: {
		apiKey?: string;
		headers?: ProviderHeaders;
		env?: ProviderEnv;
		messageTimeoutMs?: number;
		maxTokens?: number;
		signal?: AbortSignal;
	},
): Promise<AssistantMessage> {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	let timedOut = false;
	let abort: (() => void) | undefined;

	try {
		const maxTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : DEFAULT_MESSAGE_MAX_TOKENS;
		const completion = complete(model, context, {
			apiKey: options.apiKey,
			headers: options.headers,
			env: options.env,
			maxTokens,
			temperature: 0.2,
			signal: controller.signal,
			timeoutMs: options.messageTimeoutMs && options.messageTimeoutMs > 0 ? options.messageTimeoutMs : undefined,
		});
		const races: Array<Promise<AssistantMessage>> = [completion];

		if (options.messageTimeoutMs && options.messageTimeoutMs > 0) {
			races.push(
				new Promise<AssistantMessage>((_, reject) => {
					timeout = setTimeout(() => {
						timedOut = true;
						controller.abort(new Error(`message generation timed out after ${options.messageTimeoutMs}ms`));
						reject(new Error(`message generation timed out after ${options.messageTimeoutMs}ms`));
					}, options.messageTimeoutMs);
				}),
			);
		}

		if (options.signal) {
			races.push(
				new Promise<AssistantMessage>((_, reject) => {
					abort = () => {
						controller.abort(new Error("message generation aborted"));
						reject(new Error("message generation aborted"));
					};
					if (options.signal?.aborted) abort();
					else options.signal?.addEventListener("abort", abort, { once: true });
				}),
			);
		}

		return await Promise.race(races);
	} catch (error) {
		if (timedOut) throw new Error(`message generation timed out after ${options.messageTimeoutMs}ms`);
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		if (options.signal && abort) options.signal.removeEventListener("abort", abort);
	}
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

function extractThinking(message: AssistantMessage): string {
	return message.content
		.filter((part: any) => part?.type === "thinking")
		.map((part: any) => part.thinking ?? "")
		.join("\n")
		.trim();
}

function describeEmptyTextResponse(response: AssistantMessage): string {
	const thinking = extractThinking(response);
	const details = [`stopReason=${response.stopReason}`];
	if (thinking) details.push(`thinkingChars=${thinking.length}`);
	return `empty model text response (${details.join(", ")})`;
}

function fallback(changeSet: RepoChangeSet, fallbackReason: string): MessageGenerationResult {
	return {
		message: fallbackMessage(changeSet.changedFiles, changeSet.repo.relativePath),
		source: "fallback",
		fallbackReason,
	};
}

function enforceMaxMessageChars(message: string, maxChars: number): string {
	const clean = cleanModelMessage(message);
	if (maxChars <= 0 || clean.length <= maxChars) return clean;

	const [header, ...bodyLines] = clean.split("\n");
	if (header.length >= maxChars) return shortenHeader(header, maxChars);

	const body = bodyLines.join("\n").trim();
	if (!body) return header;

	const remaining = maxChars - header.length - 2;
	if (remaining <= 0) return header;
	return `${header}\n\n${truncateText(body, remaining)}`;
}

function shortenHeader(header: string, maxChars: number): string {
	if (maxChars <= 0 || header.length <= maxChars) return header;
	const match = header.match(/^((?:feat|fix|refactor|docs|test|chore|build|ci|perf|style)(?:\([^\r\n)]+\))?!?: )(.*)$/);
	if (!match) return truncateText(header, maxChars);

	const [, prefix, subject] = match;
	if (prefix.length >= maxChars) return truncateText(header, maxChars);
	return `${prefix}${truncateText(subject, maxChars - prefix.length)}`;
}

function truncateText(value: string, maxChars: number): string {
	if (maxChars <= 0 || value.length <= maxChars) return value;
	if (maxChars <= 3) return value.slice(0, maxChars);
	return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function truncateReason(value: string): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= 220) return singleLine;
	return `${singleLine.slice(0, 217)}...`;
}

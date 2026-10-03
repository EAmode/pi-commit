import { complete, type Api, type AssistantMessage, type Model, type ProviderEnv, type ProviderHeaders } from "@earendil-works/pi-ai/compat";
import type { MessageGenerationResult, RepoChangeSet } from "./types.js";
import { cleanModelMessage, fallbackMessage, repairConventionalCommit } from "./conventional.js";

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
	generator: MessageGeneratorContext;
	messageTimeoutMs?: number;
	signal?: AbortSignal;
}): Promise<MessageGenerationResult> {
	if (!input.generator.model) {
		return fallback(input.changeSet, input.generator.unavailableReason ?? "no model selected");
	}

	const context: TextOnlyContext = {
		systemPrompt: buildSystemPrompt(),
		messages: [
			{
				role: "user",
				content: buildUserPrompt(input.changeSet),
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
			return {
				message: repaired,
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

function buildSystemPrompt(): string {
	return [
		"You generate high-quality Conventional Commit messages.",
		"",
		"Infer the intent and essence of the change from the git changes alone.",
		"Optimize for future changelog generation.",
		"",
		"Output only the commit message.",
		"Do not output reasoning, explanations, or alternatives.",
		"",
		"Rules:",
		"- Use Conventional Commits: <type>(<scope>): <description>.",
		"- Allowed types: feat, fix, refactor, docs, test, chore, build, ci, perf, style.",
		"- Subject should usually be <= 90 chars and never exceed 120.",
		"- Describe what changed, not an instruction or task title.",
		"- Prefer past-tense or result-oriented phrasing (for example: 'parent model inheritance added', 'README config docs updated').",
		"- Avoid imperative task verbs like add, update, fix, implement, or inherit as the first word of the subject.",
		"- Add a body only when it clarifies motivation, behavior, or impact.",
		"- Do not invent issue numbers.",
		"- Do not use markdown fences.",
		"- Prefer user/maintainer-relevant meaning over low-level implementation detail.",
	].join("\n");
}

function buildUserPrompt(changeSet: RepoChangeSet): string {
	return [
		`Repository: ${changeSet.repo.relativePath}`,
		`Branch: ${changeSet.branch}${changeSet.detached ? " (detached HEAD)" : ""}`,
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

async function completeWithTimeout(
	model: Model<Api>,
	context: TextOnlyContext,
	options: {
		apiKey?: string;
		headers?: ProviderHeaders;
		env?: ProviderEnv;
		messageTimeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<AssistantMessage> {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	let timedOut = false;
	let abort: (() => void) | undefined;

	try {
		const completion = complete(model, context, {
			apiKey: options.apiKey,
			headers: options.headers,
			env: options.env,
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

function truncateReason(value: string): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= 220) return singleLine;
	return `${singleLine.slice(0, 217)}...`;
}

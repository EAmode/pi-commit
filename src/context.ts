import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocommitOptions } from "./types.js";

export function extractRecentIntent(ctx: ExtensionCommandContext, options: AutocommitOptions): string {
	if (options.contextMode === "none") return "";

	const entries = ctx.sessionManager.getBranch();
	const prompts: string[] = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry: any = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageText(entry.message);
		if (!text.trim()) continue;
		prompts.push(text.trim());
		if (options.contextMode === "recent" && prompts.length >= options.recentPromptCount) break;
	}

	const chronological = prompts.reverse();
	let result = chronological.map((prompt) => `- ${singleLine(prompt)}`).join("\n");
	if (result.length > options.maxContextBytes) {
		result = result.slice(result.length - options.maxContextBytes);
		const firstNewline = result.indexOf("\n");
		if (firstNewline >= 0) result = result.slice(firstNewline + 1);
	}
	return result;
}

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part?.type === "text") return part.text ?? "";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { RepoChangeSet } from "./types.js";
import { fallbackMessage, repairConventionalCommit } from "./conventional.js";

export async function generateCommitMessage(input: {
	changeSet: RepoChangeSet;
	recentIntent: string;
	model?: string;
	signal?: AbortSignal;
}): Promise<string> {
	if (!input.model) return fallbackMessage(input.changeSet.changedFiles, input.changeSet.repo.relativePath);

	const prompt = buildPrompt(input.changeSet, input.recentIntent);
	try {
		const raw = await runPiMessageGenerator(prompt, input.model, input.signal);
		const repaired = repairConventionalCommit(raw);
		return repaired ?? fallbackMessage(input.changeSet.changedFiles, input.changeSet.repo.relativePath);
	} catch {
		return fallbackMessage(input.changeSet.changedFiles, input.changeSet.repo.relativePath);
	}
}

function buildPrompt(changeSet: RepoChangeSet, recentIntent: string): string {
	return [
		"You generate high-quality Conventional Commit messages.",
		"",
		"Use the git changes plus recent user intent to infer the essence of the change.",
		"Optimize for future changelog generation.",
		"",
		"Output only the commit message.",
		"",
		"Rules:",
		"- Use Conventional Commits: <type>(<scope>): <description>.",
		"- Allowed types: feat, fix, refactor, docs, test, chore, build, ci, perf, style.",
		"- Subject should usually be <= 90 chars and never exceed 120.",
		"- Describe what changed, not an instruction or task title.",
		"- Prefer past-tense or result-oriented phrasing (for example: 'parent model inheritance added', 'README config docs updated').",
		"- Avoid imperative task verbs like add, update, fix, implement, or inherit as the first word of the subject.",
		"- Add a body when it clarifies motivation, behavior, or impact.",
		"- Do not invent issue numbers.",
		"- Do not use markdown fences.",
		"- Prefer user/maintainer-relevant meaning over low-level implementation detail.",
		"",
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

async function runPiMessageGenerator(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-autocommit-"));
	const promptFile = path.join(tmp, "prompt.md");
	await fs.writeFile(promptFile, prompt, "utf8");

	try {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-builtin-tools",
			"--model",
			model,
			"--append-system-prompt",
			promptFile,
			"Generate the commit message now.",
		];
		const invocation = getPiInvocation(args);
		return await new Promise<string>((resolve, reject) => {
			const proc = spawn(invocation.command, invocation.args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let finalText = "";
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						finalText = extractText(event.message) || finalText;
					}
				} catch {
					// Keep raw stdout as fallback; some modes/providers may print plain text.
				}
			};

			proc.stdout.on("data", (data) => {
				const text = data.toString();
				stdout += text;
				buffer += text;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("error", reject);
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (code !== 0) reject(new Error(stderr || stdout || `pi exited with ${code}`));
				else resolve(finalText || stdout);
			});

			if (signal) {
				const abort = () => {
					proc.kill("SIGTERM");
					reject(new Error("message generation aborted"));
				};
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

function extractText(message: any): string {
	const content = message?.content;
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n").trim();
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fsSync.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

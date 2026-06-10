import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocommitOptions, RepoChangeSet, RepoInfo } from "./types.js";

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30000): Promise<ExecResult> {
	return (await pi.exec("git", ["-C", cwd, ...args], { timeout })) as ExecResult;
}

export async function findGitRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) throw new Error(`Not inside a git repository.\n${result.stderr || result.stdout}`);
	return path.resolve(result.stdout.trim());
}

export async function discoverRepos(pi: ExtensionAPI, root: string, recursive: boolean): Promise<RepoInfo[]> {
	const repos: RepoInfo[] = [{ path: root, relativePath: ".", depth: 0, isRoot: true }];
	if (!recursive) return repos;

	const result = await git(pi, root, ["submodule", "status", "--recursive"]);
	if (result.code !== 0) return repos;

	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = trimmed.match(/^[ +-U]?([0-9a-f]{40})\s+([^\s]+)(?:\s|$)/i);
		if (!match) continue;
		const relativePath = match[2];
		const absolute = path.resolve(root, relativePath);
		repos.push({
			path: absolute,
			relativePath: normalizePath(relativePath),
			depth: normalizePath(relativePath).split("/").length,
			isRoot: false,
		});
	}

	return repos.sort((a, b) => b.depth - a.depth || a.relativePath.localeCompare(b.relativePath));
}

export async function collectChangeSet(
	pi: ExtensionAPI,
	repo: RepoInfo,
	options: AutocommitOptions,
): Promise<RepoChangeSet | null> {
	const dryRunAll = options.dryRun && options.stageMode === "all";
	if (options.stageMode === "all" && !options.dryRun) {
		const add = await git(pi, repo.path, ["add", "-A"], 120000);
		if (add.code !== 0) throw new Error(`Failed to stage changes in ${repo.relativePath}:\n${add.stderr || add.stdout}`);
	}

	const branchInfo = await currentBranch(pi, repo.path);
	const staged = dryRunAll ? await hasDiff(pi, repo.path, ["diff", "HEAD", "--quiet"]) : await hasDiff(pi, repo.path, ["diff", "--cached", "--quiet"]);
	const unstaged = await hasDiff(pi, repo.path, ["diff", "--quiet"]);
	const untracked = await listLines(pi, repo.path, ["ls-files", "--others", "--exclude-standard"]);

	if (!staged && !(dryRunAll && untracked.length > 0)) return null;

	const diffArgs = dryRunAll ? ["diff", "HEAD"] : ["diff", "--cached"];
	const changedFiles = dryRunAll
		? Array.from(new Set([...(await listLines(pi, repo.path, [...diffArgs, "--name-only"])), ...untracked]))
		: await listLines(pi, repo.path, [...diffArgs, "--name-only"]);
	const diffStat = await output(pi, repo.path, [...diffArgs, "--stat"]);
	let diff = "";
	if (options.maxDiffBytes <= 0) {
		diff = "[diff omitted by maxDiffBytes=0]";
	} else {
		diff = await output(pi, repo.path, [...diffArgs, "--", ...changedFiles.filter((file) => !untracked.includes(file)).slice(0, 50)], 120000);
		if (dryRunAll && untracked.length > 0) diff += `\n\nUntracked files to be added:\n${untracked.map((f) => `- ${f}`).join("\n")}`;
		if (diff.length > options.maxDiffBytes) {
			diff = `${diff.slice(0, options.maxDiffBytes)}\n\n[diff truncated at ${options.maxDiffBytes} bytes]`;
		}
	}

	return {
		repo,
		branch: branchInfo.branch,
		detached: branchInfo.detached,
		staged,
		unstaged,
		untracked,
		changedFiles,
		diffStat,
		diff,
	};
}

export async function stageSubmoduleGitlinks(pi: ExtensionAPI, repo: RepoInfo): Promise<ExecResult | null> {
	const submodules = await listSubmodulePaths(pi, repo.path);
	if (submodules.length === 0) return null;
	return git(pi, repo.path, ["add", "--", ...submodules], 120000);
}

export async function commitRepo(
	pi: ExtensionAPI,
	repo: RepoInfo,
	messageFile: string,
	noVerify: boolean,
): Promise<ExecResult> {
	const args = ["commit"];
	if (noVerify) args.push("--no-verify");
	args.push("-F", messageFile);
	return git(pi, repo.path, args, 180000);
}

async function currentBranch(pi: ExtensionAPI, repoPath: string): Promise<{ branch: string; detached: boolean }> {
	const branch = await output(pi, repoPath, ["branch", "--show-current"]);
	if (branch.trim()) return { branch: branch.trim(), detached: false };
	const short = await output(pi, repoPath, ["rev-parse", "--short", "HEAD"]);
	return { branch: short.trim() || "HEAD", detached: true };
}

async function hasDiff(pi: ExtensionAPI, cwd: string, args: string[]): Promise<boolean> {
	const result = await git(pi, cwd, args);
	return result.code === 1;
}

async function output(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30000): Promise<string> {
	const result = await git(pi, cwd, args, timeout);
	return result.stdout.trim();
}

async function listLines(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string[]> {
	const text = await output(pi, cwd, args);
	return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function listSubmodulePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await git(pi, cwd, ["submodule", "status"]);
	if (result.code !== 0) return [];
	const paths: string[] = [];
	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = trimmed.match(/^[ +-U]?[0-9a-f]{40}\s+([^\s]+)(?:\s|$)/i);
		if (match) paths.push(normalizePath(match[1]));
	}
	return paths;
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

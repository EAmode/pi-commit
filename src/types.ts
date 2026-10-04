import type { ModelThinkingLevel } from "@earendil-works/pi-ai/compat";

export type StageMode = "staged" | "all";
export type MessageSource = "ai" | "fallback";

export interface AutocommitOptions {
	stageMode: StageMode;
	dryRun: boolean;
	noVerify: boolean;
	yes: boolean;
	model?: string;
	messageTimeoutMs: number;
	maxDiffBytes: number;
	profile: boolean;
	thinkingLevel?: ModelThinkingLevel;
	prompt?: string;
}

export interface PiCommitConfig {
	model?: string;
	messageTimeoutMs?: number;
	defaultMode?: StageMode;
	maxDiffBytes?: number;
	confirmBeforeCommit?: boolean;
	profile?: boolean;
	thinkingLevel?: ModelThinkingLevel;
	prompt?: string;
}

export interface RepoInfo {
	path: string;
	relativePath: string;
	depth: number;
	isRoot: boolean;
}

export interface RepoChangeSet {
	repo: RepoInfo;
	branch: string;
	detached: boolean;
	staged: boolean;
	unstaged: boolean;
	untracked: string[];
	changedFiles: string[];
	diffStat: string;
	diff: string;
}

export interface MessageGenerationResult {
	message: string;
	source: MessageSource;
	fallbackReason?: string;
	model?: string;
}

export interface PlannedCommit {
	changeSet: RepoChangeSet;
	message: string;
	messageSource: MessageSource;
	fallbackReason?: string;
	messageModel?: string;
}

export interface CommitResult {
	repo: RepoInfo;
	message: string;
	messageSource: MessageSource;
	fallbackReason?: string;
	messageModel?: string;
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

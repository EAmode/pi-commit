export type StageMode = "staged" | "all";
export type MessageSource = "ai" | "fallback";

export interface AutocommitOptions {
	stageMode: StageMode;
	recursive: boolean;
	dryRun: boolean;
	noVerify: boolean;
	yes: boolean;
	model?: string;
	messageTimeoutMs: number;
	messageMaxTokens: number;
	maxMessageChars: number;
	maxDiffBytes: number;
	profile: boolean;
}

export interface PiCommitConfig {
	model?: string;
	messageTimeoutMs?: number;
	messageMaxTokens?: number;
	maxMessageChars?: number;
	defaultMode?: StageMode;
	recursive?: boolean;
	maxDiffBytes?: number;
	confirmBeforeCommit?: boolean;
	profile?: boolean;
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

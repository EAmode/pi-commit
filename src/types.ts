export type ContextMode = "none" | "recent" | "session";
export type StageMode = "staged" | "all";

export interface AutocommitOptions {
	stageMode: StageMode;
	recursive: boolean;
	dryRun: boolean;
	noVerify: boolean;
	yes: boolean;
	model?: string;
	contextMode: ContextMode;
	recentPromptCount: number;
	maxContextBytes: number;
	maxDiffBytes: number;
}

export interface PiCommitConfig {
	model?: string;
	defaultMode?: StageMode;
	recursive?: boolean;
	contextMode?: ContextMode;
	recentPromptCount?: number;
	maxContextBytes?: number;
	maxDiffBytes?: number;
	confirmBeforeCommit?: boolean;
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

export interface PlannedCommit {
	changeSet: RepoChangeSet;
	message: string;
}

export interface CommitResult {
	repo: RepoInfo;
	message: string;
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

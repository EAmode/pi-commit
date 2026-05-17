const ALLOWED_TYPES = new Set(["feat", "fix", "refactor", "docs", "test", "chore", "build", "ci", "perf", "style"]);
const HEADER_RE = /^(feat|fix|refactor|docs|test|chore|build|ci|perf|style)(\([^)\r\n]+\))?!?: .{1,120}$/;

export function cleanModelMessage(raw: string): string {
	let text = raw.trim();
	text = text.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
	text = text.replace(/^['"]([\s\S]*?)['"]$/u, "$1").trim();
	return text.replace(/\r\n/g, "\n");
}

export function isConventionalCommit(message: string): boolean {
	const header = message.trim().split("\n")[0]?.trim() ?? "";
	return HEADER_RE.test(header);
}

export function repairConventionalCommit(raw: string): string | null {
	const cleaned = cleanModelMessage(raw);
	if (isConventionalCommit(cleaned)) return cleaned;

	const lines = cleaned.split("\n");
	const firstUseful = lines.find((line) => /^(feat|fix|refactor|docs|test|chore|build|ci|perf|style)/.test(line.trim()));
	if (firstUseful) {
		const idx = lines.indexOf(firstUseful);
		const candidate = [firstUseful.trim(), ...lines.slice(idx + 1)].join("\n").trim();
		if (isConventionalCommit(candidate)) return candidate;
	}

	return null;
}

export function fallbackMessage(changedFiles: string[], repoRelativePath: string): string {
	const scope = inferScope(changedFiles, repoRelativePath);
	return `chore${scope ? `(${scope})` : ""}: repository changed`;
}

export function inferScope(changedFiles: string[], repoRelativePath: string): string {
	const fromRepo = repoRelativePath && repoRelativePath !== "." ? repoRelativePath.split(/[\\/]/).pop() : "";
	if (changedFiles.length === 0) return sanitizeScope(fromRepo || "repo");

	const firstParts = changedFiles.map((file) => file.split(/[\\/]/).filter(Boolean)[0]).filter(Boolean);
	const unique = Array.from(new Set(firstParts));
	if (unique.length === 1) return sanitizeScope(unique[0]);
	if (fromRepo) return sanitizeScope(fromRepo);
	return "repo";
}

function sanitizeScope(scope: string): string {
	const clean = scope.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return clean || "repo";
}

export function normalizeType(type: string): string {
	return ALLOWED_TYPES.has(type) ? type : "chore";
}

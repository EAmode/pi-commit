import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackMessage, isConventionalCommit, repairConventionalCommit } from "./conventional.js";

test("preserves a bare model description in a conventional fallback", () => {
	const description = "eslint config and lint script added with TypeScript strict mode improvements";
	const message = fallbackMessage(["eslint.config.js", "tsconfig.json"], "apps/website", description);
	assert.equal(message, `chore(website): ${description}`);
	assert.ok(isConventionalCommit(message));
});

test("repairs deps type without discarding the description or body", () => {
	const description = "upgrade pino, uuid, valibot and eslint tooling to latest versions";
	assert.equal(repairConventionalCommit(`deps: ${description}\n\nDependency details.`),
		`chore(deps): ${description}\n\nDependency details.`);
});

test("preserves bodies and cleans surrounding model formatting", () => {
	assert.equal(fallbackMessage([], "website", "```text\nconfigure linting\n\nEnable strict checks.\n```"),
		"chore(website): configure linting\n\nEnable strict checks.");
});

test("retains long descriptions in full in the body", () => {
	const description = "Detailed changes ".repeat(20).trim();
	const message = fallbackMessage([], "website", description);
	assert.ok(isConventionalCommit(message));
	assert.ok(message.split("\n")[0].length <= 120);
	assert.equal(message.split("\n\n")[1], description);
});

test("uses the generic fallback only without a description", () => {
	assert.equal(fallbackMessage([], "website"), "chore(website): repository changed");
	assert.equal(fallbackMessage([], "website", " \n "), "chore(website): repository changed");
});

test("leaves valid conventional messages unchanged", () => {
	const message = "fix(core)!: reject invalid configuration\n\nBREAKING CHANGE: invalid values now throw.";
	assert.equal(repairConventionalCommit(message), message);
});

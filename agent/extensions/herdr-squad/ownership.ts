import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { posix } from "node:path";

function hasParentTraversal(value: string): boolean {
	return value.split("/").includes("..");
}

function hasGitMetadata(value: string): boolean {
	return value.split("/").includes(".git");
}

function isWindowsAbsolute(value: string): boolean {
	return /^[A-Za-z]:\//.test(value) || value.startsWith("//");
}

export function normalizeRepositoryPath(value: string, options: { allowDot?: boolean } = {}): string {
	const raw = value.trim().replaceAll("\\", "/");
	if (!raw || raw.includes("\u0000")) throw new Error("Repository paths must not be empty or contain NUL characters");
	if (raw.startsWith("/") || isWindowsAbsolute(raw)) throw new Error(`Repository path must be relative: ${value}`);
	if (hasParentTraversal(raw)) throw new Error(`Repository path must not contain parent traversal: ${value}`);

	const normalized = posix.normalize(raw).replace(/^\.\//, "").replace(/\/$/, "") || ".";
	if (normalized === ".." || normalized.startsWith("../")) throw new Error(`Repository path escapes the checkout: ${value}`);
	if (normalized === "." && options.allowDot === false) throw new Error(`Repository path must identify a file: ${value}`);
	if (hasGitMetadata(normalized)) throw new Error(`Git metadata is never writable: ${value}`);
	return normalized;
}

export function pathContains(root: string, candidate: string): boolean {
	return root === "." || candidate === root || candidate.startsWith(`${root}/`);
}

export function pathsOverlap(left: string, right: string): boolean {
	return pathContains(left, right) || pathContains(right, left);
}

async function canonicalTarget(checkoutRoot: string, target: string, requireRelative: boolean): Promise<{ absolutePath: string; repositoryPath: string }> {
	const canonicalCheckout = await realpath(checkoutRoot);
	const raw = target.trim().replace(/^@/, "").replaceAll("\\", "/");
	if (!raw || raw.includes("\u0000")) throw new Error("Target path must not be empty or contain NUL characters");
	if (requireRelative) normalizeRepositoryPath(raw);
	if (isWindowsAbsolute(raw)) throw new Error(`Target path is outside the checkout: ${target}`);

	const lexicalTarget = resolve(canonicalCheckout, raw);
	const lexicalRelative = relative(canonicalCheckout, lexicalTarget);
	if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
		throw new Error(`Target path is outside the checkout: ${target}`);
	}
	const lexicalRepositoryPath = (lexicalRelative || ".").split(sep).join("/");
	if (hasGitMetadata(lexicalRepositoryPath)) throw new Error(`Git metadata is never writable: ${target}`);

	let existing = lexicalTarget;
	while (true) {
		try {
			await lstat(existing);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(existing);
			if (parent === existing) throw new Error(`Could not resolve target path safely: ${target}`);
			existing = parent;
		}
	}

	let canonicalExisting: string;
	try {
		canonicalExisting = await realpath(existing);
	} catch {
		throw new Error(`Could not resolve existing target or parent safely: ${target}`);
	}
	const canonical = resolve(canonicalExisting, relative(existing, lexicalTarget));
	const canonicalRelative = relative(canonicalCheckout, canonical);
	if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
		throw new Error(`Target path resolves outside the checkout: ${target}`);
	}
	const repositoryPath = (canonicalRelative || ".").split(sep).join("/");
	if (hasGitMetadata(repositoryPath)) throw new Error(`Git metadata is never writable: ${target}`);
	return { absolutePath: canonical, repositoryPath };
}

export async function canonicalizeWritableRoot(checkoutRoot: string, root: string): Promise<string> {
	return (await canonicalTarget(checkoutRoot, normalizeRepositoryPath(root), true)).repositoryPath;
}

export async function validateExclusiveWritableRoots(
	checkoutRoot: string,
	assignments: Array<{ label: string; writableRoots: string[] }>,
): Promise<Array<{ label: string; writableRoots: string[]; canonicalWritableRoots: string[] }>> {
	const normalized = assignments.map((assignment) => {
		const roots = assignment.writableRoots.map((root) => normalizeRepositoryPath(root));
		if (roots.length === 0) throw new Error(`${assignment.label} requires at least one writable root`);
		if (new Set(roots).size !== roots.length) throw new Error(`${assignment.label} has duplicate writable roots`);
		if (roots.includes(".") && (assignments.length !== 1 || roots.length !== 1)) {
			throw new Error("writableRoots may contain '.' only when one worker owns the full checkout");
		}
		return { label: assignment.label, writableRoots: roots };
	});

	const canonical = await Promise.all(
		normalized.map(async (assignment) => ({
			...assignment,
			canonicalRoots: await Promise.all(assignment.writableRoots.map((root) => canonicalizeWritableRoot(checkoutRoot, root))),
		})),
	);
	for (let left = 0; left < canonical.length; left++) {
		for (let right = left + 1; right < canonical.length; right++) {
			for (let leftIndex = 0; leftIndex < canonical[left].writableRoots.length; leftIndex++) {
				for (let rightIndex = 0; rightIndex < canonical[right].writableRoots.length; rightIndex++) {
					const declaredLeft = canonical[left].writableRoots[leftIndex];
					const declaredRight = canonical[right].writableRoots[rightIndex];
					const canonicalLeft = canonical[left].canonicalRoots[leftIndex];
					const canonicalRight = canonical[right].canonicalRoots[rightIndex];
					if (pathsOverlap(declaredLeft, declaredRight) || pathsOverlap(canonicalLeft, canonicalRight)) {
						throw new Error(
							`Writable roots overlap between ${canonical[left].label} (${declaredLeft}) and ${canonical[right].label} (${declaredRight})`,
						);
					}
				}
			}
		}
	}
	return canonical.map((assignment) => ({
		label: assignment.label,
		writableRoots: assignment.writableRoots,
		canonicalWritableRoots: assignment.canonicalRoots,
	}));
}

export async function assertWorkerWriteAllowed(
	checkoutRoot: string,
	writableRoots: string[],
	target: string,
	canonicalWritableRoots?: string[],
): Promise<string> {
	const resolvedTarget = await canonicalTarget(checkoutRoot, target, false);
	const canonicalRoots =
		canonicalWritableRoots ?? (await Promise.all(writableRoots.map((root) => canonicalizeWritableRoot(checkoutRoot, root))));
	if (!canonicalRoots.some((root) => pathContains(root, resolvedTarget.repositoryPath))) {
		throw new Error(`Write blocked: ${target} is outside this worker's writable roots (${writableRoots.join(", ")})`);
	}
	return resolvedTarget.absolutePath;
}

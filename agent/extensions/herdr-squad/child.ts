import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertWorkerWriteAllowed, canonicalizeWritableRoot, normalizeRepositoryPath } from "./ownership.ts";
import {
	MANIFEST_FILE,
	RUN_DIR_PREFIX,
	reportFileName,
	type SquadKind,
	type SquadManifest,
	type SquadReport,
} from "./shared.ts";

const ChangedFileParams = Type.Object({
	path: Type.String({ description: "Repository-relative path of a file created or modified by this worker", minLength: 1, maxLength: 1000 }),
	summary: Type.String({ description: "Concise summary of the change", minLength: 1, maxLength: 1000 }),
});

const ValidationParams = Type.Object({
	command: Type.String({ description: "Validation command that was run", minLength: 1, maxLength: 1000 }),
	result: Type.String({ description: "Concise result, including failures", minLength: 1, maxLength: 2000 }),
});

const ReportParams = Type.Object({
	findings: Type.String({
		description: "Concise findings or implementation summary for the assigned scope",
		minLength: 1,
		maxLength: 6000,
	}),
	evidence: Type.Array(Type.String({ maxLength: 500 }), {
		description: "Concrete file paths, symbols, configuration keys, or other evidence",
		maxItems: 20,
	}),
	risksOrUnknowns: Type.Array(Type.String({ maxLength: 500 }), {
		description: "Unverified assumptions, risks, handoffs, or intentionally unchanged files",
		maxItems: 12,
	}),
	recommendedNextStep: Type.String({
		description: "One actionable next step for the parent agent",
		minLength: 1,
		maxLength: 2000,
	}),
	changedFiles: Type.Optional(Type.Array(ChangedFileParams, { description: "Files created or modified by a worker", maxItems: 100 })),
	validation: Type.Optional(Type.Array(ValidationParams, { description: "Validation commands and their results", maxItems: 30 })),
});

interface ValidatedChild {
	manifest: SquadManifest;
	agent: SquadManifest["agents"][number];
	kind: SquadKind;
	checkoutRoot?: string;
}

async function loadValidatedManifest(
	runDir: string,
	squadId: string,
	agentId: string,
	token: string,
): Promise<ValidatedChild> {
	if (!basename(runDir).startsWith(RUN_DIR_PREFIX)) throw new Error("Invalid Herdr squad run directory");

	const [realRunDir, realTmpDir, stat] = await Promise.all([realpath(runDir), realpath(tmpdir()), lstat(runDir)]);
	if (stat.isSymbolicLink() || !stat.isDirectory() || dirname(realRunDir) !== realTmpDir) {
		throw new Error("Unsafe Herdr squad run directory");
	}

	const manifest = JSON.parse(await readFile(join(realRunDir, MANIFEST_FILE), "utf8")) as SquadManifest;
	const agent = manifest.agents?.find((candidate) => candidate.agentId === agentId);
	if ((manifest.version !== 1 && manifest.version !== 2) || manifest.squadId !== squadId || !agent || agent.token !== token) {
		throw new Error("Herdr squad child identity could not be verified");
	}

	const kind: SquadKind = manifest.version === 2 && manifest.kind === "worker" ? "worker" : "investigation";
	if (kind === "worker") {
		if (!manifest.checkoutRoot || !Array.isArray(agent.writableRoots) || agent.writableRoots.length === 0) {
			throw new Error("Worker ownership is missing from the Herdr squad manifest");
		}
		const normalizedRoots = agent.writableRoots.map((root) => normalizeRepositoryPath(root));
		if (new Set(normalizedRoots).size !== normalizedRoots.length) throw new Error("Worker writable roots are invalid");
		agent.writableRoots = normalizedRoots;
		const [checkoutRoot, childCwd] = await Promise.all([realpath(manifest.checkoutRoot), realpath(process.cwd())]);
		if (checkoutRoot !== childCwd) throw new Error("Worker checkout identity could not be verified");
		const canonicalRoots = agent.canonicalWritableRoots?.map((root) => normalizeRepositoryPath(root));
		if (canonicalRoots && canonicalRoots.length !== normalizedRoots.length) throw new Error("Worker canonical ownership is invalid");
		agent.canonicalWritableRoots =
			canonicalRoots ?? (await Promise.all(normalizedRoots.map((root) => canonicalizeWritableRoot(checkoutRoot, root))));
		return { manifest, agent, kind, checkoutRoot };
	}
	return { manifest, agent, kind };
}

export function registerChildReportTool(pi: ExtensionAPI): boolean {
	const runDir = process.env.HERDR_SQUAD_DIR;
	const squadId = process.env.HERDR_SQUAD_ID;
	const agentId = process.env.HERDR_SQUAD_AGENT_ID;
	const token = process.env.HERDR_SQUAD_TOKEN;
	if (!runDir || !squadId || !agentId || !token) return false;

	let validation: Promise<ValidatedChild> | undefined;
	const validate = () => (validation ??= loadValidatedManifest(runDir, squadId, agentId, token));

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
		const child = await validate();
		if (child.kind !== "worker" || !child.checkoutRoot || !child.agent.writableRoots) {
			return { block: true, reason: "Read-only investigation children cannot modify files" };
		}
		const target = (event.input as { path?: unknown }).path;
		if (typeof target !== "string") return { block: true, reason: "Write target path is missing" };
		try {
			await assertWorkerWriteAllowed(
				child.checkoutRoot,
				child.agent.writableRoots,
				target,
				child.agent.canonicalWritableRoots,
			);
			return undefined;
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
	});

	pi.registerTool({
		name: "herdr_squad_report",
		label: "Submit Squad Report",
		description:
			"Submit the final structured report for this Herdr squad assignment. Worker reports can include changed files and validation. Call exactly once as the final action.",
		promptSnippet: "Submit the final structured report for this Herdr squad assignment",
		promptGuidelines: ["Call herdr_squad_report exactly once as the final action after completing the assigned work."],
		parameters: ReportParams,
		async execute(_toolCallId, params) {
			const { agent, kind } = await validate();
			const changedFiles = params.changedFiles?.map((item) => ({
				path: normalizeRepositoryPath(item.path, { allowDot: false }),
				summary: item.summary.trim(),
			}));
			const validationResults = params.validation?.map((item) => ({
				command: item.command.trim(),
				result: item.result.trim(),
			}));
			const report: SquadReport = {
				version: 1,
				squadId,
				agentId,
				label: agent.label,
				scope: agent.scope,
				createdAt: new Date().toISOString(),
				findings: params.findings.trim(),
				evidence: params.evidence.map((item) => item.trim()).filter(Boolean),
				risksOrUnknowns: params.risksOrUnknowns.map((item) => item.trim()).filter(Boolean),
				recommendedNextStep: params.recommendedNextStep.trim(),
				...(kind === "worker" ? { changedFiles: changedFiles ?? [], validation: validationResults ?? [] } : {}),
			};

			const reportPath = join(runDir, reportFileName(agentId));
			await withFileMutationQueue(reportPath, async () => {
				const temporaryPath = join(runDir, `.report-${agentId}-${randomUUID()}.tmp`);
				await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				await rename(temporaryPath, reportPath);
			});

			return {
				content: [{ type: "text", text: `Squad report submitted. ${kind === "worker" ? "Worker task" : "Investigation"} complete.` }],
				details: { squadId, agentId, reportPath, kind },
				terminate: true,
			};
		},
	});
	return true;
}

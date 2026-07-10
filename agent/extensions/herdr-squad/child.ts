import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	MANIFEST_FILE,
	RUN_DIR_PREFIX,
	reportFileName,
	type SquadManifest,
	type SquadReport,
} from "./shared.ts";

const ReportParams = Type.Object({
	findings: Type.String({
		description: "Concise findings for the assigned scope, with concrete code references where possible",
		minLength: 1,
		maxLength: 6000,
	}),
	evidence: Type.Array(Type.String({ maxLength: 500 }), {
		description: "Concrete file paths, symbols, configuration keys, or other inspected evidence",
		maxItems: 20,
	}),
	risksOrUnknowns: Type.Array(Type.String({ maxLength: 500 }), {
		description: "Unverified assumptions, gaps, risks, or handoffs to another scope",
		maxItems: 12,
	}),
	recommendedNextStep: Type.String({
		description: "One actionable next step for the parent agent",
		minLength: 1,
		maxLength: 2000,
	}),
});

async function loadValidatedManifest(
	runDir: string,
	squadId: string,
	agentId: string,
	token: string,
): Promise<{ manifest: SquadManifest; agent: SquadManifest["agents"][number] }> {
	if (!basename(runDir).startsWith(RUN_DIR_PREFIX)) {
		throw new Error("Invalid Herdr squad run directory");
	}

	const [realRunDir, realTmpDir, stat] = await Promise.all([realpath(runDir), realpath(tmpdir()), lstat(runDir)]);
	if (stat.isSymbolicLink() || !stat.isDirectory() || dirname(realRunDir) !== realTmpDir) {
		throw new Error("Unsafe Herdr squad run directory");
	}

	const manifest = JSON.parse(await readFile(join(realRunDir, MANIFEST_FILE), "utf8")) as SquadManifest;
	const agent = manifest.agents?.find((candidate) => candidate.agentId === agentId);
	if (manifest.version !== 1 || manifest.squadId !== squadId || !agent || agent.token !== token) {
		throw new Error("Herdr squad child identity could not be verified");
	}
	return { manifest, agent };
}

export function registerChildReportTool(pi: ExtensionAPI): boolean {
	const runDir = process.env.HERDR_SQUAD_DIR;
	const squadId = process.env.HERDR_SQUAD_ID;
	const agentId = process.env.HERDR_SQUAD_AGENT_ID;
	const token = process.env.HERDR_SQUAD_TOKEN;
	if (!runDir || !squadId || !agentId || !token) return false;

	pi.registerTool({
		name: "herdr_squad_report",
		label: "Submit Squad Report",
		description:
			"Submit the final structured report for this read-only Herdr squad assignment. Call exactly once as the final action.",
		promptSnippet: "Submit the final structured report for this Herdr squad assignment",
		promptGuidelines: [
			"Call herdr_squad_report exactly once as the final action after completing the assigned read-only investigation.",
		],
		parameters: ReportParams,
		async execute(_toolCallId, params) {
			const { agent } = await loadValidatedManifest(runDir, squadId, agentId, token);
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
			};

			const reportPath = join(runDir, reportFileName(agentId));
			await withFileMutationQueue(reportPath, async () => {
				const temporaryPath = join(runDir, `.report-${agentId}-${randomUUID()}.tmp`);
				await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				await rename(temporaryPath, reportPath);
			});

			return {
				content: [{ type: "text", text: "Squad report submitted. Investigation complete." }],
				details: { squadId, agentId, reportPath },
				terminate: true,
			};
		},
	});
	return true;
}

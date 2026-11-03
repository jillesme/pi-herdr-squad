import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertWorkerWriteAllowed, canonicalizeWritableRoot, normalizeRepositoryPath, toRepositoryRelative } from "./ownership.ts";
import {
	MANIFEST_FILE,
	RUN_DIR_PREFIX,
	reportFileName,
	readSquadReport,
	STEER_DELIVERED_SUFFIX,
	steerFilePrefix,
	type SquadKind,
	type SquadManifest,
	type SquadReport,
	type SquadSteerMessage,
} from "./shared.ts";

const MAX_FINDINGS_LENGTH = 20_000;
const MAX_NUDGES = 2;
const STEER_POLL_MS = 1_000;
const STEER_ENTRY_TYPE = "herdr-squad-steer";

const ChangedFileParams = Type.Object({
	path: Type.String({ description: "Path of a file created or modified by this worker, repository-relative or absolute inside the checkout", minLength: 1, maxLength: 1000 }),
	summary: Type.String({ description: "Concise summary of the change", minLength: 1, maxLength: 1000 }),
});

const ValidationParams = Type.Object({
	command: Type.String({ description: "Validation command that was run", minLength: 1, maxLength: 1000 }),
	result: Type.String({ description: "Concise result, including failures", minLength: 1, maxLength: 2000 }),
});

const ReportParams = Type.Object({
	findings: Type.String({
		description: "Findings or implementation summary for the assigned scope. Markdown is fine; prioritize the most important points.",
		minLength: 1,
		maxLength: MAX_FINDINGS_LENGTH,
	}),
	evidence: Type.Optional(
		Type.Array(Type.String({ maxLength: 1000 }), {
			description: "Concrete file paths, symbols, URLs, configuration keys, or other evidence. Defaults to an empty list.",
			maxItems: 50,
		}),
	),
	risksOrUnknowns: Type.Optional(
		Type.Array(Type.String({ maxLength: 1000 }), {
			description: "Unverified assumptions, risks, handoffs, or intentionally unchanged files. Defaults to an empty list.",
			maxItems: 30,
		}),
	),
	recommendedNextStep: Type.Optional(
		Type.String({
			description: "One actionable next step for the parent agent",
			maxLength: 2000,
		}),
	),
	changedFiles: Type.Optional(
		Type.Array(ChangedFileParams, { description: "Files created or modified by a worker (repository-relative or absolute inside the checkout)", maxItems: 200 }),
	),
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

	// A child that ends its run without a report looks finished to the parent but returns nothing.
	// Continue the same run with a reminder so Herdr keeps showing it as working.
	let reported = false;
	let steerId: string | undefined;
	let deliveredSteerId: string | undefined;
	let nudges = 0;
	// Delivery can happen during an old tool batch. Only acknowledge the revision
	// after the model has actually received its message, not merely when queued.
	const steeringMarkers = new Map<string, string>();
	pi.on("context", (event) => {
		if (steeringMarkers.size === 0) return;
		for (const message of event.messages) {
			if (message.role !== "user") continue;
			const text = typeof message.content === "string"
				? message.content
				: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			for (const [marker, id] of steeringMarkers) {
				if (text.includes(marker)) {
					steerId = id;
					steeringMarkers.delete(marker);
				}
			}
		}
	});
	pi.on("agent_before_settle", (event) => {
		if (reported || event.outcome === "aborted" || nudges >= MAX_NUDGES) return undefined;
		nudges++;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "herdr-squad-report-reminder",
					content:
						"You ended without calling herdr_squad_report, so the parent agent received nothing. Call herdr_squad_report now with your complete result. If you could not finish, report what you did, what is missing, and why. Only findings is required.",
					display: true,
				},
			],
			continue: true,
		};
	});

	// Deliver parent steering messages dropped into the run directory by herdr_squad_steer.
	let sessionCtx: ExtensionContext | undefined;
	let steerTimer: ReturnType<typeof setInterval> | undefined;
	let polling = false;
	const steerDir = runDir;
	const prefix = steerFilePrefix(agentId);

	async function deliverSteerMessages(): Promise<void> {
		if (polling || !sessionCtx) return;
		polling = true;
		try {
			await validate();
			const names = (await readdir(steerDir)).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
			for (const name of names) {
				if (!sessionCtx) return;
				const path = join(steerDir, name);
				let steer: Partial<SquadSteerMessage>;
				try {
					steer = JSON.parse(await readFile(path, "utf8"));
				} catch {
					continue;
				}
				if (!steer || steer.version !== 1 || steer.squadId !== squadId || steer.agentId !== agentId || typeof steer.message !== "string") continue;
				// A steered child must report again, even if it already reported.
				reported = false;
				deliveredSteerId = typeof steer.id === "string" ? steer.id : undefined;
				nudges = 0;
				const marker = `[Message from the parent agent${deliveredSteerId ? `: ${deliveredSteerId}` : ""}]`;
				if (deliveredSteerId) {
					steeringMarkers.set(marker, deliveredSteerId);
					pi.appendEntry(STEER_ENTRY_TYPE, { id: deliveredSteerId, marker });
				}
				const text = `${marker}\n${steer.message}\n\nWhen you are done, call herdr_squad_report again with your complete, updated result.`;
				if (sessionCtx.isIdle()) pi.sendUserMessage(text);
				else pi.sendUserMessage(text, { deliverAs: "steer" });
				// Acknowledge only after the message has been handed to Pi.
				await rename(path, `${path}${STEER_DELIVERED_SUFFIX}`);
			}
		} catch {
			// Retried on the next tick.
		} finally {
			polling = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// Restore steering revisions on /reload or resume as well as in the parent.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STEER_ENTRY_TYPE) continue;
			const data = entry.data as { id?: unknown; marker?: unknown } | undefined;
			if (typeof data?.id !== "string" || typeof data.marker !== "string") continue;
			deliveredSteerId = data.id;
			steeringMarkers.set(data.marker, data.id);
		}
		const report = await readSquadReport(join(runDir, reportFileName(agentId)));
		if (report?.squadId === squadId && report.agentId === agentId) {
			steerId = report.steerId;
			reported = steerId === deliveredSteerId;
		}
		sessionCtx = ctx;
		if (steerTimer) return;
		steerTimer = setInterval(() => void deliverSteerMessages(), STEER_POLL_MS);
		steerTimer.unref?.();
	});

	pi.on("session_shutdown", () => {
		if (steerTimer) clearInterval(steerTimer);
		steerTimer = undefined;
		sessionCtx = undefined;
	});

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
			"Submit the final structured report for this Herdr squad assignment. Worker reports can include changed files and validation. Call exactly once as the final action; after a parent follow-up message, call it again with the updated result.",
		promptSnippet: "Submit the final structured report for this Herdr squad assignment",
		promptGuidelines: ["Call herdr_squad_report exactly once as the final action after completing the assigned work."],
		parameters: ReportParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const reportSteerId = steerId;
			if (!params.findings.trim()) throw new Error("findings must not be empty");
			const { agent, kind, checkoutRoot } = await validate();
			const changedFiles =
				kind === "worker" && checkoutRoot
					? await Promise.all(
							(params.changedFiles ?? []).map(async (item) => ({
								path: normalizeRepositoryPath(await toRepositoryRelative(checkoutRoot, item.path), { allowDot: false }),
								summary: item.summary.trim(),
							})),
						)
					: undefined;
			const validationResults = params.validation?.map((item) => ({
				command: item.command.trim(),
				result: item.result.trim(),
			}));
			const report: SquadReport = {
				version: 1,
				...(reportSteerId ? { steerId: reportSteerId } : {}),
				squadId,
				agentId,
				label: agent.label,
				scope: agent.scope,
				createdAt: new Date().toISOString(),
				findings: params.findings.trim(),
				evidence: (params.evidence ?? []).map((item) => item.trim()).filter(Boolean),
				risksOrUnknowns: (params.risksOrUnknowns ?? []).map((item) => item.trim()).filter(Boolean),
				recommendedNextStep: params.recommendedNextStep?.trim() ?? "",
				...(kind === "worker" ? { changedFiles: changedFiles ?? [], validation: validationResults ?? [] } : {}),
			};

			const reportPath = join(runDir, reportFileName(agentId));
			await withFileMutationQueue(reportPath, async () => {
				const temporaryPath = join(runDir, `.report-${agentId}-${randomUUID()}.tmp`);
				await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				await rename(temporaryPath, reportPath);
			});
			reported = reportSteerId === deliveredSteerId;

			return {
				content: [{ type: "text", text: `Squad report submitted. ${kind === "worker" ? "Worker task" : "Investigation"} complete.` }],
				details: { squadId, agentId, reportPath, kind },
				terminate: true,
			};
		},
	});
	return true;
}

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerChildReportTool } from "./child.ts";
import { resolveConfiguredModel, validateExplicitModel } from "./config.ts";
import { validateExclusiveWritableRoots } from "./ownership.ts";
import {
	buildInvestigationPrompt,
	buildWorkerPrompt,
	MANIFEST_FILE,
	MAX_AGENTS,
	MAX_AGENTS_PER_TAB,
	migrateSquadState,
	normalizeDisplayText,
	readSquadReport,
	reportFileName,
	RUN_DIR_PREFIX,
	shellQuote,
	SQUAD_ENTRY_TYPE,
	STATE_VERSION,
	type SquadAgentState,
	type SquadKind,
	type SquadManifest,
	type SquadState,
	type SquadTabState,
} from "./shared.ts";

const MAX_TASK_LENGTH = 50_000;
const MAX_SCOPE_LENGTH = 8_000;
const MAX_PROMPT_LENGTH = 16_000;
const DEFAULT_WAIT_MS = 5 * 60_000;
const MAX_WAIT_MS = 30 * 60_000;
const BLOCKED_GRACE_MS = 1_500;
const POLL_INTERVAL_MS = 500;

const AssignmentSchema = Type.Object({
	label: Type.String({ description: "Short unique agent label", minLength: 1, maxLength: 80 }),
	scope: Type.String({ description: "Exclusive, non-overlapping investigation scope", minLength: 1, maxLength: MAX_SCOPE_LENGTH }),
	prompt: Type.String({ description: "Specific read-only investigation instructions", minLength: 1, maxLength: MAX_PROMPT_LENGTH }),
});

const WorkerAssignmentSchema = Type.Object({
	label: Type.String({ description: "Short unique worker label", minLength: 1, maxLength: 80 }),
	scope: Type.String({ description: "Exclusive functional scope", minLength: 1, maxLength: MAX_SCOPE_LENGTH }),
	writableRoots: Type.Array(Type.String({ description: "Exclusive repository-relative file or directory root", minLength: 1, maxLength: 1000 }), {
		minItems: 1,
		maxItems: 100,
	}),
	prompt: Type.String({ description: "Specific implementation instructions", minLength: 1, maxLength: MAX_PROMPT_LENGTH }),
});

function startSchema(assignmentSchema: typeof AssignmentSchema | typeof WorkerAssignmentSchema) {
	return Type.Object({
		task: Type.String({ description: "Full parent task", minLength: 1, maxLength: MAX_TASK_LENGTH }),
		count: Type.Integer({ description: "Exact number of visible agents", minimum: 1, maximum: MAX_AGENTS }),
		assignments: Type.Array(assignmentSchema, { minItems: 1, maxItems: MAX_AGENTS }),
		title: Type.Optional(Type.String({ description: "Short tab title", maxLength: 80 })),
		model: Type.Optional(
			Type.String({ description: "Optional child model override, for example provider/model or model:thinking", minLength: 1, maxLength: 200 }),
		),
		focus: Type.Optional(Type.Boolean({ description: "Focus the first squad tab after launch; defaults to false" })),
	});
}

const StartParams = startSchema(AssignmentSchema);
const WorkerStartParams = startSchema(WorkerAssignmentSchema);

const SquadIdParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by a Herdr squad start tool", minLength: 8, maxLength: 80 }),
	timeoutMs: Type.Optional(Type.Integer({ description: "Overall wait timeout in milliseconds", minimum: 1_000, maximum: MAX_WAIT_MS })),
});

const CollectParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by a Herdr squad start tool", minLength: 8, maxLength: 80 }),
	lines: Type.Optional(Type.Integer({ description: "Terminal-tail lines used only when a structured report is missing", minimum: 40, maximum: 2_000 })),
});

type JsonObject = Record<string, any>;

interface LaunchAssignment {
	label: string;
	scope: string;
	prompt: string;
	writableRoots?: string[];
	canonicalWritableRoots?: string[];
}

interface StartInput {
	task: string;
	count: number;
	assignments: Array<{ label: string; scope: string; prompt: string; writableRoots?: string[] }>;
	title?: string;
	model?: string;
	focus?: boolean;
}

function cleanBody(value: string, maxLength: number): string {
	return value.replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function publicSquadDetails(state: SquadState) {
	return {
		squadId: state.squadId,
		kind: state.kind,
		status: state.status,
		tabs: state.tabs.map((tab) => ({ tabId: tab.tabId, tabLabel: tab.tabLabel, rootPaneId: tab.rootPaneId })),
		// Keep the first-tab fields useful for callers that displayed version-1 details.
		tabId: state.tabs[0]?.tabId,
		tabLabel: state.tabs[0]?.tabLabel,
		cwd: state.cwd,
		checkoutRoot: state.checkoutRoot,
		model: state.model,
		modelSource: state.modelSource,
		agents: state.agents.map((agent) => ({
			paneId: agent.paneId,
			tabId: agent.tabId,
			tabLabel: agent.tabLabel,
			label: agent.label,
			scope: agent.scope,
			writableRoots: agent.writableRoots,
			status: agent.lastAgentStatus,
		})),
		failure: state.failure,
	};
}

function formatAgentList(state: SquadState): string {
	return state.agents
		.map((agent) => {
			const ownership = agent.writableRoots ? `; writable: ${agent.writableRoots.join(", ")}` : "";
			return `- ${agent.label}: ${agent.scope} (tab ${agent.tabLabel}; pane ${agent.paneId || "not created"}${ownership})`;
		})
		.join("\n");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Herdr squad wait cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Herdr squad wait cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function formatList(items: string[], empty = "None reported"): string {
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

function formatReport(report: Awaited<ReturnType<typeof readSquadReport>>, sourcePath: string, kind: SquadKind, roots?: string[]): string {
	if (!report) return "";
	const workerSections =
		kind === "worker"
			? `\n## Writable roots\n${formatList(roots ?? [], "None")}` +
				`\n## Changed files\n${
					report.changedFiles && report.changedFiles.length > 0
						? report.changedFiles.map((item) => `- ${item.path}: ${item.summary}`).join("\n")
						: "- No files changed"
				}` +
				`\n## Validation\n${
					report.validation && report.validation.length > 0
						? report.validation.map((item) => `- \`${item.command}\`: ${item.result}`).join("\n")
						: "- No validation reported"
				}`
			: "";
	return `# Squad Report: ${report.label}\n## Scope\n${report.scope}\n## Recommended next step\n${report.recommendedNextStep}\n## ${kind === "worker" ? "Completion summary" : "Findings"}\n${report.findings}\n## Evidence\n${formatList(report.evidence)}${workerSections}\n## Risks / Unknowns / Handoffs\n${formatList(report.risksOrUnknowns)}\n\nStructured report: ${sourcePath}`;
}

export default function (pi: ExtensionAPI) {
	if (registerChildReportTool(pi)) return;

	const squads = new Map<string, SquadState>();

	function saveState(state: SquadState): void {
		state.updatedAt = new Date().toISOString();
		squads.set(state.squadId, state);
		pi.appendEntry(SQUAD_ENTRY_TYPE, { state: structuredClone(state) });
	}

	function getSquad(squadId: string): SquadState {
		const state = squads.get(squadId);
		if (!state) throw new Error(`Unknown Herdr squad ID: ${squadId}`);
		return state;
	}

	async function runHerdr(args: string[], signal?: AbortSignal, timeout = 15_000) {
		const result = await pi.exec("herdr", args, { signal, timeout });
		if (result.code !== 0) {
			throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
		}
		return result;
	}

	async function herdr(args: string[], signal?: AbortSignal, timeout = 15_000): Promise<JsonObject> {
		const result = await runHerdr(args, signal, timeout);
		try {
			return JSON.parse(result.stdout) as JsonObject;
		} catch {
			throw new Error(`herdr ${args.slice(0, 2).join(" ")} returned invalid JSON`);
		}
	}

	async function refreshLivePanes(
		state: SquadState,
		signal?: AbortSignal,
	): Promise<{ allTabsFound: boolean; missingTabs: string[]; missing: string[] }> {
		let listedTabs: JsonObject[] = [];
		try {
			const response = await herdr(["tab", "list", "--workspace", state.workspaceId], signal);
			listedTabs = response.result?.tabs ?? [];
		} catch {
			if (signal?.aborted) throw new Error("Herdr squad operation cancelled");
			return { allTabsFound: false, missingTabs: state.tabs.map((tab) => tab.tabLabel), missing: state.agents.map((agent) => agent.label) };
		}

		const foundTabs = new Map<string, SquadTabState>();
		const missingTabs: string[] = [];
		for (const expected of state.tabs) {
			const matches = listedTabs.filter((candidate) => candidate.label === expected.tabLabel && candidate.tab_id);
			if (matches.length !== 1) {
				missingTabs.push(expected.tabLabel);
				continue;
			}
			expected.tabId = String(matches[0].tab_id);
			foundTabs.set(expected.tabLabel, expected);
		}
		for (const plannedLabel of new Set(state.agents.map((agent) => agent.tabLabel))) {
			if (!foundTabs.has(plannedLabel) && !missingTabs.includes(plannedLabel)) missingTabs.push(plannedLabel);
		}

		let panes: JsonObject[] = [];
		try {
			const response = await herdr(["pane", "list", "--workspace", state.workspaceId], signal);
			panes = response.result?.panes ?? [];
		} catch {
			if (signal?.aborted) throw new Error("Herdr squad operation cancelled");
			return { allTabsFound: missingTabs.length === 0, missingTabs, missing: state.agents.map((agent) => agent.label) };
		}

		const panesByTabAndLabel = new Map<string, JsonObject>();
		for (const pane of panes) {
			if (pane.tab_id && pane.label) panesByTabAndLabel.set(`${String(pane.tab_id)}\u0000${String(pane.label)}`, pane);
		}
		const missing: string[] = [];
		for (const agent of state.agents) {
			const tab = foundTabs.get(agent.tabLabel);
			if (!tab) {
				missing.push(agent.label);
				continue;
			}
			agent.tabId = tab.tabId;
			const pane =
				panesByTabAndLabel.get(`${tab.tabId}\u0000${agent.paneLabel}`) ??
				panes.find((candidate) => String(candidate.tab_id) === tab.tabId && candidate.pane_id === agent.paneId && candidate.label === undefined);
			if (!pane?.pane_id) {
				missing.push(agent.label);
				continue;
			}
			agent.paneId = String(pane.pane_id);
			agent.lastAgentStatus = typeof pane.agent_status === "string" ? pane.agent_status : "unknown";
		}
		return { allTabsFound: missingTabs.length === 0, missingTabs, missing };
	}

	pi.on("session_start", (_event, ctx) => {
		const snapshots = ctx.sessionManager
			.getBranch()
			.filter((entry: any) => entry.type === "custom" && entry.customType === SQUAD_ENTRY_TYPE && entry.data?.state)
			.map((entry: any) => migrateSquadState(entry.data.state))
			.filter((state): state is SquadState => state !== undefined)
			.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
		for (const state of snapshots) squads.set(state.squadId, state);
	});

	async function launchSquad(kind: SquadKind, params: StartInput, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
		if (process.env.HERDR_ENV !== "1") throw new Error("Herdr squads are available only inside a Herdr-managed Pi pane");
		if (!Number.isInteger(params.count) || params.count < 1 || params.count > MAX_AGENTS) {
			throw new Error(`count must be an integer from 1 through ${MAX_AGENTS}`);
		}
		if (params.assignments.length !== params.count) throw new Error(`Expected exactly ${params.count} assignments`);

		const task = cleanBody(params.task, MAX_TASK_LENGTH);
		if (!task) throw new Error("task must not be empty");
		let normalizedAssignments: LaunchAssignment[] = params.assignments.map((assignment) => ({
			label: normalizeDisplayText(assignment.label, 30),
			scope: cleanBody(assignment.scope, MAX_SCOPE_LENGTH),
			prompt: cleanBody(assignment.prompt, MAX_PROMPT_LENGTH),
			...(kind === "worker" ? { writableRoots: assignment.writableRoots ?? [] } : {}),
		}));
		if (normalizedAssignments.some((assignment) => !assignment.label || !assignment.scope || !assignment.prompt)) {
			throw new Error("Every assignment requires a non-empty label, scope, and prompt");
		}
		const labels = normalizedAssignments.map((assignment) => assignment.label.toLocaleLowerCase());
		if (new Set(labels).size !== labels.length) throw new Error("Assignment labels must be unique");
		const scopes = normalizedAssignments.map((assignment) => normalizeDisplayText(assignment.scope, MAX_SCOPE_LENGTH).toLocaleLowerCase());
		if (new Set(scopes).size !== scopes.length) throw new Error("Assignment scopes must not be exact duplicates");

		const checkoutRoot = await realpath(ctx.cwd);
		if (kind === "worker") {
			const ownership = await validateExclusiveWritableRoots(
				checkoutRoot,
				normalizedAssignments.map((assignment) => ({ label: assignment.label, writableRoots: assignment.writableRoots ?? [] })),
			);
			normalizedAssignments = normalizedAssignments.map((assignment, index) => ({
				...assignment,
				writableRoots: ownership[index].writableRoots,
				canonicalWritableRoots: ownership[index].canonicalWritableRoots,
			}));
		}

		const parentPaneId = process.env.HERDR_PANE_ID;
		if (!parentPaneId) throw new Error("HERDR_PANE_ID is unavailable; cannot identify the parent pane safely");
		const parentResponse = await herdr(["pane", "get", parentPaneId], signal);
		const parentPane = parentResponse.result?.pane;
		if (!parentPane?.workspace_id || String(parentPane.pane_id) !== parentPaneId) throw new Error("Could not validate the parent Herdr pane");
		const workspaceId = String(parentPane.workspace_id);
		let model: string | undefined;
		let modelSource: SquadState["modelSource"];
		if (params.model) {
			model = validateExplicitModel(params.model);
			modelSource = "explicit";
		} else {
			const configuredModel = await resolveConfiguredModel(checkoutRoot, ctx.isProjectTrusted());
			model = configuredModel.model;
			modelSource = configuredModel.source;
		}

		const squadId = randomUUID();
		const shortId = squadId.replaceAll("-", "").slice(0, 6);
		const defaultTitle = kind === "worker" ? `Workers ${shortId}` : `Investigation ${shortId}`;
		const title = normalizeDisplayText(params.title || defaultTitle, 38) || defaultTitle;
		const tabCount = Math.ceil(params.count / MAX_AGENTS_PER_TAB);
		const tabLabels = Array.from({ length: tabCount }, (_, index) =>
			tabCount === 1 ? `${title} · sq-${shortId}` : `${title} ${index + 1}/${tabCount} · sq-${shortId}`,
		);
		const runDir = await mkdtemp(join(tmpdir(), RUN_DIR_PREFIX));
		const manifestAgents: SquadManifest["agents"] = normalizedAssignments.map((assignment, index) => ({
			agentId: `${shortId}-${index + 1}`,
			token: randomBytes(24).toString("hex"),
			label: assignment.label,
			scope: assignment.scope,
			...(kind === "worker"
				? { writableRoots: assignment.writableRoots, canonicalWritableRoots: assignment.canonicalWritableRoots }
				: {}),
		}));
		const manifest: SquadManifest = { version: 2, squadId, kind, checkoutRoot, agents: manifestAgents };
		await writeFile(join(runDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

		const agents: SquadAgentState[] = [];
		for (let index = 0; index < normalizedAssignments.length; index++) {
			const assignment = normalizedAssignments[index];
			const identity = manifestAgents[index];
			const promptPath = join(runDir, `prompt-${identity.agentId}.md`);
			const prompt =
				kind === "worker"
					? buildWorkerPrompt(task, assignment.label, assignment.scope, assignment.writableRoots ?? [], assignment.prompt)
					: buildInvestigationPrompt(task, assignment.label, assignment.scope, assignment.prompt);
			await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
			agents.push({
				agentId: identity.agentId,
				label: assignment.label,
				paneLabel: `${normalizeDisplayText(assignment.label, 25)} · ${shortId}-${index + 1}`,
				scope: assignment.scope,
				paneId: "",
				tabId: "",
				tabLabel: tabLabels[Math.floor(index / MAX_AGENTS_PER_TAB)],
				reportPath: join(runDir, reportFileName(identity.agentId)),
				promptPath,
				...(kind === "worker" ? { writableRoots: assignment.writableRoots } : {}),
			});
		}

		const now = new Date().toISOString();
		const state: SquadState = {
			version: STATE_VERSION,
			kind,
			squadId,
			createdAt: now,
			updatedAt: now,
			cwd: checkoutRoot,
			checkoutRoot,
			workspaceId,
			tabs: [],
			runDir,
			task,
			title,
			model,
			modelSource,
			status: "launching",
			agents,
		};

		try {
			onUpdate?.({ content: [{ type: "text", text: `Creating ${tabCount} Herdr squad tab(s) for ${params.count} agent(s)...` }] });
			for (let tabIndex = 0; tabIndex < tabCount; tabIndex++) {
				const tabResponse = await herdr(
					["tab", "create", "--workspace", workspaceId, "--cwd", checkoutRoot, "--label", tabLabels[tabIndex], "--no-focus"],
					signal,
				);
				const tab = tabResponse.result?.tab;
				const rootPane = tabResponse.result?.root_pane;
				if (!tab?.tab_id || !rootPane?.pane_id) throw new Error("Herdr tab creation response did not include tab and root pane IDs");
				const tabState: SquadTabState = {
					tabId: String(tab.tab_id),
					tabLabel: tabLabels[tabIndex],
					rootPaneId: String(rootPane.pane_id),
				};
				state.tabs.push(tabState);
				const chunk = agents.slice(tabIndex * MAX_AGENTS_PER_TAB, (tabIndex + 1) * MAX_AGENTS_PER_TAB);
				chunk[0].paneId = tabState.rootPaneId;
				chunk[0].tabId = tabState.tabId;
				if (chunk.length >= 2) {
					const split = await herdr(["pane", "split", tabState.rootPaneId, "--direction", "right", "--cwd", checkoutRoot, "--no-focus"], signal);
					chunk[1].paneId = String(split.result?.pane?.pane_id || "");
					if (!chunk[1].paneId) throw new Error("Right split did not return a pane ID");
					chunk[1].tabId = tabState.tabId;
				}
				if (chunk.length >= 3) {
					const split = await herdr(["pane", "split", tabState.rootPaneId, "--direction", "down", "--cwd", checkoutRoot, "--no-focus"], signal);
					chunk[2].paneId = String(split.result?.pane?.pane_id || "");
					if (!chunk[2].paneId) throw new Error("Lower-left split did not return a pane ID");
					chunk[2].tabId = tabState.tabId;
				}
				if (chunk.length >= 4) {
					const split = await herdr(["pane", "split", chunk[1].paneId, "--direction", "down", "--cwd", checkoutRoot, "--no-focus"], signal);
					chunk[3].paneId = String(split.result?.pane?.pane_id || "");
					if (!chunk[3].paneId) throw new Error("Lower-right split did not return a pane ID");
					chunk[3].tabId = tabState.tabId;
				}
				for (const agent of chunk) await runHerdr(["pane", "rename", agent.paneId, agent.paneLabel], signal);
			}

			for (let index = 0; index < agents.length; index++) {
				const agent = agents[index];
				const identity = manifestAgents[index];
				const commandArguments = [
					"env",
					`HERDR_SQUAD_DIR=${runDir}`,
					`HERDR_SQUAD_ID=${squadId}`,
					`HERDR_SQUAD_AGENT_ID=${agent.agentId}`,
					`HERDR_SQUAD_TOKEN=${identity.token}`,
					`HERDR_SQUAD_KIND=${kind}`,
					"pi",
					"--name",
					`Squad ${agent.label}`,
				];
				if (state.model) commandArguments.push("--model", state.model);
				commandArguments.push(
					"--tools",
					kind === "worker"
						? "read,bash,edit,write,grep,find,ls,herdr_squad_report"
						: "read,grep,find,ls,herdr_squad_report",
					"--no-skills",
					"--no-prompt-templates",
					`@${agent.promptPath}`,
				);
				await runHerdr(["pane", "run", agent.paneId, commandArguments.map(shellQuote).join(" ")], signal);
			}

			state.status = "running";
			if (params.focus === true && state.tabs[0]) await runHerdr(["tab", "focus", state.tabs[0].tabId], signal);
			saveState(state);
			return {
				content: [
					{
						type: "text",
						text: `Started ${kind === "worker" ? "worker" : "read-only investigation"} Herdr squad ${squadId}.\nTabs: ${state.tabs.map((tab) => tab.tabLabel).join(", ")}\nModel: ${state.model ?? "Pi default"} (${state.modelSource})\n${formatAgentList(state)}\n\nCall herdr_squad_wait with this squadId in the next tool round.`,
					},
				],
				details: publicSquadDetails(state),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (state.tabs.length === 0) {
				await rm(runDir, { recursive: true, force: true });
				throw error;
			}
			state.status = "partial";
			state.failure = message;
			saveState(state);
			return {
				content: [
					{
						type: "text",
						text: `Herdr squad ${state.squadId} launch was partial: ${message}\nCreated tabs: ${state.tabs.map((tab) => tab.tabLabel).join(", ")}\n${formatAgentList(state)}\nThe created tabs were left open for inspection. Use this squadId to wait for or collect any agents that did launch.`,
					},
				],
				details: publicSquadDetails(state),
			};
		}
	}

	pi.registerTool({
		name: "herdr_squad_start",
		label: "Start Herdr Investigation Squad",
		description:
			"Create and launch 1-12 visible, strictly read-only Pi investigation agents across up to three Herdr tabs. An explicit model overrides project/global config. Returns an opaque squadId. Call this tool alone; wait for its result before calling herdr_squad_wait.",
		promptSnippet: "Launch a visible read-only Herdr investigation squad",
		promptGuidelines: [
			"Call herdr_squad_start only after defining distinct non-overlapping scopes, and call it in a separate tool round before herdr_squad_wait.",
			"Always include task with the full parent request, plus count and exactly count assignments.",
		],
		parameters: StartParams,
		execute(_toolCallId, params, signal, onUpdate, ctx) {
			return launchSquad("investigation", params as StartInput, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "herdr_worker_squad_start",
		label: "Start Herdr Worker Squad",
		description:
			"Create and launch 1-12 visible coding workers in one shared checkout, across up to three Herdr tabs. Each worker requires exclusive repository-relative writable roots. Returns an opaque squadId. Call this tool alone; wait for its result before herdr_squad_wait.",
		promptSnippet: "Launch a visible shared-checkout Herdr worker squad",
		promptGuidelines: [
			"Inspect the repository before calling herdr_worker_squad_start, then assign exclusive non-overlapping writableRoots and use the smallest useful worker count.",
			"Call herdr_worker_squad_start alone, and do not modify worker-owned files before wait and collect complete.",
		],
		parameters: WorkerStartParams,
		execute(_toolCallId, params, signal, onUpdate, ctx) {
			return launchSquad("worker", params as StartInput, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "herdr_squad_wait",
		label: "Wait for Herdr Squad",
		description:
			"Wait for every child in a previously started investigation or worker squad to submit its structured report. Uses one overall timeout and reports blockers. Call alone after a squad start tool has returned.",
		promptSnippet: "Wait for a Herdr squad's structured reports",
		promptGuidelines: [
			"Call herdr_squad_wait only after a Herdr squad start tool has returned a squadId, and wait for its result before calling herdr_squad_collect.",
		],
		parameters: SquadIdParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const state = getSquad(params.squadId);
			const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
			const deadline = Date.now() + timeoutMs;
			const blockedSince = new Map<string, number>();

			while (true) {
				if (signal?.aborted) throw new Error("Herdr squad wait cancelled");
				const reports = await Promise.all(state.agents.map((agent) => readSquadReport(agent.reportPath)));
				const completeCount = reports.filter(Boolean).length;
				if (completeCount === state.agents.length) {
					state.status = "completed";
					delete state.failure;
					saveState(state);
					return {
						content: [{ type: "text", text: `All ${completeCount} Herdr squad reports are ready. Call herdr_squad_collect with squadId ${state.squadId} in the next tool round.` }],
						details: { ...publicSquadDetails(state), completeCount, timedOut: false },
					};
				}

				const live = await refreshLivePanes(state, signal);
				if (!live.allTabsFound || live.missing.length > 0) {
					state.status = "partial";
					const problems: string[] = [];
					if (live.missingTabs.length > 0) problems.push(`Missing tabs: ${live.missingTabs.join(", ")}`);
					if (live.missing.length > 0) problems.push(`Missing panes: ${live.missing.join(", ")}`);
					state.failure = problems.join("; ") || "Squad tabs are no longer available";
					saveState(state);
					return {
						content: [{ type: "text", text: `${completeCount}/${state.agents.length} reports are ready. ${state.failure}. Collect the available reports now.` }],
						details: { ...publicSquadDetails(state), completeCount, timedOut: false },
					};
				}

				const now = Date.now();
				for (let index = 0; index < state.agents.length; index++) {
					if (reports[index]) continue;
					const agent = state.agents[index];
					if (agent.lastAgentStatus === "done") {
						state.status = "partial";
						state.failure = `${agent.label} (pane ${agent.paneId}, tab ${agent.tabLabel}) terminated with Herdr status done without submitting a report`;
						saveState(state);
						return {
							content: [{ type: "text", text: `${completeCount}/${state.agents.length} reports are ready. ${state.failure}. Collect available reports and terminal output now.` }],
							details: { ...publicSquadDetails(state), completeCount, terminated: agent.label, terminalStatus: "done", timedOut: false },
						};
					}
					if (agent.lastAgentStatus === "blocked") {
						const since = blockedSince.get(agent.agentId) ?? now;
						blockedSince.set(agent.agentId, since);
						if (now - since >= BLOCKED_GRACE_MS) {
							state.status = "partial";
							state.failure = `${agent.label} is blocked in ${agent.tabLabel}`;
							saveState(state);
							return {
								content: [{ type: "text", text: `${completeCount}/${state.agents.length} reports are ready. ${state.failure}; collect available output and report the blocker.` }],
								details: { ...publicSquadDetails(state), completeCount, blocked: agent.label, timedOut: false },
							};
						}
					} else {
						blockedSince.delete(agent.agentId);
					}
				}

				onUpdate?.({
					content: [{ type: "text", text: `Herdr squad: ${completeCount}/${state.agents.length} reports ready...` }],
					details: { squadId: state.squadId, completeCount },
				});
				if (Date.now() >= deadline) {
					state.status = "partial";
					state.failure = `Timed out after ${timeoutMs}ms`;
					saveState(state);
					return {
						content: [{ type: "text", text: `${completeCount}/${state.agents.length} reports were ready before the overall timeout. Collect available reports and terminal fallbacks now.` }],
						details: { ...publicSquadDetails(state), completeCount, timedOut: true },
					};
				}
				await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), signal);
			}
		},
	});

	pi.registerTool({
		name: "herdr_squad_collect",
		label: "Collect Herdr Squad",
		description:
			`Collect structured reports from an investigation or worker squad, with bounded terminal-tail fallbacks. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; complete output is saved when truncated. Call only after herdr_squad_wait returns.`,
		promptSnippet: "Collect a Herdr squad's reports and fallback terminal output",
		promptGuidelines: ["Call herdr_squad_collect only after the corresponding herdr_squad_wait call has returned."],
		parameters: CollectParams,
		async execute(_toolCallId, params, signal) {
			const state = getSquad(params.squadId);
			const lines = params.lines ?? 240;
			const live = await refreshLivePanes(state, signal);
			const missingPanes = new Set(live.missing);
			const missingTabs = new Set(live.missingTabs);
			const perAgentBytes = Math.max(8_000, Math.floor((DEFAULT_MAX_BYTES - 4_000) / state.agents.length));
			const sections: string[] = [];
			let structuredCount = 0;

			for (const agent of state.agents) {
				const report = await readSquadReport(agent.reportPath);
				let section: string;
				if (report && report.squadId === state.squadId && report.agentId === agent.agentId) {
					structuredCount++;
					section = formatReport(report, agent.reportPath, state.kind, agent.writableRoots);
				} else {
					let transcript = missingTabs.has(agent.tabLabel)
						? `Terminal output unavailable because tab ${agent.tabLabel} could not be revalidated.`
						: missingPanes.has(agent.label)
							? "Terminal output unavailable because this pane could not be revalidated."
							: "Terminal output unavailable.";
					if (!missingTabs.has(agent.tabLabel) && !missingPanes.has(agent.label) && agent.paneId) {
						try {
							const result = await pi.exec(
								"herdr",
								["pane", "read", agent.paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
								{ signal, timeout: 15_000 },
							);
							if (result.code === 0 && result.stdout.trim()) transcript = result.stdout.trim();
							else if (result.stderr.trim()) transcript = `Terminal read failed: ${result.stderr.trim()}`;
						} catch (error) {
							transcript = `Terminal read failed: ${error instanceof Error ? error.message : String(error)}`;
						}
					}
					const transcriptPath = join(state.runDir, `terminal-${agent.agentId}.txt`);
					await writeFile(transcriptPath, `${transcript}\n`, { encoding: "utf8", mode: 0o600 });
					const ownership = state.kind === "worker" ? `\n## Writable roots\n${formatList(agent.writableRoots ?? [], "None")}` : "";
					section = `# Squad Report Missing: ${agent.label}\n## Scope\n${agent.scope}${ownership}\n## Tab\n${agent.tabLabel}\n## Status\nNo valid structured report was submitted. Last Herdr status: ${agent.lastAgentStatus ?? "unknown"}.\n## Terminal tail\n${transcript}\n\nTerminal snapshot: ${transcriptPath}`;
				}

				const limited = truncateHead(section, { maxBytes: perAgentBytes, maxLines: DEFAULT_MAX_LINES });
				sections.push(
					limited.truncated
						? `${limited.content}\n\n[Agent section truncated. Full source is available at ${report ? agent.reportPath : join(state.runDir, `terminal-${agent.agentId}.txt`)}]`
						: limited.content,
				);
			}

			const fullCollection = `## Herdr squad collection\n- Squad: ${state.squadId}\n- Kind: ${state.kind}\n- Tabs: ${state.tabs.map((tab) => tab.tabLabel).join(", ") || "None"}\n- Model: ${state.model ?? "Pi default"} (${state.modelSource})\n- Mode: ${state.kind === "worker" ? "shared-checkout coding workers" : "read-only investigation"}\n- Structured reports: ${structuredCount}/${state.agents.length}\n\n${sections.join("\n\n---\n\n")}`;
			const truncation = truncateHead(fullCollection, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let output = truncation.content;
			let fullOutputPath: string | undefined;
			if (truncation.truncated) {
				fullOutputPath = join(state.runDir, "collection.md");
				await withFileMutationQueue(fullOutputPath, () =>
					writeFile(fullOutputPath!, `${fullCollection}\n`, { encoding: "utf8", mode: 0o600 }),
				);
				output += `\n\n[Collection truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines and ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}. Full collection: ${fullOutputPath}]`;
			}

			state.status = "collected";
			if (structuredCount === state.agents.length) delete state.failure;
			state.collectedAt = new Date().toISOString();
			saveState(state);
			return {
				content: [{ type: "text", text: output }],
				details: { ...publicSquadDetails(state), structuredCount, fullOutputPath },
			};
		},
	});
}

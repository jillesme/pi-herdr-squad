import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
	convertToLlm,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	serializeConversation,
	truncateHead,
	truncateTail,
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
	STEER_DELIVERED_SUFFIX,
	steerFilePrefix,
	type SquadSteerMessage,
	type SquadAgentState,
	type SquadKind,
	type SquadManifest,
	type SquadState,
	type SquadTabState,
	WEB_TOOL_NAMES,
} from "./shared.ts";

const MAX_TASK_LENGTH = 50_000;
const MAX_SCOPE_LENGTH = 8_000;
const MAX_PROMPT_LENGTH = 16_000;
const DEFAULT_WAIT_MS = 5 * 60_000;
const MAX_WAIT_MS = 30 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const WATCH_INTERVAL_MS = 5_000;
const BLOCKED_GRACE_MS = 3_000;
// Children that reached idle/done without a report are treated as finished after this grace.
const FINISHED_GRACE_MS = 4_000;
// Before a child has been seen working, idle may just mean Pi is still starting up.
const STARTUP_IDLE_GRACE_MS = 90_000;
const NOTIFY_MESSAGE_TYPE = "herdr-squad-update";
// Tail of the parent conversation inlined into each child prompt when inheritContext is set.
const MAX_PARENT_CONTEXT_BYTES = 40_000;
const MAX_STEER_LENGTH = 8_000;
const STEER_ACK_WAIT_MS = 5_000;

const AssignmentSchema = Type.Object({
	label: Type.String({ description: "Short unique agent label", minLength: 1, maxLength: 80 }),
	scope: Type.String({ description: "Exclusive, non-overlapping investigation scope", minLength: 1, maxLength: MAX_SCOPE_LENGTH }),
	prompt: Type.String({ description: "Specific read-only investigation instructions", minLength: 1, maxLength: MAX_PROMPT_LENGTH }),
	model: Type.Optional(
		Type.String({
			description: "Optional model for this agent only, overriding the squad model (for example a cheaper model for a simple scope)",
			minLength: 1,
			maxLength: 200,
		}),
	),
});

const WorkerAssignmentSchema = Type.Object({
	label: Type.String({ description: "Short unique worker label", minLength: 1, maxLength: 80 }),
	scope: Type.String({ description: "Exclusive functional scope", minLength: 1, maxLength: MAX_SCOPE_LENGTH }),
	writableRoots: Type.Array(Type.String({ description: "Exclusive repository-relative file or directory root", minLength: 1, maxLength: 1000 }), {
		minItems: 1,
		maxItems: 100,
	}),
	prompt: Type.String({ description: "Specific implementation instructions", minLength: 1, maxLength: MAX_PROMPT_LENGTH }),
	model: Type.Optional(
		Type.String({
			description: "Optional model for this agent only, overriding the squad model (for example a cheaper model for a simple scope)",
			minLength: 1,
			maxLength: 200,
		}),
	),
});

function startSchema(assignmentSchema: typeof AssignmentSchema | typeof WorkerAssignmentSchema) {
	return Type.Object({
		task: Type.String({ description: "Full parent task", minLength: 1, maxLength: MAX_TASK_LENGTH }),
		count: Type.Integer({ description: "Exact number of visible agents", minimum: 1, maximum: MAX_AGENTS }),
		assignments: Type.Array(assignmentSchema, { minItems: 1, maxItems: MAX_AGENTS }),
		title: Type.Optional(Type.String({ description: "Short tab title", maxLength: 80 })),
		model: Type.Optional(
			Type.String({
				description: "Optional model for every child, for example provider/model or model:thinking; an assignment model overrides it",
				minLength: 1,
				maxLength: 200,
			}),
		),
		focus: Type.Optional(Type.Boolean({ description: "Focus the first squad tab after launch; defaults to false" })),
		webTools: Type.Optional(
			Type.Boolean({
				description: `Give children the parent's web tools (${WEB_TOOL_NAMES.join(", ")}) when available; defaults to true`,
			}),
		),
		inheritContext: Type.Optional(
			Type.Boolean({
				description:
					"Include the recent parent conversation (serialized, most recent ~40KB) in every child prompt as background, so prompts need not restate discussed context; defaults to false",
			}),
		),
	});
}

const StartParams = startSchema(AssignmentSchema);
const WorkerStartParams = startSchema(WorkerAssignmentSchema);

const SquadIdParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by a Herdr squad start tool", minLength: 8, maxLength: 80 }),
	timeoutMs: Type.Optional(Type.Integer({ description: "Overall wait timeout in milliseconds", minimum: 1_000, maximum: MAX_WAIT_MS })),
});

const StatusParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by a Herdr squad start tool", minLength: 8, maxLength: 80 }),
});

const SteerParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by a Herdr squad start tool", minLength: 8, maxLength: 80 }),
	agent: Type.String({ description: "Assignment label (or agent ID) of the child to message", minLength: 1, maxLength: 80 }),
	message: Type.String({ description: "Message for the child: a correction, extra context, or a follow-up request", minLength: 1, maxLength: MAX_STEER_LENGTH }),
});

const CloseParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by a Herdr squad start tool", minLength: 8, maxLength: 80 }),
	force: Type.Optional(Type.Boolean({ description: "Close tabs even when agents are still running; defaults to false" })),
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
	model?: string;
}

interface StartInput {
	task: string;
	count: number;
	assignments: Array<{ label: string; scope: string; prompt: string; writableRoots?: string[]; model?: string }>;
	title?: string;
	model?: string;
	focus?: boolean;
	webTools?: boolean;
	inheritContext?: boolean;
}

type SquadCheck =
	| { kind: "complete"; completeCount: number }
	| { kind: "pending"; completeCount: number; running: string[] }
	| { kind: "problem"; completeCount: number; message: string; details: JsonObject };

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
		webTools: state.webTools ?? [],
		inheritedContext: state.inheritedContext ?? false,
		agents: state.agents.map((agent) => ({
			paneId: agent.paneId,
			tabId: agent.tabId,
			tabLabel: agent.tabLabel,
			label: agent.label,
			scope: agent.scope,
			writableRoots: agent.writableRoots,
			model: agent.model ?? state.model,
			status: agent.lastAgentStatus,
		})),
		failure: state.failure,
	};
}

function formatAgentList(state: SquadState): string {
	return state.agents
		.map((agent) => {
			const ownership = agent.writableRoots ? `; writable: ${agent.writableRoots.join(", ")}` : "";
			const model = agent.model ? `; model: ${agent.model}` : "";
			return `- ${agent.label}: ${agent.scope} (tab ${agent.tabLabel}; pane ${agent.paneId || "not created"}${model}${ownership})`;
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
	return `# Squad Report: ${report.label}\n## Scope\n${report.scope}\n## Recommended next step\n${report.recommendedNextStep || "None reported"}\n## ${kind === "worker" ? "Completion summary" : "Findings"}\n${report.findings}\n## Evidence\n${formatList(report.evidence)}${workerSections}\n## Risks / Unknowns / Handoffs\n${formatList(report.risksOrUnknowns)}\n\nStructured report: ${sourcePath}`;
}

export default function (pi: ExtensionAPI) {
	if (registerChildReportTool(pi)) return;

	const squads = new Map<string, SquadState>();

	async function readAgentReport(state: SquadState, agent: SquadAgentState) {
		const report = await readSquadReport(agent.reportPath);
		if (!report || report.squadId !== state.squadId || report.agentId !== agent.agentId) return undefined;
		if (agent.pendingSteerId && report.steerId !== agent.pendingSteerId) return undefined;
		return report;
	}

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
		// A failed CLI request is not evidence that the tabs disappeared; let the watcher retry.
		const tabResponse = await herdr(["tab", "list", "--workspace", state.workspaceId], signal);
		const listedTabs: JsonObject[] = tabResponse.result?.tabs ?? [];

		const foundTabs = new Map<string, SquadTabState>();
		const missingTabs: string[] = [];
		for (const expected of state.tabs) {
			// Prefer the stable tab ID so a renamed squad tab is still found; fall back to the unique label.
			const byId = listedTabs.find((candidate) => String(candidate.tab_id) === expected.tabId);
			const matches = byId ? [byId] : listedTabs.filter((candidate) => candidate.label === expected.tabLabel && candidate.tab_id);
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

		const paneResponse = await herdr(["pane", "list", "--workspace", state.workspaceId], signal);
		const panes: JsonObject[] = paneResponse.result?.panes ?? [];

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

	// Per-agent Herdr status history, used to tell startup idle apart from a finished child.
	const statusSince = new Map<string, { status: string; since: number }>();
	const seenWorking = new Set<string>();

	function mayBeRunning(state: SquadState, agent: SquadAgentState): boolean {
		const status = agent.lastAgentStatus ?? "unknown";
		if (status !== "idle" && status !== "done") return true;
		const key = `${state.squadId}:${agent.agentId}`;
		const previous = statusSince.get(key);
		if (previous?.status !== status) {
			statusSince.set(key, { status, since: Date.now() });
			return true;
		}
		return Date.now() - previous.since < (seenWorking.has(key) ? FINISHED_GRACE_MS : STARTUP_IDLE_GRACE_MS);
	}

	async function checkSquad(state: SquadState, signal?: AbortSignal): Promise<SquadCheck> {
		const reports = await Promise.all(state.agents.map((agent) => readAgentReport(state, agent)));
		const completeCount = reports.filter(Boolean).length;
		if (completeCount === state.agents.length) return { kind: "complete", completeCount };

		const live = await refreshLivePanes(state, signal);
		// A reported child's pane may already have been closed; only missing
		// children whose results are still outstanding prevent completion.
		const missingAgents = state.agents.filter((agent, index) => !reports[index] && live.missing.includes(agent.label));
		if (missingAgents.length > 0) {
			const problems = [`Missing panes: ${missingAgents.map((agent) => agent.label).join(", ")}`];
			return { kind: "problem", completeCount, message: problems.join("; ") || "Squad tabs are no longer available", details: {} };
		}

		const now = Date.now();
		const running: string[] = [];
		for (let index = 0; index < state.agents.length; index++) {
			if (reports[index]) continue;
			const agent = state.agents[index];
			const key = `${state.squadId}:${agent.agentId}`;
			const status = agent.lastAgentStatus ?? "unknown";
			const previous = statusSince.get(key);
			const since = previous?.status === status ? previous.since : now;
			statusSince.set(key, { status, since });
			if (status === "working") seenWorking.add(key);

			if (status === "blocked" && now - since >= BLOCKED_GRACE_MS) {
				return { kind: "problem", completeCount, message: `${agent.label} is blocked in ${agent.tabLabel}`, details: { blocked: agent.label } };
			}
			const finished = status === "done" || status === "idle";
			if (finished && now - since >= (seenWorking.has(key) ? FINISHED_GRACE_MS : STARTUP_IDLE_GRACE_MS)) {
				return {
					kind: "problem",
					completeCount,
					message: `${agent.label} (pane ${agent.paneId}, tab ${agent.tabLabel}) finished with Herdr status ${status} without submitting a report`,
					details: { terminated: agent.label, terminalStatus: status },
				};
			}
			running.push(agent.label);
		}
		return { kind: "pending", completeCount, running };
	}

	// Squads with an active herdr_squad_wait call; the background watcher skips them.
	const waiting = new Set<string>();
	const watchers = new Map<string, ReturnType<typeof setInterval>>();

	function stopWatching(squadId: string): void {
		const timer = watchers.get(squadId);
		if (timer) clearInterval(timer);
		watchers.delete(squadId);
	}

	// Notify the parent with a follow-up message when a running squad finishes or needs attention,
	// so it can keep working instead of polling herdr_squad_wait.
	function watchSquad(squadId: string): void {
		if (watchers.has(squadId)) return;
		let busy = false;
		let lastProblem: string | undefined;
		const timer = setInterval(async () => {
			const state = squads.get(squadId);
			if (!state || (state.status !== "running" && state.status !== "partial")) {
				stopWatching(squadId);
				return;
			}
			if (busy || waiting.has(squadId)) return;
			busy = true;
			try {
				const revision = state.updatedAt;
				const check = await checkSquad(state);
				// Shutdown, steering or another tool may have changed state while I/O was in flight.
				if (watchers.get(squadId) !== timer || state.updatedAt !== revision || waiting.has(squadId)) return;
				if (check.kind === "pending") {
					lastProblem = undefined;
					return;
				}
				if (check.kind === "problem" && lastProblem === check.message) return;
				let text: string;
				if (check.kind === "complete") {
					stopWatching(squadId);
					state.status = "completed";
					delete state.failure;
					text = `Herdr squad "${state.title}" finished: all ${check.completeCount} reports are ready. Call herdr_squad_collect with squadId ${state.squadId}.`;
				} else {
					lastProblem = check.message;
					state.status = "partial";
					state.failure = check.message;
					text = `Herdr squad "${state.title}" needs attention: ${check.completeCount}/${state.agents.length} reports are ready. ${check.message}. Call herdr_squad_collect with squadId ${state.squadId} to see reports and terminal output.`;
				}
				saveState(state);
				pi.sendMessage(
					{ customType: NOTIFY_MESSAGE_TYPE, content: text, display: true, details: { squadId: state.squadId, status: state.status } },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch {
				// Transient Herdr errors are retried on the next tick.
			} finally {
				busy = false;
			}
		}, WATCH_INTERVAL_MS);
		timer.unref?.();
		watchers.set(squadId, timer);
	}

	pi.on("session_start", (_event, ctx) => {
		const snapshots = ctx.sessionManager
			.getBranch()
			.filter((entry: any) => entry.type === "custom" && entry.customType === SQUAD_ENTRY_TYPE && entry.data?.state)
			.map((entry: any) => migrateSquadState(entry.data.state))
			.filter((state): state is SquadState => state !== undefined)
			.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
		for (const state of snapshots) squads.set(state.squadId, state);
		for (const state of squads.values()) if (state.status === "running" || state.status === "partial") watchSquad(state.squadId);
	});

	pi.on("session_shutdown", () => {
		for (const squadId of [...watchers.keys()]) stopWatching(squadId);
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
			...(assignment.model ? { model: validateExplicitModel(assignment.model, `assignments[${assignment.label}].model`) } : {}),
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
			model = validateExplicitModel(params.model, kind === "worker" ? "herdr_worker_squad_start.model" : "herdr_squad_start.model");
			modelSource = "explicit";
		} else {
			const configuredModel = await resolveConfiguredModel(checkoutRoot, ctx.isProjectTrusted());
			model = configuredModel.model;
			modelSource = configuredModel.source;
		}
		// Children load the same packages as the parent, so pass through web tools the parent has.
		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const webTools = params.webTools === false ? [] : WEB_TOOL_NAMES.filter((name) => availableTools.has(name));
		let parentContext: string | undefined;
		if (params.inheritContext === true) {
			const { messages } = buildSessionContext(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
			const serialized = serializeConversation(convertToLlm(messages)).trim();
			if (serialized) {
				const limited = truncateTail(serialized, { maxBytes: MAX_PARENT_CONTEXT_BYTES, maxLines: Number.MAX_SAFE_INTEGER });
				parentContext = limited.truncated ? `[Earlier conversation omitted]\n${limited.content}` : limited.content;
			}
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
					? buildWorkerPrompt(task, assignment.label, assignment.scope, assignment.writableRoots ?? [], assignment.prompt, webTools, parentContext)
					: buildInvestigationPrompt(task, assignment.label, assignment.scope, assignment.prompt, webTools, parentContext);
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
				...(assignment.model && assignment.model !== model ? { model: assignment.model } : {}),
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
			webTools,
			inheritedContext: parentContext !== undefined,
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
				const agentModel = agent.model ?? state.model;
				if (agentModel) commandArguments.push("--model", agentModel);
				const tools = [
					...(kind === "worker" ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"]),
					...webTools,
					"herdr_squad_report",
				];
				// Skills stay enabled so children can follow domain skills (for example Remotion or Cloudflare docs).
				commandArguments.push("--tools", tools.join(","), "--no-prompt-templates", `@${agent.promptPath}`);
				await runHerdr(["pane", "run", agent.paneId, commandArguments.map(shellQuote).join(" ")], signal);
			}

			state.status = "running";
			if (params.focus === true && state.tabs[0]) await runHerdr(["tab", "focus", state.tabs[0].tabId], signal);
			saveState(state);
			watchSquad(state.squadId);
			return {
				content: [
					{
						type: "text" as const,
						text: `Started ${kind === "worker" ? "worker" : "read-only investigation"} Herdr squad ${squadId}.\nTabs: ${state.tabs.map((tab) => tab.tabLabel).join(", ")}\nModel: ${state.model ?? "Pi default"} (${state.modelSource})\nWeb tools: ${webTools.join(", ") || "none"}\nParent context: ${parentContext ? "inherited" : "not inherited"}\n${formatAgentList(state)}\n\nYou will receive an automatic follow-up message when the squad finishes or needs attention. Either call herdr_squad_wait with this squadId in the next tool round, or continue independent work and collect when notified. Do not poll with short waits.`,
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
						type: "text" as const,
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
			"Create and launch 1-12 visible, strictly read-only Pi investigation agents across up to three Herdr tabs. An explicit model overrides project/global config, and an assignment model overrides it for that agent. Returns an opaque squadId. Call this tool alone; wait for its result before calling herdr_squad_wait.",
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
			"Wait for every child in a previously started investigation or worker squad to submit its structured report. Uses one overall timeout and reports blockers. Call alone after a squad start tool has returned. Running squads also send an automatic follow-up when they finish, so never poll with short timeouts.",
		promptSnippet: "Wait for a Herdr squad's structured reports",
		promptGuidelines: [
			"Call herdr_squad_wait only after a Herdr squad start tool has returned a squadId, and wait for its result before calling herdr_squad_collect.",
			"Do not poll herdr_squad_wait with short timeouts. To keep working while a squad runs, skip waiting and act on the automatic squad follow-up message; use herdr_squad_status for a quick non-blocking check.",
		],
		executionMode: "sequential",
		parameters: SquadIdParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const state = getSquad(params.squadId);
			if (state.status === "closed") throw new Error("Cannot wait on a closed squad; collect its saved reports instead");
			const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
			const deadline = Date.now() + timeoutMs;

			waiting.add(state.squadId);
			try {
				while (true) {
					if (signal?.aborted) throw new Error("Herdr squad wait cancelled");
					const check = await checkSquad(state, signal);
					if (check.kind === "complete") {
						state.status = "completed";
						delete state.failure;
						saveState(state);
						return {
							content: [{ type: "text", text: `All ${check.completeCount} Herdr squad reports are ready. Call herdr_squad_collect with squadId ${state.squadId} in the next tool round.` }],
							details: { ...publicSquadDetails(state), completeCount: check.completeCount, timedOut: false },
						};
					}
					if (check.kind === "problem") {
						state.status = "partial";
						state.failure = check.message;
						saveState(state);
						return {
							content: [
								{ type: "text", text: `${check.completeCount}/${state.agents.length} reports are ready. ${check.message}. Collect available reports and terminal output now.` },
							],
							details: { ...publicSquadDetails(state), ...check.details, completeCount: check.completeCount, timedOut: false },
						};
					}

					onUpdate?.({
						content: [{ type: "text", text: `Herdr squad: ${check.completeCount}/${state.agents.length} reports ready...` }],
						details: { squadId: state.squadId, completeCount: check.completeCount },
					});
					if (Date.now() >= deadline) {
						// Agents keep running after a timeout; the watcher notifies the parent when they finish.
						watchSquad(state.squadId);
						return {
							content: [
								{
									type: "text",
									text: `${check.completeCount}/${state.agents.length} reports were ready after ${Math.round(timeoutMs / 1000)}s. Still running: ${check.running.join(", ")}. The agents keep working and you will receive an automatic follow-up when the squad finishes. Continue independent work or call herdr_squad_wait again; collect now only if you need partial results.`,
								},
							],
							details: { ...publicSquadDetails(state), completeCount: check.completeCount, running: check.running, timedOut: true },
						};
					}
					await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), signal);
				}
			} finally {
				waiting.delete(state.squadId);
				if (state.status === "running" || state.status === "partial") watchSquad(state.squadId);
			}
		},
	});

	pi.registerTool({
		name: "herdr_squad_status",
		label: "Herdr Squad Status",
		description:
			"Non-blocking progress check for an investigation or worker squad: which agents have reported and each agent's Herdr status. Does not collect reports.",
		promptSnippet: "Check a Herdr squad's progress without waiting",
		promptGuidelines: ["Use herdr_squad_status for a quick progress check instead of herdr_squad_wait with a short timeout."],
		parameters: StatusParams,
		async execute(_toolCallId, params, signal) {
			const state = getSquad(params.squadId);
			const reports = await Promise.all(state.agents.map((agent) => readAgentReport(state, agent)));
			const live = await refreshLivePanes(state, signal);
			const missing = new Set(live.missing);
			const completeCount = reports.filter(Boolean).length;
			const lines = state.agents.map((agent, index) => {
				const progress = reports[index] ? "report ready" : missing.has(agent.label) ? "pane missing" : `Herdr status ${agent.lastAgentStatus ?? "unknown"}`;
				return `- ${agent.label}: ${progress} (tab ${agent.tabLabel})`;
			});
			return {
				content: [
					{
						type: "text",
						text: `Herdr squad "${state.title}" (${state.squadId}): ${state.status}, ${completeCount}/${state.agents.length} reports ready.${state.failure ? ` Failure: ${state.failure}.` : ""}\n${lines.join("\n")}`,
					},
				],
				details: { ...publicSquadDetails(state), completeCount },
			};
		},
	});

	pi.registerTool({
		name: "herdr_squad_collect",
		label: "Collect Herdr Squad",
		description:
			`Collect structured reports from an investigation or worker squad, with bounded terminal-tail fallbacks. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; complete output is saved when truncated. Call only after herdr_squad_wait returns.`,
		promptSnippet: "Collect a Herdr squad's reports and fallback terminal output",
		promptGuidelines: ["Call herdr_squad_collect only after the corresponding herdr_squad_wait call has returned."],
		executionMode: "sequential",
		parameters: CollectParams,
		async execute(_toolCallId, params, signal) {
			const state = getSquad(params.squadId);
			const lines = params.lines ?? 240;
			const live = await refreshLivePanes(state, signal);
			const missingPanes = new Set(live.missing);
			const missingTabs = new Set(live.missingTabs);
			const perAgentBytes = Math.max(8_000, Math.floor((DEFAULT_MAX_BYTES - 4_000) / state.agents.length));
			const sections: string[] = [];
			const stillRunning: string[] = [];
			let structuredCount = 0;

			for (const agent of state.agents) {
				const report = await readAgentReport(state, agent);
				let section: string;
				if (report) {
					structuredCount++;
					section = formatReport(report, agent.reportPath, state.kind, agent.writableRoots);
				} else {
					const paneLive = !missingTabs.has(agent.tabLabel) && !missingPanes.has(agent.label) && Boolean(agent.paneId);
					const running = paneLive && mayBeRunning(state, agent);
					if (running) stillRunning.push(agent.label);
					let transcript = missingTabs.has(agent.tabLabel)
						? `Terminal output unavailable because tab ${agent.tabLabel} could not be revalidated.`
						: missingPanes.has(agent.label)
							? "Terminal output unavailable because this pane could not be revalidated."
							: "Terminal output unavailable.";
					if (!missingTabs.has(agent.tabLabel) && !missingPanes.has(agent.label) && agent.paneId) {
						try {
							const result = await pi.exec(
								"herdr",
								["pane", "read", agent.paneId, "--source", "recent-unwrapped", "--lines", String(running ? Math.min(lines, 40) : lines)],
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
					const status = running
						? `Still running (Herdr status ${agent.lastAgentStatus}); no report yet.${state.kind === "worker" ? " Do not modify its writable roots until it reports." : ""}`
						: `No valid structured report was submitted. Last Herdr status: ${agent.lastAgentStatus ?? "unknown"}.`;
					section = `# Squad Report ${running ? "Pending" : "Missing"}: ${agent.label}\n## Scope\n${agent.scope}${ownership}\n## Tab\n${agent.tabLabel}\n## Status\n${status}\n## Terminal tail\n${transcript}\n\nTerminal snapshot: ${transcriptPath}`;
				}

				const limited = truncateHead(section, { maxBytes: perAgentBytes, maxLines: DEFAULT_MAX_LINES });
				sections.push(
					limited.truncated
						? `${limited.content}\n\n[Agent section truncated. Full source is available at ${report ? agent.reportPath : join(state.runDir, `terminal-${agent.agentId}.txt`)}]`
						: limited.content,
				);
			}

			const fullCollection = `## Herdr squad collection\n- Squad: ${state.squadId}\n- Kind: ${state.kind}\n- Tabs: ${state.tabs.map((tab) => tab.tabLabel).join(", ") || "None"}\n- Model: ${state.model ?? "Pi default"} (${state.modelSource})${state.agents.some((agent) => agent.model) ? `; overrides: ${state.agents.filter((agent) => agent.model).map((agent) => `${agent.label}=${agent.model}`).join(", ")}` : ""}\n- Mode: ${state.kind === "worker" ? "shared-checkout coding workers" : "read-only investigation"}\n- Structured reports: ${structuredCount}/${state.agents.length}${stillRunning.length > 0 ? `\n- Still running: ${stillRunning.join(", ")} (you will receive an automatic follow-up when they finish; collect again then)` : ""}\n\n${sections.join("\n\n---\n\n")}`;
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

			// Keep watching a partially collected squad so the parent hears when the rest finish.
			if (state.status !== "closed") {
				if (structuredCount === state.agents.length || stillRunning.length === 0) state.status = "collected";
				else {
					state.status = "running";
					watchSquad(state.squadId);
				}
			}
			if (structuredCount === state.agents.length) delete state.failure;
			state.collectedAt = new Date().toISOString();
			saveState(state);
			return {
				content: [{ type: "text", text: output }],
				details: { ...publicSquadDetails(state), structuredCount, stillRunning, fullOutputPath },
			};
		},
	});

	pi.registerTool({
		name: "herdr_squad_steer",
		label: "Steer Herdr Squad Agent",
		description:
			"Send a message to one child in a running or finished squad: a correction, extra context, or a follow-up request. A working child receives it after its current tool calls; an idle or finished child starts a new turn. A child that already reported must report again, so wait for or collect its updated report.",
		promptSnippet: "Send a correction or follow-up message to a Herdr squad child",
		promptGuidelines: [
			"Use herdr_squad_steer to redirect a squad child or ask it a follow-up instead of starting a new squad for the same scope.",
			"Keep herdr_squad_steer messages within the child's original scope and ownership; start a new squad for different work.",
		],
		executionMode: "sequential",
		parameters: SteerParams,
		async execute(_toolCallId, params, signal) {
			const state = getSquad(params.squadId);
			if (state.status === "closed" || state.status === "launching") throw new Error(`Squad ${state.squadId} is ${state.status} and cannot be steered`);
			const needle = params.agent.trim().toLocaleLowerCase();
			const agent = state.agents.find((candidate) => candidate.label.toLocaleLowerCase() === needle || candidate.agentId === params.agent.trim());
			if (!agent) throw new Error(`No agent "${params.agent}" in squad ${state.squadId}. Agents: ${state.agents.map((item) => item.label).join(", ")}`);
			const message = cleanBody(params.message, MAX_STEER_LENGTH);
			if (!message) throw new Error("message must not be empty");

			const live = await refreshLivePanes(state, signal);
			if (live.missingTabs.includes(agent.tabLabel) || live.missing.includes(agent.label)) {
				throw new Error(`The pane for ${agent.label} is no longer available`);
			}

			// Set aside an existing report so the squad waits for the child's updated one.
			let supersededReport: string | undefined;
			if (await readSquadReport(agent.reportPath)) {
				supersededReport = agent.reportPath.replace(/\.json$/, `.superseded-${Date.now()}.json`);
				await rename(agent.reportPath, supersededReport);
			}

			const steer: SquadSteerMessage = { version: 1, id: randomUUID(), squadId: state.squadId, agentId: agent.agentId, message, createdAt: new Date().toISOString() };
			const fileName = `${steerFilePrefix(agent.agentId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
			const steerPath = join(state.runDir, fileName);
			const temporaryPath = join(state.runDir, `.${fileName}.tmp`);
			await writeFile(temporaryPath, `${JSON.stringify(steer, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporaryPath, steerPath);
			agent.pendingSteerId = steer.id;

			// The child restarts work, so forget its finished status and resume watching the squad.
			const key = `${state.squadId}:${agent.agentId}`;
			statusSince.delete(key);
			seenWorking.delete(key);
			if (state.status !== "running") {
				state.status = "running";
				delete state.failure;
			}
			saveState(state);
			watchSquad(state.squadId);

			let delivered = false;
			const deadline = Date.now() + STEER_ACK_WAIT_MS;
			while (Date.now() < deadline) {
				try {
					await access(`${steerPath}${STEER_DELIVERED_SUFFIX}`);
					delivered = true;
					break;
				} catch {
					await delay(250, signal);
				}
			}

			const deliveryText = delivered
				? `Delivered to ${agent.label} (pane ${agent.paneId}).`
				: `Queued for ${agent.label} (pane ${agent.paneId}), but the child has not picked it up yet. It is delivered when the child's squad extension next polls; if the pane no longer runs Pi, it will never arrive.`;
			const reportText = supersededReport
				? ` Its previous report was set aside (${supersededReport}); it will submit an updated one.`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `${deliveryText}${reportText} You will receive an automatic follow-up when the squad finishes; then call herdr_squad_collect with squadId ${state.squadId}.`,
					},
				],
				details: { ...publicSquadDetails(state), steeredAgent: agent.label, delivered, supersededReport },
			};
		},
	});

	pi.registerTool({
		name: "herdr_squad_close",
		label: "Close Herdr Squad",
		description:
			"Close a squad's Herdr tabs after its results are collected. Refuses while agents are still running unless force is true. Reports and terminal snapshots stay on disk.",
		promptSnippet: "Close a finished Herdr squad's tabs",
		promptGuidelines: ["Call herdr_squad_close after herdr_squad_collect when the squad's tabs are no longer needed for inspection."],
		executionMode: "sequential",
		parameters: CloseParams,
		async execute(_toolCallId, params, signal) {
			const state = getSquad(params.squadId);
			const reports = await Promise.all(state.agents.map((agent) => readAgentReport(state, agent)));
			const live = await refreshLivePanes(state, signal);
			const missingPanes = new Set(live.missing);
			const active = state.agents.filter(
				(agent, index) => !missingPanes.has(agent.label) &&
					(agent.lastAgentStatus === "working" || agent.lastAgentStatus === "blocked" || (!reports[index] && mayBeRunning(state, agent))),
			);
			if (active.length > 0 && params.force !== true) {
				throw new Error(`Agents are still running: ${active.map((agent) => agent.label).join(", ")}. Collect first, or pass force: true to close anyway.`);
			}

			const missingTabs = new Set(live.missingTabs);
			const closed: string[] = [];
			const failures: string[] = [];
			for (const tab of state.tabs) {
				if (missingTabs.has(tab.tabLabel)) continue;
				try {
					await runHerdr(["tab", "close", tab.tabId], signal);
					closed.push(tab.tabLabel);
				} catch (error) {
					failures.push(`${tab.tabLabel}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			stopWatching(state.squadId);
			state.status = failures.length > 0 ? "partial" : "closed";
			if (failures.length > 0) state.failure = failures.join("; ");
			else delete state.failure;
			saveState(state);
			const failureText = failures.length > 0 ? `\nFailed to close:\n${formatList(failures)}` : "";
			return {
				content: [
					{
						type: "text",
						text: `Closed ${closed.length} Herdr squad tab(s)${closed.length > 0 ? `: ${closed.join(", ")}` : ""}.${failureText}\nReports remain in ${state.runDir}.`,
					},
				],
				details: { ...publicSquadDetails(state), closed, failures },
			};
		},
	});
}

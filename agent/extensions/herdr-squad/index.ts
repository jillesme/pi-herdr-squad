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
	truncateTail,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerAgentTools } from "./agent.ts";
import { resolveConfiguredModel, validateExplicitModel } from "./config.ts";
import { validateExclusiveWritableRoots } from "./ownership.ts";
import {
	buildReadOnlyAgentPrompt,
	buildWritableAgentPrompt,
	inlineReportShare,
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
// Agents that reached idle/done without a report are treated as finished after this grace.
const FINISHED_GRACE_MS = 4_000;
// Before an agent has been seen working, idle may just mean Pi is still starting up.
const STARTUP_IDLE_GRACE_MS = 90_000;
const NOTIFY_MESSAGE_TYPE = "herdr-squad-update";
// Tail of the parent conversation inlined into each agent prompt when inheritContext is set.
const MAX_PARENT_CONTEXT_BYTES = 40_000;
const MAX_STEER_LENGTH = 8_000;
const STEER_ACK_WAIT_MS = 5_000;
// Report sections are promised this much of the tool-output limit; the rest covers the header, truncation notes and framing.
const COLLECT_BUDGET_BYTES = DEFAULT_MAX_BYTES - 6_000;
const COLLECT_BUDGET_LINES = DEFAULT_MAX_LINES - 150;
// Room for the sentence that wait and the completion follow-up put before a collection.
const FRAMING_BYTES = 600;
const FRAMING_LINES = 4;
const DEFAULT_TERMINAL_LINES = 240;
const AFTER_REPORTS_HINT =
	"Agent reports are claims, not proof: verify changes by agents with write access in the checkout diff. Call herdr_squad_close when the tabs are no longer needed.";

const AssignmentSchema = Type.Object({
	label: Type.String({ description: "Short unique agent label", minLength: 1, maxLength: 80 }),
	scope: Type.String({ description: "This agent's exclusive, non-overlapping responsibility", minLength: 1, maxLength: MAX_SCOPE_LENGTH }),
	prompt: Type.String({ description: "Specific, self-contained instructions for this agent", minLength: 1, maxLength: MAX_PROMPT_LENGTH }),
	writableRoots: Type.Optional(
		Type.Array(Type.String({ description: "Repository-relative file or directory tree (not a glob)", minLength: 1, maxLength: 1000 }), {
			description:
				"Omit for a read-only agent. When set, the agent also gets bash, edit, and write, and may modify only these roots. Roots of different agents must not overlap.",
			maxItems: 100,
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "Optional model for this agent only, overriding the squad model (for example a cheaper model for a simple scope)",
			minLength: 1,
			maxLength: 200,
		}),
	),
});

const StartParams = Type.Object({
	task: Type.String({ description: "Full parent task, shared with every agent", minLength: 1, maxLength: MAX_TASK_LENGTH }),
	assignments: Type.Array(AssignmentSchema, { description: "One entry per agent", minItems: 1, maxItems: MAX_AGENTS }),
	title: Type.Optional(Type.String({ description: "Short tab title", maxLength: 80 })),
	model: Type.Optional(
		Type.String({
			description: "Optional model for every agent, for example provider/model or model:thinking; an assignment model overrides it",
			minLength: 1,
			maxLength: 200,
		}),
	),
	focus: Type.Optional(Type.Boolean({ description: "Focus the first squad tab after launch; defaults to false" })),
	webTools: Type.Optional(
		Type.Boolean({
			description: `Give agents the parent's web tools (${WEB_TOOL_NAMES.join(", ")}) when available; defaults to true`,
		}),
	),
	inheritContext: Type.Optional(
		Type.Boolean({
			description:
				"Include the recent parent conversation (serialized, most recent ~40KB) in every agent prompt as background, so prompts need not restate discussed context; defaults to false",
		}),
	),
});

const SquadIdParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by herdr_squad_start", minLength: 8, maxLength: 80 }),
	timeoutMs: Type.Optional(Type.Integer({ description: "Overall wait timeout in milliseconds", minimum: 1_000, maximum: MAX_WAIT_MS })),
});

const StatusParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by herdr_squad_start", minLength: 8, maxLength: 80 }),
});

const SteerParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by herdr_squad_start", minLength: 8, maxLength: 80 }),
	agent: Type.String({ description: "Assignment label (or agent ID) of the agent to message", minLength: 1, maxLength: 80 }),
	message: Type.String({ description: "Message for the agent: a correction, extra context, or a follow-up request", minLength: 1, maxLength: MAX_STEER_LENGTH }),
});

const CloseParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by herdr_squad_start", minLength: 8, maxLength: 80 }),
	force: Type.Optional(Type.Boolean({ description: "Close tabs even when agents are still running; defaults to false" })),
});

const CollectParams = Type.Object({
	squadId: Type.String({ description: "Opaque squad ID returned by herdr_squad_start", minLength: 8, maxLength: 80 }),
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
	| { kind: "problem"; completeCount: number; message: string; details: JsonObject; running: string[] };

// Identifies a problem the parent has already been told about; a new report or a new problem changes it.
function problemKey(check: Extract<SquadCheck, { kind: "problem" }>): string {
	return `${check.completeCount}:${check.message}`;
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

function formatReport(report: Awaited<ReturnType<typeof readSquadReport>>, sourcePath: string, roots?: string[]): string {
	if (!report) return "";
	const writableSections = roots
		? `\n## Writable roots\n${formatList(roots, "None")}` +
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
	// The parent wrote the scope, so one line is enough; the budget goes to the agent's own words.
	return `# Squad Report: ${report.label}\nScope: ${normalizeDisplayText(report.scope, 200)}\n## Recommended next step\n${report.recommendedNextStep || "None reported"}\n## ${roots ? "Completion summary" : "Findings"}\n${report.findings}\n## Evidence\n${formatList(report.evidence)}${writableSections}\n## Risks / Unknowns / Handoffs\n${formatList(report.risksOrUnknowns)}\n\nStructured report: ${sourcePath}`;
}

// Share the output budget fairly: short sections leave their unused share to longer ones.
function allocateBudgets(sizes: number[], total: number): number[] {
	const budgets = new Array<number>(sizes.length).fill(0);
	let remaining = total;
	const ascending = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
	ascending.forEach(({ size, index }, position) => {
		budgets[index] = Math.min(size, Math.floor(remaining / (ascending.length - position)));
		remaining -= budgets[index];
	});
	return budgets;
}

function clipSection(text: string, maxBytes: number, maxLines: number): string {
	const lines = text.split("\n");
	const byLines = lines.length > maxLines ? lines.slice(0, Math.max(0, maxLines)).join("\n") : text;
	const buffer = Buffer.from(byLines, "utf8");
	if (buffer.length <= maxBytes) return byLines;
	// Drop a split trailing character, then prefer ending on a complete line.
	const cut = buffer.subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/\uFFFD$/, "");
	const lineEnd = cut.lastIndexOf("\n");
	return lineEnd > cut.length / 2 ? cut.slice(0, lineEnd) : cut;
}

export default function (pi: ExtensionAPI) {
	if (registerAgentTools(pi)) return;
	// Squads need Herdr panes; outside Herdr the tools would only fail, so leave them out of the prompt.
	if (process.env.HERDR_ENV !== "1") return;

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

	// Per-agent Herdr status history, used to tell startup idle apart from a finished agent.
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
		// A reported agent's pane may already have been closed; only missing
		// agents whose results are still outstanding prevent completion.
		const missingAgents = state.agents.filter((agent, index) => !reports[index] && live.missing.includes(agent.label));
		// Collect every problem instead of stopping at the first, so the remaining agents stay tracked.
		const problems: string[] = [];
		const details: JsonObject = {};
		if (missingAgents.length > 0) {
			problems.push(`Missing panes: ${missingAgents.map((agent) => agent.label).join(", ")}`);
			details.missing = missingAgents.map((agent) => agent.label);
		}

		const now = Date.now();
		const running: string[] = [];
		for (let index = 0; index < state.agents.length; index++) {
			if (reports[index]) continue;
			const agent = state.agents[index];
			if (missingAgents.includes(agent)) continue;
			const key = `${state.squadId}:${agent.agentId}`;
			const status = agent.lastAgentStatus ?? "unknown";
			const previous = statusSince.get(key);
			const since = previous?.status === status ? previous.since : now;
			statusSince.set(key, { status, since });
			if (status === "working") seenWorking.add(key);

			if (status === "blocked" && now - since >= BLOCKED_GRACE_MS) {
				problems.push(`${agent.label} is blocked in ${agent.tabLabel}`);
				(details.blocked ??= []).push(agent.label);
				continue;
			}
			const finished = status === "done" || status === "idle";
			if (finished && now - since >= (seenWorking.has(key) ? FINISHED_GRACE_MS : STARTUP_IDLE_GRACE_MS)) {
				problems.push(`${agent.label} (pane ${agent.paneId}, tab ${agent.tabLabel}) finished with Herdr status ${status} without submitting a report`);
				(details.terminated ??= []).push(agent.label);
				continue;
			}
			running.push(agent.label);
		}
		if (problems.length > 0) {
			const stillRunning = running.length > 0 ? `; still running: ${running.join(", ")}` : "";
			return { kind: "problem", completeCount, message: `${problems.join("; ")}${stillRunning}`, details, running };
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
					// The problem cleared (for example a blocked agent resumed); a recurrence is news again.
					delete state.notifiedProblem;
					return;
				}
				// The parent already saw this exact problem, from a notification or a wait result.
				if (check.kind === "problem" && state.notifiedProblem === problemKey(check)) return;
				let text: string;
				if (check.kind === "complete") {
					// Deliver the reports with the notification so the parent needs no separate collect call.
					const collection = await buildCollection(state, DEFAULT_TERMINAL_LINES);
					// Steering may have invalidated a report, or a wait may have started, while the reports were read.
					// Then the squad is not finished for this watcher: keep watching and announce nothing.
					if (
						watchers.get(squadId) !== timer ||
						state.updatedAt !== revision ||
						waiting.has(squadId) ||
						collection.structuredCount !== state.agents.length
					) {
						return;
					}
					stopWatching(squadId);
					commitCollection(state, collection, false);
					text = `Herdr squad "${state.title}" finished: all ${check.completeCount} reports are included below. ${AFTER_REPORTS_HINT}\n\n${collection.output}`;
				} else {
					state.notifiedProblem = problemKey(check);
					state.status = "partial";
					state.failure = check.message;
					const more = check.running.length > 0 ? " Running agents are still watched; you will be notified as more reports arrive." : "";
					text = `Herdr squad "${state.title}" needs attention: ${check.completeCount}/${state.agents.length} reports are ready. ${check.message}. Call herdr_squad_collect with squadId ${state.squadId} to see the available reports and terminal output.${more}`;
					saveState(state);
				}
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

	async function launchSquad(params: StartInput, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
		const count = params.assignments.length;
		if (count < 1 || count > MAX_AGENTS) throw new Error(`A squad needs 1 through ${MAX_AGENTS} assignments`);

		const task = cleanBody(params.task, MAX_TASK_LENGTH);
		if (!task) throw new Error("task must not be empty");
		const normalizedAssignments: LaunchAssignment[] = params.assignments.map((assignment) => ({
			label: normalizeDisplayText(assignment.label, 30),
			scope: cleanBody(assignment.scope, MAX_SCOPE_LENGTH),
			prompt: cleanBody(assignment.prompt, MAX_PROMPT_LENGTH),
			...(assignment.model ? { model: validateExplicitModel(assignment.model, `assignments[${assignment.label}].model`) } : {}),
			// Write access is per agent: an assignment without writable roots is read-only.
			...(assignment.writableRoots && assignment.writableRoots.length > 0 ? { writableRoots: assignment.writableRoots } : {}),
		}));
		if (normalizedAssignments.some((assignment) => !assignment.label || !assignment.scope || !assignment.prompt)) {
			throw new Error("Every assignment requires a non-empty label, scope, and prompt");
		}
		const labels = normalizedAssignments.map((assignment) => assignment.label.toLocaleLowerCase());
		if (new Set(labels).size !== labels.length) throw new Error("Assignment labels must be unique");
		const scopes = normalizedAssignments.map((assignment) => normalizeDisplayText(assignment.scope, MAX_SCOPE_LENGTH).toLocaleLowerCase());
		if (new Set(scopes).size !== scopes.length) throw new Error("Assignment scopes must not be exact duplicates");

		const checkoutRoot = await realpath(ctx.cwd);
		const writable = normalizedAssignments.filter((assignment) => assignment.writableRoots);
		if (writable.length > 0) {
			const ownership = await validateExclusiveWritableRoots(
				checkoutRoot,
				writable.map((assignment) => ({ label: assignment.label, writableRoots: assignment.writableRoots ?? [] })),
			);
			writable.forEach((assignment, index) => {
				assignment.writableRoots = ownership[index].writableRoots;
				assignment.canonicalWritableRoots = ownership[index].canonicalWritableRoots;
			});
		}
		const kind: SquadKind = writable.length > 0 ? "worker" : "investigation";

		const parentPaneId = process.env.HERDR_PANE_ID;
		if (!parentPaneId) throw new Error("HERDR_PANE_ID is unavailable; cannot identify the parent pane safely");
		const parentResponse = await herdr(["pane", "get", parentPaneId], signal);
		const parentPane = parentResponse.result?.pane;
		if (!parentPane?.workspace_id || String(parentPane.pane_id) !== parentPaneId) throw new Error("Could not validate the parent Herdr pane");
		const workspaceId = String(parentPane.workspace_id);
		let model: string | undefined;
		let modelSource: SquadState["modelSource"];
		if (params.model) {
			model = validateExplicitModel(params.model, "herdr_squad_start.model");
			modelSource = "explicit";
		} else {
			const configuredModel = await resolveConfiguredModel(checkoutRoot, ctx.isProjectTrusted());
			model = configuredModel.model;
			modelSource = configuredModel.source;
		}
		// Agents load the same packages as the parent, so pass through web tools the parent has.
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
		const defaultTitle = `Squad ${shortId}`;
		const title = normalizeDisplayText(params.title || defaultTitle, 38) || defaultTitle;
		const tabCount = Math.ceil(count / MAX_AGENTS_PER_TAB);
		const tabLabels = Array.from({ length: tabCount }, (_, index) =>
			tabCount === 1 ? `${title} · sq-${shortId}` : `${title} ${index + 1}/${tabCount} · sq-${shortId}`,
		);
		const runDir = await mkdtemp(join(tmpdir(), RUN_DIR_PREFIX));
		const manifestAgents: SquadManifest["agents"] = normalizedAssignments.map((assignment, index) => ({
			agentId: `${shortId}-${index + 1}`,
			token: randomBytes(24).toString("hex"),
			label: assignment.label,
			scope: assignment.scope,
			...(assignment.writableRoots
				? { writableRoots: assignment.writableRoots, canonicalWritableRoots: assignment.canonicalWritableRoots }
				: {}),
		}));
		const manifest: SquadManifest = { version: 2, squadId, kind, checkoutRoot, agents: manifestAgents };
		await writeFile(join(runDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

		// Tell every agent how much of its report the parent is guaranteed to see inline.
		const inline = inlineReportShare(COLLECT_BUDGET_BYTES, COLLECT_BUDGET_LINES, count);
		const agents: SquadAgentState[] = [];
		for (let index = 0; index < normalizedAssignments.length; index++) {
			const assignment = normalizedAssignments[index];
			const identity = manifestAgents[index];
			const promptPath = join(runDir, `prompt-${identity.agentId}.md`);
			const prompt = assignment.writableRoots
				? buildWritableAgentPrompt(task, assignment.label, assignment.scope, assignment.writableRoots, assignment.prompt, webTools, inline, parentContext)
				: buildReadOnlyAgentPrompt(task, assignment.label, assignment.scope, assignment.prompt, webTools, inline, parentContext);
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
				...(assignment.writableRoots ? { writableRoots: assignment.writableRoots } : {}),
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
			onUpdate?.({ content: [{ type: "text", text: `Creating ${tabCount} Herdr squad tab(s) for ${count} agent(s)...` }] });
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
					"pi",
					"--name",
					`Squad ${agent.label}`,
				];
				const agentModel = agent.model ?? state.model;
				if (agentModel) commandArguments.push("--model", agentModel);
				const tools = [
					...(agent.writableRoots ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"]),
					...webTools,
					"herdr_squad_report",
				];
				// Skills stay enabled so agents can follow domain skills (for example Remotion or Cloudflare docs).
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
						text: `Started Herdr squad ${squadId}: ${count} agent(s), ${writable.length} with write access.\nTabs: ${state.tabs.map((tab) => tab.tabLabel).join(", ")}\nModel: ${state.model ?? "Pi default"} (${state.modelSource})\nWeb tools: ${webTools.join(", ") || "none"}\nParent context: ${parentContext ? "inherited" : "not inherited"}\n${formatAgentList(state)}\n\nEither call herdr_squad_wait with this squadId, or continue independent work: an automatic follow-up message delivers the reports when the squad finishes, or tells you when it needs attention. Do not poll with short waits.`,
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

	// Reads reports and renders the collection without changing squad state, so callers can
	// re-check for concurrent changes (steering) before they commit the result.
	async function buildCollection(state: SquadState, lines: number, signal?: AbortSignal) {
		const reports = await Promise.all(state.agents.map((agent) => readAgentReport(state, agent)));
		// Panes matter only for agents without a report, so a complete squad needs no Herdr calls.
		const live = reports.every(Boolean) ? undefined : await refreshLivePanes(state, signal);
		const missingPanes = new Set(live?.missing ?? []);
		const missingTabs = new Set(live?.missingTabs ?? []);
		const sections: Array<{ text: string; sourcePath: string }> = [];
		const stillRunning: string[] = [];
		let structuredCount = 0;

		for (let index = 0; index < state.agents.length; index++) {
			const agent = state.agents[index];
			const report = reports[index];
			if (report) {
				structuredCount++;
				sections.push({ text: formatReport(report, agent.reportPath, agent.writableRoots), sourcePath: agent.reportPath });
				continue;
			}
			const paneLive = !missingTabs.has(agent.tabLabel) && !missingPanes.has(agent.label) && Boolean(agent.paneId);
			const running = paneLive && mayBeRunning(state, agent);
			if (running) stillRunning.push(agent.label);
			let transcript = missingTabs.has(agent.tabLabel)
				? `Terminal output unavailable because tab ${agent.tabLabel} could not be revalidated.`
				: missingPanes.has(agent.label)
					? "Terminal output unavailable because this pane could not be revalidated."
					: "Terminal output unavailable.";
			if (paneLive) {
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
			const ownership = agent.writableRoots ? `\n## Writable roots\n${formatList(agent.writableRoots, "None")}` : "";
			const status = running
				? `Still running (Herdr status ${agent.lastAgentStatus}); no report yet.${agent.writableRoots ? " Do not modify its writable roots until it reports." : ""}`
				: `No valid structured report was submitted. Last Herdr status: ${agent.lastAgentStatus ?? "unknown"}.`;
			sections.push({
				text: `# Squad Report ${running ? "Pending" : "Missing"}: ${agent.label}\nScope: ${normalizeDisplayText(agent.scope, 200)}${ownership}\n## Tab\n${agent.tabLabel}\n## Status\n${status}\n## Terminal tail\n${transcript}\n\nTerminal snapshot: ${transcriptPath}`,
				sourcePath: transcriptPath,
			});
		}

		const writableCount = state.agents.filter((agent) => agent.writableRoots).length;
		const overrides = state.agents.filter((agent) => agent.model).map((agent) => `${agent.label}=${normalizeDisplayText(agent.model ?? "", 60)}`);
		const header = `## Herdr squad collection\n- Squad: ${state.squadId}\n- Tabs: ${state.tabs.map((tab) => tab.tabLabel).join(", ") || "None"}\n- Model: ${state.model ?? "Pi default"} (${state.modelSource})${overrides.length > 0 ? `; overrides: ${overrides.join(", ")}` : ""}\n- Agents: ${state.agents.length} (${writableCount} with write access to the shared checkout, ${state.agents.length - writableCount} read-only)\n- Structured reports: ${structuredCount}/${state.agents.length}${stillRunning.length > 0 ? `\n- Still running: ${stillRunning.join(", ")} (you will receive an automatic follow-up when they finish; collect again then)` : ""}`;

		// The whole output must fit both limits without a final cut, because cutting the assembled text
		// drops the last agents. Reserve the header, every possible truncation note, the separators and
		// the caller's framing first, then share what is left: every agent gets an equal share of bytes
		// and of lines (it was told that share at launch), and unused share goes to longer sections.
		const notes = sections.map((section) => `\n\n[Section truncated. Full source: ${section.sourcePath}]`);
		const separator = "\n\n---\n\n";
		const fullOutputPath = join(state.runDir, "collection.md");
		const trailer = `\n\n[${sections.length} section(s) truncated to fit the output limit. Full collection: ${fullOutputPath}]`;
		const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
		const lineBreaks = (text: string) => text.split("\n").length - 1;
		const fixed = [header, "\n\n", ...notes, separator.repeat(sections.length - 1), trailer];
		const byteBudget = DEFAULT_MAX_BYTES - FRAMING_BYTES - fixed.reduce((sum, text) => sum + byteLength(text), 0);
		const lineBudget = DEFAULT_MAX_LINES - FRAMING_LINES - 1 - fixed.reduce((sum, text) => sum + lineBreaks(text), 0);
		const byteBudgets = allocateBudgets(sections.map((section) => byteLength(section.text)), byteBudget);
		const lineBudgets = allocateBudgets(sections.map((section) => lineBreaks(section.text) + 1), lineBudget);
		let clippedCount = 0;
		const limited = sections.map((section, index) => {
			const clipped = clipSection(section.text, byteBudgets[index], lineBudgets[index]);
			if (clipped === section.text) return clipped;
			clippedCount++;
			return `${clipped}${notes[index]}`;
		});
		let output = `${header}\n\n${limited.join(separator)}`;
		if (clippedCount > 0) {
			const full = `${header}\n\n${sections.map((section) => section.text).join(separator)}\n`;
			await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, full, { encoding: "utf8", mode: 0o600 }));
			output += trailer.replace(`${sections.length} section(s)`, `${clippedCount} section(s)`);
		}
		return { output, structuredCount, stillRunning, fullOutputPath: clippedCount > 0 ? fullOutputPath : undefined };
	}

	// Records a collection. "collected" means a tool result handed the reports to the parent;
	// a follow-up message is only queued, so its squad stays "completed" and wait still returns the reports.
	function commitCollection(state: SquadState, collection: Awaited<ReturnType<typeof buildCollection>>, delivered: boolean): void {
		const allStructured = collection.structuredCount === state.agents.length;
		// Keep watching a partially collected squad so the parent hears when the rest finish.
		if (state.status !== "closed") {
			if (allStructured) state.status = delivered ? "collected" : "completed";
			else if (collection.stillRunning.length === 0) state.status = "collected";
			else {
				state.status = "running";
				watchSquad(state.squadId);
			}
		}
		if (allStructured) {
			delete state.failure;
			delete state.notifiedProblem;
		}
		if (delivered) state.collectedAt = new Date().toISOString();
		saveState(state);
	}

	pi.registerTool({
		name: "herdr_squad_start",
		label: "Start Herdr Squad",
		description:
			`Launch 1-${MAX_AGENTS} visible Pi agents in Herdr panes (up to ${MAX_AGENTS_PER_TAB} per tab) that share the current checkout. An agent is read-only (read, grep, find, ls, plus web tools when enabled) unless its assignment sets writableRoots, which adds bash, edit, and write. Writable roots are enforced for edit and write; bash is not sandboxed. Model precedence: assignment model, then model, then project/global squad config, then Pi's default. Returns an opaque squadId.`,
		promptSnippet: "Launch a visible Herdr squad of read-only or writable agents",
		promptGuidelines: [
			"Give each herdr_squad_start assignment a distinct scope and a self-contained prompt: agents see only task and their own assignment unless inheritContext is true.",
			"Set writableRoots in herdr_squad_start only for agents that must edit files, with roots that do not overlap, and do not modify those roots yourself until that agent has reported.",
		],
		parameters: StartParams,
		execute(_toolCallId, params, signal, onUpdate, ctx) {
			return launchSquad(params as StartInput, signal, onUpdate, ctx);
		},
	});

	// Kept for one release so existing prompts keep working; herdr_squad_start accepts the same arguments.
	pi.registerTool({
		name: "herdr_worker_squad_start",
		label: "Start Herdr Squad (deprecated alias)",
		description: "Deprecated alias of herdr_squad_start. Call herdr_squad_start with writableRoots on each assignment instead.",
		parameters: StartParams,
		execute(_toolCallId, params, signal, onUpdate, ctx) {
			return launchSquad(params as StartInput, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "herdr_squad_wait",
		label: "Wait for Herdr Squad",
		description:
			"Wait for every agent in a squad to submit its structured report, and return the reports when all are in. Returns early when an agent needs attention, or at the timeout; a timeout does not stop the agents. Running squads also deliver their reports in an automatic follow-up message when they finish, so never poll with short timeouts.",
		promptSnippet: "Wait for a Herdr squad and receive its reports",
		promptGuidelines: [
			"After herdr_squad_start, either call herdr_squad_wait once with a generous timeout or keep working until the automatic follow-up arrives; both deliver the reports. Never poll herdr_squad_wait with short timeouts; herdr_squad_status is the non-blocking check.",
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
						const collection = await buildCollection(state, DEFAULT_TERMINAL_LINES, signal);
						// A report can be set aside between the check and the read; then keep waiting.
						if (collection.structuredCount !== state.agents.length) {
							await delay(POLL_INTERVAL_MS, signal);
							continue;
						}
						commitCollection(state, collection, true);
						return {
							content: [{ type: "text", text: `All ${check.completeCount} Herdr squad reports are included below. ${AFTER_REPORTS_HINT}\n\n${collection.output}` }],
							details: { ...publicSquadDetails(state), completeCount: check.completeCount, fullOutputPath: collection.fullOutputPath, timedOut: false },
						};
					}
					// A problem the parent already knows about does not end the wait while other agents still run.
					if (check.kind === "problem" && (state.notifiedProblem !== problemKey(check) || check.running.length === 0)) {
						state.status = "partial";
						state.failure = check.message;
						state.notifiedProblem = problemKey(check);
						saveState(state);
						return {
							content: [
								{ type: "text", text: `${check.completeCount}/${state.agents.length} reports are ready. ${check.message}. Call herdr_squad_collect for the available reports and terminal output.` },
							],
							details: { ...publicSquadDetails(state), ...check.details, completeCount: check.completeCount, running: check.running, timedOut: false },
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
									text: `${check.completeCount}/${state.agents.length} reports were ready after ${Math.round(timeoutMs / 1000)}s. Still running: ${check.running.join(", ")}. The agents keep working and an automatic follow-up will deliver the reports when the squad finishes. Continue independent work or call herdr_squad_wait again; call herdr_squad_collect now only if you need partial results.`,
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
			"Non-blocking progress check for a squad: which agents have reported and each agent's Herdr status. Does not return reports.",
		promptSnippet: "Check a Herdr squad's progress without waiting",
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
			`Read a squad's structured reports, with terminal tails for agents that have not reported. Needed only for partial results, missing reports, or to re-read: a completed herdr_squad_wait and the completion follow-up already include the reports. Output is limited to ${formatSize(DEFAULT_MAX_BYTES)} shared equally between agents; the full collection is saved to a file when anything is truncated.`,
		promptSnippet: "Read a Herdr squad's partial or saved reports and terminal fallbacks",
		promptGuidelines: [
			"Call herdr_squad_collect only for partial results, missing reports, or to re-read reports; a completed herdr_squad_wait and the completion follow-up already include them.",
		],
		executionMode: "sequential",
		parameters: CollectParams,
		async execute(_toolCallId, params, signal) {
			const state = getSquad(params.squadId);
			const collection = await buildCollection(state, params.lines ?? DEFAULT_TERMINAL_LINES, signal);
			commitCollection(state, collection, true);
			return {
				content: [{ type: "text", text: collection.output }],
				details: {
					...publicSquadDetails(state),
					structuredCount: collection.structuredCount,
					stillRunning: collection.stillRunning,
					fullOutputPath: collection.fullOutputPath,
				},
			};
		},
	});

	pi.registerTool({
		name: "herdr_squad_steer",
		label: "Steer Herdr Squad Agent",
		description:
			"Send a message to one agent in a running or finished squad: a correction, extra context, or a follow-up request. A working agent receives it after its current tool calls; an idle or finished agent starts a new turn. An agent that already reported must report again, and its updated report arrives through herdr_squad_wait or the automatic follow-up.",
		promptSnippet: "Send a correction or follow-up message to a Herdr squad agent",
		promptGuidelines: [
			"Use herdr_squad_steer to correct a squad agent or ask it a follow-up within its original scope and writable roots, instead of starting a new squad for the same scope.",
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

			// Set aside an existing report so the squad waits for the agent's updated one.
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

			// The agent restarts work, so forget its finished status and resume watching the squad.
			const key = `${state.squadId}:${agent.agentId}`;
			statusSince.delete(key);
			seenWorking.delete(key);
			if (state.status !== "running") {
				state.status = "running";
				delete state.failure;
			}
			// The steered agent may resolve or repeat a known problem; either outcome is news.
			delete state.notifiedProblem;
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
				: `Queued for ${agent.label} (pane ${agent.paneId}), but the agent has not picked it up yet. It is delivered when the agent's squad extension next polls; if the pane no longer runs Pi, it will never arrive.`;
			const reportText = supersededReport
				? ` Its previous report was set aside (${supersededReport}); it will submit an updated one.`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `${deliveryText}${reportText} An automatic follow-up will deliver the updated reports when the squad finishes.`,
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
			"Close a squad's Herdr tabs once its reports are handled. Refuses while agents are still running unless force is true. Reports and terminal snapshots stay on disk.",
		promptSnippet: "Close a finished Herdr squad's tabs",
		promptGuidelines: ["Call herdr_squad_close once a squad's reports are handled and its tabs are no longer needed for inspection."],
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
				throw new Error(`Agents are still running: ${active.map((agent) => agent.label).join(", ")}. Wait for them, or pass force: true to close anyway.`);
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

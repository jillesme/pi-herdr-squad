import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface HerdrSquadConfig {
	defaultModel?: string | null;
}

export interface ResolvedModelConfig {
	model?: string;
	source: "global" | "project" | "pi-default";
	path?: string;
}

function validateModel(value: unknown, path: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`defaultModel in ${path} must be a string or null`);
	const model = value.trim();
	if (!model) throw new Error(`defaultModel in ${path} must not be empty`);
	if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
		throw new Error(`defaultModel in ${path} contains invalid characters or exceeds 200 characters`);
	}
	return model;
}

async function readConfig(path: string): Promise<{ exists: boolean; model?: string; explicitlyDisabled: boolean }> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, explicitlyDisabled: false };
		throw new Error(`Could not read Herdr squad config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`Could not parse Herdr squad config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Herdr squad config ${path} must contain a JSON object`);
	}
	const config = parsed as HerdrSquadConfig;
	return {
		exists: true,
		model: validateModel(config.defaultModel, path),
		explicitlyDisabled: config.defaultModel === null,
	};
}

export async function resolveConfiguredModel(cwd: string, projectTrusted: boolean): Promise<ResolvedModelConfig> {
	const globalPath = join(getAgentDir(), "herdr-squad.json");
	const globalConfig = await readConfig(globalPath);
	let resolved: ResolvedModelConfig = globalConfig.model
		? { model: globalConfig.model, source: "global", path: globalPath }
		: { source: "pi-default" };

	if (!projectTrusted) return resolved;
	const projectPath = join(cwd, CONFIG_DIR_NAME, "herdr-squad.json");
	const projectConfig = await readConfig(projectPath);
	if (!projectConfig.exists) return resolved;
	if (projectConfig.explicitlyDisabled) return { source: "pi-default", path: projectPath };
	if (projectConfig.model) resolved = { model: projectConfig.model, source: "project", path: projectPath };
	return resolved;
}

export function validateExplicitModel(value: string): string {
	return validateModel(value, "herdr_squad_start.model")!;
}

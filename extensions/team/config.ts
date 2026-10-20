/**
 * Team configuration: discovery, parsing, and validation of team.yaml.
 *
 * The roster is read from `.pi/team.yaml`, searched upward from the working
 * directory, with a user-level fallback at `<agent-dir>/team.yaml`
 * (i.e. ~/.pi/agent/team.yaml).
 *
 * YAML is parsed with pi's exported `parseFrontmatter`, which runs the real
 * `yaml` parser, so this extension has no dependencies of its own.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Tool allowlist used for read-only permission modes and role defaults. */
export const READ_ONLY_TOOLS = ["read", "ls", "find", "grep"] as const;

export type PermissionMode = "auto" | "read_only" | "none";

export interface TeamProjectInfo {
	name?: string;
	description?: string;
	main_branch?: string;
	integration_branch?: string;
}

export interface TeamDefaults {
	permission_mode?: PermissionMode;
	max_turns_per_task?: number;
	max_concurrent_agents?: number;
	require_review?: boolean;
	thinking?: string;
}

export interface TeamAgent {
	/** Short identifier used to address the agent (e.g. "pm", "eng-1"). */
	id: string;
	/** Role key; selects the system-prompt template. */
	role: string;
	/** Model alias or pattern as written in the config. */
	model?: string;
	/** Alias-resolved model pattern actually dispatched. */
	resolvedModel?: string;
	/** Area of responsibility (e.g. "backend"). */
	focus?: string;
	/** Character description, primarily for focus_group agents. */
	persona?: string;
	/** Full system-prompt override; replaces the role template. */
	prompt?: string;
	/** Explicit tool allowlist. Empty array means no tools. */
	tools?: string[];
	permission_mode?: PermissionMode;
	thinking?: string;
	/** Turn cap override for this agent. */
	max_turns?: number;
	/** One-line description; defaults to the role description. */
	description?: string;
}

export interface TeamConfig {
	sourcePath: string;
	version?: number;
	project: TeamProjectInfo;
	defaults: TeamDefaults;
	/** alias -> model pattern (e.g. "opus": "claude-opus-4") */
	models: Record<string, string>;
	agents: TeamAgent[];
}

export interface TeamLoadResult {
	config: TeamConfig | null;
	/** Non-fatal issues; surfaced to the user but the roster still loads. */
	warnings: string[];
	/** Fatal issue; the roster is unusable until the config is fixed. */
	error?: string;
}

const AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function* walkUp(start: string): Generator<string> {
	let dir = path.resolve(start);
	while (true) {
		yield dir;
		const parent = path.dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}

/** Find the nearest team config: `.pi/team.{yaml,yml}` upward, then user-level. */
export function findTeamConfigPath(cwd: string): string | null {
	for (const base of walkUp(cwd)) {
		for (const name of ["team.yaml", "team.yml"]) {
			const candidate = path.join(base, ".pi", name);
			if (isFile(candidate)) return candidate;
		}
	}
	for (const name of ["team.yaml", "team.yml"]) {
		const candidate = path.join(getAgentDir(), name);
		if (isFile(candidate)) return candidate;
	}
	return null;
}

/**
 * Parse a full YAML document using pi's frontmatter parser.
 *
 * The document is wrapped in `---` fences; a standalone `---` line inside the
 * file would end the fence early, so reject it up front (multi-document YAML
 * is not supported anyway).
 */
function parseYamlDocument(text: string): Record<string, unknown> {
	if (/^---\s*$/m.test(text)) {
		throw new Error(
			"team.yaml must be a single YAML document; remove standalone '---' separator lines",
		);
	}
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(`---\n${text}\n---\n`);
	if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
		throw new Error("team.yaml must contain a YAML mapping at the top level");
	}
	return frontmatter;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizePermissionMode(
	value: unknown,
	warnings: string[],
	context: string,
): PermissionMode | undefined {
	const raw = asString(value);
	if (raw === undefined) return undefined;
	const lowered = raw.toLowerCase().replace(/-/g, "_");
	if (["auto", "full", "default"].includes(lowered)) return "auto";
	if (["read_only", "readonly", "ro"].includes(lowered)) return "read_only";
	if (["none", "no_tools", "notools"].includes(lowered)) return "none";
	warnings.push(`${context}: unknown permission_mode "${raw}" (expected auto, read_only, or none); treating as auto`);
	return "auto";
}

function parseProject(value: unknown, warnings: string[]): TeamProjectInfo {
	const project: TeamProjectInfo = {};
	if (value === undefined || value === null) return project;
	if (typeof value !== "object" || Array.isArray(value)) {
		warnings.push("project: expected a mapping; ignoring");
		return project;
	}
	const record = value as Record<string, unknown>;
	project.name = asString(record.name);
	project.description = asString(record.description);
	project.main_branch = asString(record.main_branch);
	project.integration_branch = asString(record.integration_branch);
	return project;
}

function parseDefaults(value: unknown, warnings: string[]): TeamDefaults {
	const defaults: TeamDefaults = {};
	if (value === undefined || value === null) return defaults;
	if (typeof value !== "object" || Array.isArray(value)) {
		warnings.push("defaults: expected a mapping; ignoring");
		return defaults;
	}
	const record = value as Record<string, unknown>;
	defaults.permission_mode = normalizePermissionMode(record.permission_mode, warnings, "defaults");
	defaults.max_turns_per_task = asNumber(record.max_turns_per_task);
	defaults.max_concurrent_agents = asNumber(record.max_concurrent_agents);
	defaults.require_review = asBoolean(record.require_review);
	defaults.thinking = asString(record.thinking);
	if (defaults.max_turns_per_task !== undefined && defaults.max_turns_per_task < 1) {
		warnings.push(`defaults.max_turns_per_task must be >= 1 (got ${defaults.max_turns_per_task}); ignoring`);
		defaults.max_turns_per_task = undefined;
	}
	if (defaults.max_concurrent_agents !== undefined && defaults.max_concurrent_agents < 1) {
		warnings.push(`defaults.max_concurrent_agents must be >= 1 (got ${defaults.max_concurrent_agents}); ignoring`);
		defaults.max_concurrent_agents = undefined;
	}
	return defaults;
}

function parseModels(value: unknown, warnings: string[]): Record<string, string> {
	const models: Record<string, string> = {};
	if (value === undefined || value === null) return models;
	if (typeof value !== "object" || Array.isArray(value)) {
		warnings.push("models: expected a mapping of alias -> model; ignoring");
		return models;
	}
	for (const [alias, model] of Object.entries(value as Record<string, unknown>)) {
		const resolved = asString(model);
		if (resolved === undefined) {
			warnings.push(`models.${alias}: expected a string model pattern; ignoring`);
			continue;
		}
		models[alias] = resolved;
	}
	return models;
}

function parseAgents(
	value: unknown,
	models: Record<string, string>,
	defaults: TeamDefaults,
	warnings: string[],
): { agents: TeamAgent[]; error?: string } {
	if (!Array.isArray(value)) {
		return { agents: [], error: "agents: expected a list of agent mappings" };
	}

	const agents: TeamAgent[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		const at = `agents[${i}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return { agents: [], error: `${at}: expected a mapping` };
		}
		const record = entry as Record<string, unknown>;

		const id = asString(record.id);
		if (!id) return { agents: [], error: `${at}: missing required field "id"` };
		if (!AGENT_ID_PATTERN.test(id)) {
			return { agents: [], error: `${at}: invalid id "${id}" (use letters, digits, ., _, -)` };
		}
		if (seen.has(id)) return { agents: [], error: `${at}: duplicate agent id "${id}"` };
		seen.add(id);

		const role = asString(record.role);
		if (!role) return { agents: [], error: `${at} (${id}): missing required field "role"` };

		const agent: TeamAgent = {
			id,
			role: role.toLowerCase().replace(/[\s-]+/g, "_"),
		};

		const model = asString(record.model);
		if (model !== undefined) {
			agent.model = model;
			// An entry in the models map wins; otherwise the value is used
			// directly as a model pattern (e.g. "claude-sonnet-4-5").
			agent.resolvedModel = models[model] ?? model;
		}

		agent.focus = asString(record.focus);
		agent.persona = asString(record.persona);
		agent.prompt = asString(record.prompt);
		agent.thinking = asString(record.thinking);
		agent.description = asString(record.description);

		if (record.tools !== undefined) {
			if (Array.isArray(record.tools)) {
				agent.tools = (record.tools as unknown[])
					.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
					.map((t) => t.trim());
			} else if (typeof record.tools === "string") {
				// An empty string or empty list means "no tools".
				agent.tools = record.tools
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
			} else {
				warnings.push(`${at} (${id}): tools must be a list or comma-separated string; using role defaults`);
			}
		}

		agent.permission_mode = normalizePermissionMode(
			record.permission_mode ?? defaults.permission_mode,
			warnings,
			`${at} (${id})`,
		);

		agent.max_turns = asNumber(record.max_turns);
		if (agent.max_turns !== undefined && agent.max_turns < 1) {
			warnings.push(`${at} (${id}): max_turns must be >= 1; ignoring`);
			agent.max_turns = undefined;
		}

		agents.push(agent);
	}

	if (agents.length === 0) {
		return { agents: [], error: "agents: list is empty; define at least one agent" };
	}
	return { agents };
}

/** Load and validate the team config for a working directory. */
export function loadTeamConfig(cwd: string): TeamLoadResult {
	const warnings: string[] = [];
	const sourcePath = findTeamConfigPath(cwd);

	if (!sourcePath) {
		return {
			config: null,
			warnings,
			error: `No team.yaml found. Create one at .pi/team.yaml (or ${getAgentDir()}${path.sep}team.yaml).`,
		};
	}

	let text: string;
	try {
		text = fs.readFileSync(sourcePath, "utf-8");
	} catch (err) {
		return { config: null, warnings, error: `Cannot read ${sourcePath}: ${err instanceof Error ? err.message : String(err)}` };
	}

	let root: Record<string, unknown>;
	try {
		root = parseYamlDocument(text);
	} catch (err) {
		return {
			config: null,
			warnings,
			error: `Invalid YAML in ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const version = asNumber(root.version);
	if (version !== undefined && version < 1) {
		warnings.push(`version: unsupported team.yaml version ${version}; continuing anyway`);
	}

	const project = parseProject(root.project, warnings);
	const defaults = parseDefaults(root.defaults, warnings);
	const models = parseModels(root.models, warnings);

	const { agents, error } = parseAgents(root.agents, models, defaults, warnings);
	if (error) {
		return { config: null, warnings, error: `${error} (in ${sourcePath})` };
	}

	return {
		config: {
			sourcePath,
			version,
			project,
			defaults,
			models,
			agents,
		},
		warnings,
	};
}

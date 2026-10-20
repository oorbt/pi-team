/**
 * Team extension: build a team of agents from .slai/team.yaml.
 *
 * Every agent gets its own model, role prompt, and tool permissions, and runs
 * in its own `pi` subprocess with an isolated context window. The active
 * session dispatches work through the `team` tool:
 *
 *   team({ agent: "pm", task: "..." })                       single
 *   team({ tasks: [{ agent, task }, ...] })                  parallel
 *   team({ chain: [{ agent, task: "... {previous} ..." }] }) sequential
 *
 * Commands:
 *   /team            show the roster
 *   /team reload     reload extensions and the team config
 *   /team run <id> <task...>   dispatch directly from the user
 *
 * Config: `.slai/team.yaml` (searched upward from cwd), falling back to
 * `~/.pi/agent/team.yaml`. See the extension README for the full schema.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { loadTeamConfig, type TeamAgent, type TeamConfig } from "./config.ts";
import { roleDescription } from "./roles.ts";
import {
	aggregateUsage,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runAgent,
	type AgentRunResult,
	type DispatchDefaults,
	type TeamDispatchDetails,
} from "./runner.ts";
import { renderTeamCall, renderTeamResult, truncateOutput } from "./render.ts";

const MAX_PARALLEL_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Roster helpers
// ---------------------------------------------------------------------------

function rosterLines(config: TeamConfig): string[] {
	const lines: string[] = [];
	for (const agent of config.agents) {
		const bits: string[] = [agent.role];
		bits.push(agent.resolvedModel ?? agent.model ?? "(session model)");
		if (agent.focus) bits.push(`focus: ${agent.focus}`);
		if (agent.persona) bits.push(`persona: ${truncateCell(agent.persona, 48)}`);
		if (agent.tools) bits.push(`tools: ${agent.tools.length > 0 ? agent.tools.join("+") : "none"}`);
		else if (agent.permission_mode === "read_only") bits.push("tools: read-only");
		else if (agent.permission_mode === "none") bits.push("tools: none");
		lines.push(`${agent.id.padEnd(12)} ${bits.join(" · ")}`);
	}
	return lines;
}

function truncateCell(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

function rosterSummary(config: TeamConfig): string {
	return config.agents.map((a) => `${a.id}: ${roleDescription(a)}`).join("\n");
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent id from the roster" }),
	task: Type.String({ description: "Self-contained task for that agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Agent id from the roster" }),
	task: Type.String({ description: "Task; {previous} is replaced with the prior step's output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const TeamParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent id (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in parallel" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Steps to run sequentially, {previous} carries prior output" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// ---------------------------------------------------------------------------
// Dispatch logic
// ---------------------------------------------------------------------------

interface LoadedTeam {
	config: TeamConfig | null;
	warnings: string[];
	error?: string;
}

function loadFor(cwd: string): LoadedTeam {
	const { config, warnings, error } = loadTeamConfig(cwd);
	return { config, warnings, error };
}

function configErrorMessage(load: LoadedTeam): string {
	const lines = [`Team config error: ${load.error}`];
	if (load.warnings.length > 0) lines.push("", "Warnings:", ...load.warnings.map((w) => `- ${w}`));
	return lines.join("\n");
}

function findAgent(config: TeamConfig, id: string): TeamAgent | undefined {
	return config.agents.find((a) => a.id === id);
}

async function dispatch(
	load: LoadedTeam,
	params: any,
	ctx: { cwd: string; model?: any; thinkingLevel?: any },
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<TeamDispatchDetails>) => void) | undefined,
): Promise<{ content: { type: "text"; text: string }[]; details: TeamDispatchDetails; isError?: boolean }> {
	const config = load.config!;
	const dispatchDefaults: DispatchDefaults = {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: ctx.thinkingLevel,
	};

	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: AgentRunResult[]): TeamDispatchDetails => ({
			mode,
			configPath: config.sourcePath,
			results,
		});

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

	if (modeCount !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode: {agent, task}, {tasks}, or {chain}.\n\nRoster:\n${rosterSummary(config)}`,
				},
			],
			details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
		};
	}

	// --- chain mode ---------------------------------------------------------
	if (params.chain && params.chain.length > 0) {
		const unknown = params.chain.filter((s: any) => !findAgent(config, s.agent)).map((s: any) => s.agent);
		if (unknown.length > 0) {
			return {
				content: [{ type: "text", text: `Unknown agent(s): ${unknown.join(", ")}.\n\nRoster:\n${rosterSummary(config)}` }],
				details: makeDetails("chain")([]),
			};
		}

		const results: AgentRunResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			const taskWithContext = String(step.task).replace(/\{previous\}/g, previousOutput);

			const chainUpdate = onUpdate
				? (partial: AgentToolResult<TeamDispatchDetails>) => {
						const current = partial.details.results[0];
						if (current) {
							onUpdate({
								content: partial.content,
								details: makeDetails("chain")([...results, current]),
							});
						}
					}
				: undefined;

			const agent = findAgent(config, step.agent)!;
			const result = await runAgent({
				cwd: step.cwd ?? ctx.cwd,
				config,
				agent,
				task: taskWithContext,
				step: i + 1,
				signal,
				onUpdate: chainUpdate,
				dispatchDefaults,
			});
			results.push(result);

			if (isFailedResult(result)) {
				return {
					content: [
						{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` },
					],
					details: makeDetails("chain")(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}

		return {
			content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
			details: makeDetails("chain")(results),
		};
	}

	// --- parallel mode --------------------------------------------------------
	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > MAX_PARALLEL_TASKS) {
			return {
				content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
				details: makeDetails("parallel")([]),
			};
		}
		const unknown = params.tasks.filter((t: any) => !findAgent(config, t.agent)).map((t: any) => t.agent);
		if (unknown.length > 0) {
			return {
				content: [{ type: "text", text: `Unknown agent(s): ${unknown.join(", ")}.\n\nRoster:\n${rosterSummary(config)}` }],
				details: makeDetails("parallel")([]),
			};
		}

		const concurrency = Math.max(
			1,
			Math.min(config.defaults.max_concurrent_agents ?? DEFAULT_CONCURRENCY, MAX_PARALLEL_TASKS),
		);

		const allResults: AgentRunResult[] = new Array(params.tasks.length);
		for (let i = 0; i < params.tasks.length; i++) {
			const t = params.tasks[i];
			allResults[i] = {
				agentId: t.agent,
				role: findAgent(config, t.agent)?.role ?? "?",
				task: t.task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		}

		const emitParallelUpdate = () => {
			if (onUpdate) {
				const running = allResults.filter((r) => r.exitCode === -1).length;
				const done = allResults.length - running;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeDetails("parallel")([...allResults]),
				});
			}
		};

		const results = await mapWithConcurrencyLimit(params.tasks, concurrency, async (t: any, index: number) => {
			const result = await runAgent({
				cwd: t.cwd ?? ctx.cwd,
				config,
				agent: findAgent(config, t.agent)!,
				task: t.task,
				signal,
				onUpdate: (partial) => {
					const current = partial.details.results[0];
					if (current) {
						allResults[index] = current;
						emitParallelUpdate();
					}
				},
				dispatchDefaults,
			});
			allResults[index] = result;
			emitParallelUpdate();
			return result;
		});

		const successCount = results.filter((r) => !isFailedResult(r)).length;
		const summaries = results.map((r) => {
			const status = isFailedResult(r)
				? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
				: "completed";
			return `### [${r.agentId}] ${status}\n\n${truncateOutput(getResultOutput(r))}`;
		});
		return {
			content: [
				{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` },
			],
			details: makeDetails("parallel")(results),
		};
	}

	// --- single mode ----------------------------------------------------------
	const agent = findAgent(config, params.agent);
	if (!agent) {
		return {
			content: [{ type: "text", text: `Unknown agent "${params.agent}".\n\nRoster:\n${rosterSummary(config)}` }],
			details: makeDetails("single")([]),
		};
	}

	const result = await runAgent({
		cwd: params.cwd ?? ctx.cwd,
		config,
		agent,
		task: params.task,
		signal,
		onUpdate,
		dispatchDefaults,
	});

	if (isFailedResult(result)) {
		return {
			content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
			details: makeDetails("single")([result]),
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
		details: makeDetails("single")([result]),
	};
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function teamExtension(pi: ExtensionAPI) {
	// Load once at registration so the tool description and prompt guidelines
	// reflect the roster. Executions reload the config fresh each time.
	const initial = loadFor(process.cwd());

	const descriptionAgents = initial.config
		? initial.config.agents
				.map((a) => `${a.id} (${a.role}, ${a.resolvedModel ?? a.model ?? "session model"})`)
				.join("; ")
		: "none (create .slai/team.yaml)";

	const guidelines: string[] = [];
	if (initial.config) {
		guidelines.push(
			"Delegate specialized work to team agents with the team tool instead of doing it all yourself; give each agent a self-contained task with the context it needs.",
			"Use chain mode for multi-step work ({previous} inserts the prior step's output) and parallel mode for independent tasks, such as polling several focus-group personas at once.",
		);
		if (initial.config.defaults.require_review) {
			guidelines.push("This project requires review: route implementation through a reviewer or the principal engineer before declaring work done.");
		}
	}

	pi.registerTool({
		name: "team",
		label: "Team",
		description: [
			"Delegate tasks to your team of agents. Each agent runs in its own pi subprocess with its own model, role system prompt, and tool permissions, defined in .slai/team.yaml.",
			"Modes: single ({agent, task}), parallel ({tasks: [...]}), chain ({chain: [...]} with a {previous} placeholder).",
			`Agents: ${descriptionAgents}.`,
		].join(" "),
		promptSnippet: "delegate tasks to the configured team of agents",
		promptGuidelines: guidelines.length > 0 ? guidelines : undefined,
		parameters: TeamParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const load = loadFor(ctx.cwd);
			if (!load.config) {
				return {
					content: [{ type: "text", text: configErrorMessage(load) }],
					details: { mode: "single", configPath: null, results: [] },
					isError: true,
				};
			}

			let warningPrefix = "";
			if (load.warnings.length > 0) {
				warningPrefix = `Config warnings (from ${load.config.sourcePath}):\n${load.warnings.map((w) => `- ${w}`).join("\n")}\n\n`;
			}

			try {
				const result = await dispatch(load, params, ctx, signal, onUpdate);
				const text = warningPrefix + result.content[0].text;
				return {
					content: [{ type: "text", text }],
					details: result.details,
					isError: result.isError,
					usage: aggregateUsage(result.details.results),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `${warningPrefix}Team dispatch failed: ${message}` }],
					details: { mode: "single", configPath: load.config.sourcePath, results: [] },
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			return renderTeamCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderTeamResult(result, options.expanded, theme);
		},
	});

	pi.registerCommand("team", {
		description: "Show the agent team roster from .slai/team.yaml",
		getArgumentCompletions: (prefix) => {
			const options = ["reload", "run"];
			for (const a of initial.config?.agents ?? []) options.push(a.id);
			const filtered = options.filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts[0] === "reload") {
				ctx.ui.notify("Reloading extensions and team config...", "info");
				await ctx.reload();
				return;
			}

			if (parts[0] === "run") {
				await handleTeamRun(parts.slice(1), ctx);
				return;
			}

			const load = loadFor(ctx.cwd);
			if (!load.config) {
				ctx.ui.notify(configErrorMessage(load), "error");
				return;
			}

			const header = `Team: ${load.config.agents.length} agents · ${load.config.sourcePath}`;
			const lines = [header, ...rosterLines(load.config)];
			if (load.warnings.length > 0) {
				lines.push("", "Warnings:", ...load.warnings.map((w) => `! ${w}`));
			}

			if (ctx.hasUI) {
				await ctx.ui.select("Team Roster", lines);
			} else {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});

	async function handleTeamRun(parts: string[], ctx: ExtensionCommandContext) {
		if (parts.length < 2) {
			ctx.ui.notify('Usage: /team run <agent-id> <task...>', "warning");
			return;
		}
		const [agentId, ...taskWords] = parts;
		const task = taskWords.join(" ");

		const load = loadFor(ctx.cwd);
		if (!load.config) {
			ctx.ui.notify(configErrorMessage(load), "error");
			return;
		}
		if (!findAgent(load.config, agentId)) {
			ctx.ui.notify(`Unknown agent "${agentId}". Roster:\n${rosterSummary(load.config)}`, "error");
			return;
		}

		await pi.sendUserMessage(
			`Dispatch this task to team agent "${agentId}" using the team tool (single mode), then relay its report to me:\n\n${task}`,
		);
	}
}

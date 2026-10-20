/**
 * Subprocess runner for team agents.
 *
 * Each dispatch spawns a fresh `pi --mode json -p --no-session` process with
 * the agent's resolved model, tool permissions, and system prompt. The JSON
 * event stream is parsed to collect messages, usage, and turn counts; turn
 * caps and aborts kill the child process.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { TeamAgent, TeamConfig } from "./config.ts";
import { buildAgentSystemPrompt, toolPermissionArgs } from "./roles.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	contextTokens: number;
	turns: number;
}

export interface AgentRunResult {
	agentId: string;
	role: string;
	task: string;
	/** Process exit code; -1 while still running. */
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** 1-based position in a chain. */
	step?: number;
	durationMs?: number;
}

export interface TeamDispatchDetails {
	mode: "single" | "parallel" | "chain";
	configPath: string | null;
	results: AgentRunResult[];
}

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: string;
}

export interface RunAgentOptions {
	cwd: string;
	config: TeamConfig;
	agent: TeamAgent;
	task: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: (partial: AgentToolResult<TeamDispatchDetails>) => void;
	dispatchDefaults?: DispatchDefaults;
}

function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		contextTokens: 0,
		turns: 0,
	};
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: AgentRunResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "max_turns"
	);
}

export function getResultOutput(result: AgentRunResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/** Resolve how to invoke pi from within this process. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function writePromptToTempFile(agentId: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-"));
	const safeName = agentId.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `system-prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/** Run one agent on one task. Never throws; failures are reported on the result. */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
	const { cwd, config, agent, task, step, signal, onUpdate, dispatchDefaults } = options;

	const inheritsDispatchConfig = !agent.resolvedModel;
	const model = agent.resolvedModel ?? dispatchDefaults?.model;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);

	const thinking = agent.thinking ?? config.defaults.thinking ?? (inheritsDispatchConfig ? dispatchDefaults?.thinkingLevel : undefined);
	if (thinking) args.push("--thinking", thinking);

	args.push(...toolPermissionArgs(agent));

	const maxTurns = agent.max_turns ?? config.defaults.max_turns_per_task;

	const result: AgentRunResult = {
		agentId: agent.id,
		role: agent.role,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model,
		step,
	};

	const startedAt = Date.now();
	const emitUpdate = () => {
		result.durationMs = Date.now() - startedAt;
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
				details: { mode: "single", configPath: config.sourcePath, results: [result] },
			});
		}
	};

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		const systemPrompt = buildAgentSystemPrompt(agent, config);
		if (systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.id, systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// "--" guards against tasks that begin with "-".
		args.push("--", `Task: ${task}`);

		let wasAborted = false;
		let exceededTurns = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost.input += usage.cost?.input || 0;
							result.usage.cost.output += usage.cost?.output || 0;
							result.usage.cost.cacheRead += usage.cost?.cacheRead || 0;
							result.usage.cost.cacheWrite += usage.cost?.cacheWrite || 0;
							result.usage.cost.total += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;

						// Enforce the turn cap: kill the child once the agent
						// exceeds its allowance for this task.
						if (maxTurns && result.usage.turns > maxTurns && proc.exitCode === null) {
							exceededTurns = true;
							result.stopReason = "max_turns";
							result.errorMessage = `Exceeded max turns (${maxTurns}); agent was stopped.`;
							proc.kill("SIGTERM");
						}
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				result.stderr += `\nFailed to spawn: ${invocation.command} ${invocation.args.join(" ")}`;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					result.stopReason = "aborted";
					result.errorMessage = "Agent run was aborted.";
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exceededTurns || wasAborted ? 1 : exitCode;
		result.durationMs = Date.now() - startedAt;
		return result;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

/** Map items over an async worker pool with a fixed concurrency limit. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Sum usage across agent runs, for the tool result's `usage` field. */
export function aggregateUsage(results: AgentRunResult[]): Usage | undefined {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.totalTokens += r.usage.contextTokens;
		total.cost.input += r.usage.cost.input;
		total.cost.output += r.usage.cost.output;
		total.cost.cacheRead += r.usage.cost.cacheRead;
		total.cost.cacheWrite += r.usage.cost.cacheWrite;
		total.cost.total += r.usage.cost.total;
	}
	const any =
		total.input || total.output || total.cacheRead || total.cacheWrite || total.totalTokens || total.cost.total;
	return any ? total : undefined;
}

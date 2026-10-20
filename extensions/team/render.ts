/**
 * TUI rendering for team tool calls and results.
 *
 * Collapsed view shows a status line per agent with its recent activity;
 * expanded view (Ctrl+O) shows the full task, tool calls, and the final
 * report rendered as Markdown.
 */

import * as os from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { formatReadLineRange, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, TeamDispatchDetails, UsageStats } from "./runner.ts";
import { getFinalOutput, isFailedResult } from "./runner.ts";

const COLLAPSED_ITEM_COUNT = 8;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) text += themeFg("warning", lineRange);
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function renderDisplayItems(
	items: DisplayItem[],
	limit: number | undefined,
	theme: Theme,
): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

function agentHeader(r: AgentRunResult, theme: Theme): string {
	const meta: string[] = [r.role];
	if (r.model) meta.push(r.model);
	return `${theme.fg("toolTitle", theme.bold(r.agentId))}${theme.fg("muted", ` (${meta.join(" · ")})`)}`;
}

function statusIcon(r: AgentRunResult, theme: Theme): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	return isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function resultFooter(r: AgentRunResult, theme: Theme): string {
	const parts: string[] = [];
	if (r.durationMs) parts.push(formatDuration(r.durationMs));
	const usage = formatUsageStats(r.usage);
	if (usage) parts.push(usage);
	return parts.join("  ");
}

function renderAgentBlock(r: AgentRunResult, theme: Theme): Text {
	const items = getDisplayItems(r.messages);
	let text = `${statusIcon(r, theme)} ${agentHeader(r, theme)}`;
	if (isFailedResult(r) && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	if (isFailedResult(r) && r.errorMessage) text += `\n${theme.fg("error", r.errorMessage)}`;
	if (items.length === 0) {
		text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
	} else {
		const rendered = renderDisplayItems(items, COLLAPSED_ITEM_COUNT, theme);
		if (rendered) text += `\n${rendered}`;
	}
	const footer = resultFooter(r, theme);
	if (footer) text += `\n${theme.fg("dim", footer)}`;
	return new Text(text, 0, 0);
}

function renderAgentBlockExpanded(r: AgentRunResult, theme: Theme): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(new Text(`${statusIcon(r, theme)} ${agentHeader(r, theme)}`, 0, 0));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
	container.addChild(new Spacer(1));

	const items = getDisplayItems(r.messages);
	if (items.length === 0) {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	} else {
		for (const item of items) {
			if (item.type === "toolCall") {
				container.addChild(
					new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
				);
			}
		}
		const finalOutput = getFinalOutput(r.messages);
		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}
	}

	const footer = resultFooter(r, theme);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 0, 0));
	}
	return container;
}

export function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

/** Render the tool call (before/during execution). */
export function renderTeamCall(args: any, theme: Theme): Component {
	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", `chain (${args.chain.length} steps)`);
		for (let i = 0; i < Math.min(args.chain.length, 4); i++) {
			const step = args.chain[i];
			const cleanTask = String(step.task || "").replace(/\{previous\}/g, "").trim();
			const preview = cleanTask.length > 44 ? `${cleanTask.slice(0, 44)}...` : cleanTask;
			text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.chain.length > 4) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 4} more`)}`;
		return new Text(text, 0, 0);
	}

	if (args.tasks && args.tasks.length > 0) {
		let text = theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
		for (const t of args.tasks.slice(0, 4)) {
			const preview = String(t.task || "").length > 44 ? `${String(t.task).slice(0, 44)}...` : String(t.task || "");
			text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.tasks.length > 4) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 4} more`)}`;
		return new Text(text, 0, 0);
	}

	const agentName = args.agent || "...";
	const task = String(args.task || "");
	const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
	let text = theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", agentName);
	if (preview) text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

/** Render the tool result (or a streaming partial). */
export function renderTeamResult(
	result: AgentToolResult<any>,
	expanded: boolean,
	theme: Theme,
): Component {
	const details = result.details;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	if (expanded) {
		const container = new Container();
		for (const r of details.results) {
			if (container.children.length > 0) container.addChild(new Spacer(1));
			if (r.step !== undefined) {
				container.addChild(new Text(theme.fg("muted", `─── Step ${r.step} ───`), 0, 0));
			}
			container.addChild(renderAgentBlockExpanded(r, theme));
		}
		return container;
	}

	const container = new Container();
	for (const r of details.results) {
		if (container.children.length > 0) container.addChild(new Spacer(1));
		container.addChild(renderAgentBlock(r, theme));
	}
	if (details.results.length === 1) return container.children[0];
	return container;
}

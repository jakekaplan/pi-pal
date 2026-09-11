import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import sharp from "sharp";
import lockfile from "proper-lockfile";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const sheet = await sharp({ create: { width: 1008, height: 672, channels: 3, background: "#ddd" } }).png().toBuffer();
export const signal = () => new AbortController().signal;

export async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for the pal's background update");
		await delay(10);
	}
}

export async function loadPal(t: Pick<TestContext, "after">, agentDir?: string) {
	if (!agentDir) {
		agentDir = await fs.mkdtemp(path.join(tmpdir(), "pi-pal-test-"));
		const temporary = agentDir;
		t.after(() => fs.rm(temporary, { recursive: true, force: true }));
		await fs.writeFile(path.join(agentDir, "pi-pal.json"), JSON.stringify({ description: "a small robot", enabled: true }));
	}
	const model = {
		output: '{"id":"happy"}', stopReason: "stop", available: true, calls: [] as any[],
		beforeComplete: undefined as (() => Promise<void>) | undefined,
	};
	const image = { status: 200, calls: [] as any[] };
	const io = {
		beforeWrite: undefined as ((file: string) => void | Promise<void>) | undefined,
		beforeRemove: undefined as ((file: string) => void | Promise<void>) | undefined,
		beforeLock: undefined as ((file: string, options: lockfile.LockOptions) => void) | undefined,
	};
	const notifications: { text: string; level: string }[] = [];
	const displayed: string[] = [];
	const labels: string[] = [];
	const dialogs = {
		choices: [] as (number | string | undefined)[],
		inputs: [] as (string | undefined)[],
		confirmations: [] as boolean[],
		shown: [] as { kind: string; title: string; options?: string[]; message?: string }[],
	};
	const capabilities: { images: "kitty" | null } = { images: "kitty" };
	const pngs: { data: string; mimeType: string; imageId: number; invalidations: number }[] = [];
	const overlays: { anchor: string; hidden: boolean; nonCapturing: boolean; visible: (width: number, height: number) => boolean }[] = [];
	const timers = new Map<object, { callback: () => void; interval: number }>();
	const handlers = new Map<string, (...args: any[]) => any>();
	let command: any;
	let widget: any;
	let panel: { render(width: number): string[] } | undefined;
	let progress = "";
	let updates = 0;
	const queues = new Map<string, Promise<unknown>>();
	const pi = {
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerCommand: (_name: string, definition: any) => { command = definition; },
	};
	const tui = {
		showOverlay: (component: { render(width: number): string[] }, options: Omit<typeof overlays[number], "hidden">) => {
			panel = component;
			const overlay = { ...options, hidden: false };
			overlays.push(overlay);
			return { hide() {
				overlay.hidden = true;
				if (panel === component) panel = undefined;
			} };
		},
		requestRender: () => {
			if (!widget || !panel) return;
			const lines = panel.render(26);
			const next = stripVTControlCharacters(lines.at(-2) ?? "").slice(1, -1).trim();
			if (next === progress) return;
			labels.push(next);
			if (!["●··", "·●·", "··●", "Update failed"].includes(next)) {
				updates++;
				displayed.push(lines.slice(1, -2).join("\n"));
			}
			progress = next;
		},
	};
	const ctx = {
		mode: "tui",
		cwd: path.join(agentDir, "project"),
		sessionManager: { getBranch: () => branch },
		modelRegistry: {
			find: () => model.available ? {} : undefined,
			complete: async (_model: unknown, input: unknown, options: unknown) => {
				model.calls.push({ input, options });
				await model.beforeComplete?.();
				return { stopReason: model.stopReason, content: [{ type: "text", text: model.output }] };
			},
			getProviderAuth: async () => ({ auth: { apiKey: `header.${Buffer.from(JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "test" },
			})).toString("base64url")}.signature` } }),
		},
		ui: {
			select: async (title: string, options: string[]) => {
				dialogs.shown.push({ kind: "select", title, options });
				const choice = dialogs.choices.shift();
				const selected = typeof choice === "number" ? options[choice] : choice;
				if (choice !== undefined) assert.ok(selected !== undefined && options.includes(selected), `Invalid menu choice: ${choice}`);
				return selected;
			},
			input: async (title: string) => {
				dialogs.shown.push({ kind: "input", title });
				return dialogs.inputs.shift();
			},
			confirm: async (title: string, message: string) => {
				dialogs.shown.push({ kind: "confirm", title, message });
				return dialogs.confirmations.shift() ?? false;
			},
			notify: (text: string, level: string) => notifications.push({ text, level }),
			setWidget: (_name: string, factory: any) => {
				widget?.dispose();
				widget = factory?.(tui, { fg: (_color: string, text: string) => text });
			},
		},
	};
	let branch: any[] = [];
	function settleReply(text: string) {
		branch = [{ id: crypto.randomUUID(), type: "message", message: {
			role: "assistant", stopReason: "stop", content: [{ type: "text", text }],
		} }];
		handlers.get("agent_settled")!({}, ctx);
	}
	const imports = {
		"node:crypto": crypto,
		"node:fs/promises": {
			...fs,
			writeFile: async (file: any, ...args: any[]) => {
				await io.beforeWrite?.(String(file));
				return (fs.writeFile as any)(file, ...args);
			},
			rm: async (file: any, ...args: any[]) => {
				await io.beforeRemove?.(String(file));
				return (fs.rm as any)(file, ...args);
			},
		},
		"node:path": path,
		"@earendil-works/pi-coding-agent": {
			getAgentDir: () => agentDir,
			withFileMutationQueue: async (file: string, fn: () => Promise<unknown>) => {
				const pending = (queues.get(file) ?? Promise.resolve()).then(fn);
				queues.set(file, pending.catch(() => {}));
				return pending;
			},
		},
		"@earendil-works/pi-tui": {
			allocateImageId: () => 1,
			getCapabilities: () => capabilities,
			Image: class {
				image: typeof pngs[number];
				constructor(data: string, mimeType: string, _theme: unknown, options: { imageId: number }) {
					this.image = { data, mimeType, imageId: options.imageId, invalidations: 0 };
					pngs.push(this.image);
				}
				render() { return [`png ${crypto.createHash("sha256").update(this.image.data).digest("hex").slice(0, 8)}`]; }
				invalidate() { this.image.invalidations++; }
			},
			visibleWidth: (text: string) => stripVTControlCharacters(text).length,
			// Test labels and image placeholders use single-cell characters.
			truncateToWidth: (text: string, width: number, ellipsis = "…") => {
				const plain = stripVTControlCharacters(text);
				return plain.length <= width ? text : plain.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis.slice(0, width);
			},
		},
		sharp: { default: sharp },
		"proper-lockfile": { default: {
			lock: (file: string, options: lockfile.LockOptions) => {
				io.beforeLock?.(file, options);
				return lockfile.lock(file, options);
			},
		} },
	};
	const context = createContext({
		Buffer, Error, URL, AbortSignal, AbortController,
		setInterval: (callback: () => void, interval: number) => {
			const timer = { unref() {} };
			timers.set(timer, { callback, interval });
			return timer;
		},
		clearInterval: (timer: object) => timers.delete(timer),
		fetch: async (_url: string, options: any) => {
			image.calls.push(JSON.parse(options.body));
			return image.status === 200
				? Response.json({ data: [{ b64_json: sheet.toString("base64") }] })
				: new Response("", { status: image.status });
		},
	});
	// Load real module exports, mocking only the Pi host and external I/O boundaries.
	const modules = new Map<string, Promise<SourceTextModule>>();
	function loadModule(url: URL): Promise<SourceTextModule> {
		let pending = modules.get(url.href);
		if (!pending) {
			pending = fs.readFile(url, "utf8").then((source) => new SourceTextModule(stripTypeScriptTypes(source), {
				context,
				identifier: url.href,
				initializeImportMeta: (meta) => { meta.url = url.href; },
			}));
			modules.set(url.href, pending);
		}
		return pending;
	}
	const module = await loadModule(new URL("./index.ts", import.meta.url));
	await module.link(async (specifier, parent) => {
		if (specifier.startsWith(".")) return loadModule(new URL(specifier, parent.identifier));
		const values = imports[specifier as keyof typeof imports];
		assert.ok(values, `Unexpected import: ${specifier}`);
		return new SyntheticModule(Object.keys(values), function () {
			for (const [name, value] of Object.entries(values)) this.setExport(name, value);
		}, { context });
	});
	await module.evaluate();
	const api = {
		...(await loadModule(new URL("./emotions.ts", import.meta.url))).namespace,
		...(await loadModule(new URL("./sprites.ts", import.meta.url))).namespace,
		...(await loadModule(new URL("./settings.ts", import.meta.url))).namespace,
		...(await loadModule(new URL("./pal.ts", import.meta.url))).namespace,
		...(await loadModule(new URL("./file-lock.ts", import.meta.url))).namespace,
	} as typeof import("./emotions.ts") & typeof import("./sprites.ts") & typeof import("./settings.ts") & typeof import("./pal.ts") & typeof import("./file-lock.ts");
	(module.namespace as { default: (pi: unknown) => void }).default(pi);
	await handlers.get("session_start")!({}, ctx);
	t.after(() => handlers.get("session_shutdown")!({}, ctx));
	return {
		api, agentDir, model, image, io, notifications, displayed, labels, settleReply, timers, dialogs, capabilities, pngs, overlays,
		// The mock implements only the host capabilities exercised by this extension.
		ctx: ctx as unknown as ExtensionContext,
		tick: () => { for (const { callback } of [...timers.values()]) callback(); },
		catalog: path.join(agentDir, "pi-pal", "custom-emotions.json"),
		legacy: path.join(agentDir, "pi-pal", "emotions.json"),
		sprites: path.join(agentDir, "pi-pal", "sprites"),
		render: (width = 26): string[] => panel?.render(width) ?? [],
		layout: (): string[] => widget?.render(40) ?? [],
		command: (input: string) => command.handler(input, ctx),
		async act(input: string) {
			const previous = updates;
			await command.handler(input, ctx);
			await waitFor(() => updates > previous);
		},
		async reply(text: string) {
			const previous = updates;
			settleReply(text);
			await waitFor(() => updates > previous);
		},
	};
}

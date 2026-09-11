import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { showPal, type Pal } from "./pal.ts";
import { addEmotion, readEmotions, resetEmotions, selectEmotion } from "./emotions.ts";
import { parseSettings, readSettings, saveSettings, showSettings, type Action, type Settings } from "./settings.ts";
import { clearSprites, generateSprite, readSprite, spriteKey } from "./sprites.ts";

interface Reaction {
	text: string;
	source: "reply" | "action";
	description: string;
	ctx: ExtensionContext;
}

function latestReply(ctx: ExtensionContext): { id: string; text: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") return;
		if (message.role !== "assistant") continue;
		if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) return;
		const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
		return text ? { id: entry.id, text } : undefined;
	}
}

export default function piPal(pi: ExtensionAPI) {
	let settings: Settings = { description: "", enabled: false, position: "bottom-right" };
	let live = false;
	let lastReply: string | undefined;
	let queued: Reaction | undefined;
	let active: AbortController | undefined;
	let running = false;
	let draining = Promise.resolve();
	let paused = false;
	let pal: Pal | undefined;

	function cancel() {
		queued = undefined;
		active?.abort();
		pal?.hide();
		pal = undefined;
	}

	async function withReactionsPaused(ctx: ExtensionContext, change: (signal: AbortSignal) => Promise<void>) {
		if (paused) throw new Error("Updating settings. Try again shortly.");
		paused = true;
		cancel();
		try {
			await draining;
			if (!live) return;
			const controller = new AbortController();
			active = controller;
			try {
				await change(controller.signal);
			} finally {
				controller.abort();
				active = undefined;
			}
		} finally {
			if (live) lastReply = latestReply(ctx)?.id;
			paused = false;
		}
	}

	async function apply(action: Action, ctx: ExtensionContext): Promise<void> {
		if (paused) throw new Error("Updating settings. Try again shortly.");
		switch (action.type) {
			case "enabled":
				if (!action.enabled) {
					settings.enabled = false;
					cancel();
				}
				settings = await saveSettings({ enabled: action.enabled });
				lastReply = latestReply(ctx)?.id;
				ctx.ui.notify(action.enabled ? "Automatic reactions on." : "Automatic reactions off.", "info");
				return;
			case "avatar": {
				const next = parseSettings({ ...settings, description: action.description, enabled: true });
				const changed = next.description !== settings.description;
				await withReactionsPaused(ctx, async () => {
					if (changed) await clearSprites();
					settings = await saveSettings({ description: next.description, enabled: true });
					ctx.ui.notify(changed ? "Avatar saved. Images cleared." : "Avatar saved.", "info");
				});
				return;
			}
			case "position":
				settings = await saveSettings({ position: action.position });
				pal?.move(settings.position);
				return;
			case "reset-emotions":
				await withReactionsPaused(ctx, async (signal) => {
					await resetEmotions(signal);
					ctx.ui.notify("Custom emotions reset.", "info");
				});
				return;
			case "clear-images":
				await withReactionsPaused(ctx, async () => {
					await clearSprites();
					ctx.ui.notify("Images cleared.", "info");
				});
				return;
		}
	}

	async function drain() {
		try {
			while (live && queued) {
				const reaction = queued;
				queued = undefined;
				const ctx = reaction.ctx;
				const controller = new AbortController();
				active = controller;
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
				const current = () => live && !signal.aborted;
				try {
					pal ??= showPal(ctx, settings.position);
					pal.update({ status: "loading" });
					const emotions = await readEmotions(signal);
					const selected = (reaction.source === "action" ? emotions.find((entry) => entry.id === reaction.text) : undefined)
						?? await selectEmotion(reaction.text, reaction.source, emotions, ctx, signal);
					if (!current() || queued) continue;
					const emotion = emotions.some((entry) => entry.id === selected.id) ? selected : await addEmotion(selected, signal);
					if (!current() || queued) continue;
					let sprite = await readSprite(spriteKey(reaction.description, emotion), signal);
					// Skip superseded selections, but always display an image once generation has started.
					if (!current() || queued) continue;
					if (!sprite) sprite = await generateSprite(reaction.description, emotion, ctx, signal);
					signal.throwIfAborted();
					if (!current()) continue;
					pal.update({ status: "ready", emotion: emotion.id, frames: sprite.frames });
					if (reaction.source === "action") ctx.ui.notify(`Pi Pal ${emotion.id}: ${sprite.directory}`, "info");
					if (!getCapabilities().images) ctx.ui.notify("This terminal cannot display images. PNGs are saved on disk.", "warning");
				} catch (error) {
					if (live && !controller.signal.aborted) {
						const message = signal.aborted ? "Timed out after three minutes; no retry was made."
							: error instanceof Error ? error.message : "Generation failed.";
						pal?.update({ status: "failed" });
						ctx.ui.notify(`Pi Pal: ${message}`, "warning");
					}
				} finally {
					controller.abort();
					active = undefined;
				}
			}
		} finally {
			running = false;
		}
	}

	function enqueue(text: string, source: Reaction["source"], ctx: ExtensionContext) {
		if (paused) return;
		queued = { text, source, ctx, description: settings.description };
		if (running) return;
		running = true;
		// Never return this promise to an agent event: chat must not wait for the avatar.
		draining = drain().catch((error: unknown) => {
			if (live) {
				pal?.update({ status: "failed" });
				ctx.ui.notify(`Pi Pal: ${error instanceof Error ? error.message : "Background update failed."}`, "warning");
			}
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		live = ctx.mode === "tui";
		if (!live) return;
		lastReply = latestReply(ctx)?.id;
		try {
			settings = await readSettings();
		} catch (error) {
			ctx.ui.notify(`Pi Pal: ${error instanceof Error ? error.message : "Could not read settings."}`, "warning");
		}
	});

	pi.on("session_shutdown", () => {
		live = false;
		cancel();
	});

	pi.on("session_tree", (_event, ctx) => {
		cancel();
		lastReply = latestReply(ctx)?.id;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!live || !settings.enabled) return;
		const reply = latestReply(ctx);
		if (!reply || reply.id === lastReply) return;
		lastReply = reply.id;
		enqueue(reply.text, "reply", ctx);
	});

	pi.registerCommand("pi-pal", {
		description: "Open Pi Pal settings, or react with <emotion ID or action>. Shortcuts: default <description> | on | stop",
		handler: async (args, ctx) => {
			if (!live || ctx.mode !== "tui") {
				ctx.ui.notify("Pi Pal requires Pi's interactive TUI.", "error");
				return;
			}
			if (paused) {
				ctx.ui.notify("Updating settings. Try again shortly.", "info");
				return;
			}
			const input = args.trim();
			if (!input) {
				while (live) {
					try {
						const action = await showSettings(ctx, settings);
						if (!action || !live) return;
						await apply(action, ctx);
					} catch (error) {
						ctx.ui.notify(`Pi Pal: ${error instanceof Error ? error.message : "Could not update settings."}`, "error");
					}
				}
				return;
			}
			try {
				if (input === "stop" || input === "on") {
					await apply({ type: "enabled", enabled: input === "on" }, ctx);
					return;
				}
				if (input === "default" || input.startsWith("default ")) {
					const description = (input.slice(7).trim() || await ctx.ui.input("Avatar appearance", settings.description))?.trim();
					if (description) await apply({ type: "avatar", description }, ctx);
					return;
				}
				if (!settings.description) throw new Error("Choose an avatar first using /pi-pal.");
				enqueue(input, "action", ctx);
				ctx.ui.notify("Updating pal…", "info");
			} catch (error) {
				ctx.ui.notify(`Pi Pal: ${error instanceof Error ? error.message : "Command failed."}`, "error");
			}
		},
	});
}

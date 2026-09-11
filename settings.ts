import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileLock } from "./file-lock.ts";

const FILE = join(getAgentDir(), "pi-pal.json");
const positions = [
	{ value: "top-left", label: "Top left" },
	{ value: "top-right", label: "Top right" },
	{ value: "bottom-left", label: "Bottom left" },
	{ value: "bottom-right", label: "Bottom right" },
] as const;

export type Position = typeof positions[number]["value"];

export interface Settings {
	description: string;
	enabled: boolean;
	position: Position;
}

export type Action =
	| { type: "enabled"; enabled: boolean }
	| { type: "avatar"; description: string }
	| { type: "position"; position: Position }
	| { type: "reset-emotions" }
	| { type: "clear-images" };

export function parseSettings(value: unknown): Settings {
	if (!value || typeof value !== "object" ||
		!("description" in value) || typeof value.description !== "string" || value.description.length > 2000 ||
		!("enabled" in value) || typeof value.enabled !== "boolean") {
		throw new Error(`Invalid Pi Pal settings in ${FILE}. Keep the avatar description under 2,000 characters.`);
	}
	const description = value.description.trim();
	if (value.enabled && !description) throw new Error("Choose an avatar first using /pi-pal.");
	const savedPosition = "position" in value ? value.position : "bottom-right";
	// Preferences saved during the dock experiment map back to the bottom corners.
	const corner = savedPosition === "left" ? "bottom-left" : savedPosition === "right" ? "bottom-right" : savedPosition;
	const position = positions.find((entry) => entry.value === corner)?.value;
	if (!position) throw new Error(`Invalid Pi Pal position in ${FILE}. Choose one of the four corners.`);
	return { description, enabled: value.enabled, position };
}

export async function readSettings(): Promise<Settings> {
	let text: string;
	try {
		text = await readFile(FILE, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { description: "", enabled: false, position: "bottom-right" };
		throw error;
	}
	return parseSettings(JSON.parse(text));
}

export async function saveSettings(change: Partial<Settings>): Promise<Settings> {
	return withFileLock(FILE, async (signal) => {
		const settings = parseSettings({ ...await readSettings(), ...change });
		const temporary = join(getAgentDir(), `.pi-pal-${randomUUID()}.json`);
		try {
			await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600, signal });
			signal.throwIfAborted();
			await rename(temporary, FILE);
		} finally {
			await rm(temporary, { force: true });
		}
		return settings;
	});
}

export async function showSettings(ctx: ExtensionContext, settings: Settings): Promise<Action | undefined> {
	const items = [
		{ id: "enabled", label: `Automatic reactions: ${settings.enabled ? "On" : "Off"}` },
		{ id: "avatar", label: `Avatar: ${settings.description || "Not set"}` },
		{ id: "position", label: `Position: ${positions.find((entry) => entry.value === settings.position)!.label}` },
		{ id: "reset-emotions", label: "Reset custom emotions…" },
		{ id: "clear-images", label: "Clear cached images…" },
	] as const;
	while (true) {
		const selected = await ctx.ui.select("Pi Pal settings", items.map((item) => item.label));
		const choice = items.find((item) => item.label === selected)?.id;
		switch (choice) {
			case undefined:
				return;
			case "enabled":
				return { type: "enabled", enabled: !settings.enabled };
			case "avatar": {
				const description = (await ctx.ui.input("Avatar appearance", settings.description))?.trim();
				if (!description) break;
				parseSettings({ ...settings, description, enabled: true });
				if (description !== settings.description &&
					!await ctx.ui.confirm("Change avatar?", "Old images will be cleared.")) break;
				return { type: "avatar", description };
			}
			case "position": {
				const label = await ctx.ui.select("Box position", positions.map((entry) => entry.label));
				const position = positions.find((entry) => entry.label === label)?.value;
				if (position) return { type: "position", position };
				break;
			}
			case "reset-emotions":
				if (await ctx.ui.confirm("Reset custom emotions?", "Default emotions and cached images will stay.")) {
					return { type: "reset-emotions" };
				}
				break;
			case "clear-images":
				if (await ctx.ui.confirm("Clear cached images?", "Your avatar and emotions will stay.")) {
					return { type: "clear-images" };
				}
				break;
		}
	}
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir, withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import type { Emotion } from "./emotions.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations";
const SPRITES = join(getAgentDir(), "pi-pal", "sprites");
const COLUMNS = 3;
const ROWS = 2;
// Smallest 16px-aligned square cells that keep the sheet above GPT Image 2's 655,360px minimum.
const CELL_SIZE = 336;
const SHEET_WIDTH = COLUMNS * CELL_SIZE;
const SHEET_HEIGHT = ROWS * CELL_SIZE;
const IMAGE_OPTIONS = { model: "gpt-image-2", background: "auto", quality: "low", size: `${SHEET_WIDTH}x${SHEET_HEIGHT}` };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

export interface Sprite {
	directory: string;
	frames: string[];
}

function spritePrompt(description: string, action: string): string {
	return `Create a pixelated pixel-art sprite sheet of this avatar.

AVATAR IDENTITY (always preserve): ${description}
ANIMATION ACTION (do not change the avatar's identity): ${action}

The sheet must contain exactly six successive frames of ONE seamless looping animation, in a strict 3-column by 2-row grid. Frame order is left-to-right across the top row, then left-to-right across the bottom row.
Use a ${SHEET_WIDTH} by ${SHEET_HEIGHT} canvas with six equal ${CELL_SIZE} by ${CELL_SIZE} cells. Each cell contains exactly one complete sprite, with room around it so no part crosses the cell boundary. No outer margins, gutters, grid lines, borders, labels, numbers, or text.
Keep the same character design, palette, scale, camera angle, ground baseline, and registration point in every frame. Animate in place: no camera movement or character drifting across the cells. Each frame must show a distinct successive pose, and the last must transition naturally back to the first.
Use a retro low-resolution pixel-art aesthetic: visible square pixels, hard edges, a limited palette, no antialiasing, no gradients, and no smoothing. Use the exact same solid light-gray background in every cell. No scenery or decorative elements.`;
}

export function spriteKey(description: string, emotion: Emotion): string {
	const prompt = spritePrompt(description, emotion.action);
	return createHash("sha256").update(JSON.stringify({ id: emotion.id, ...IMAGE_OPTIONS, prompt })).digest("hex");
}

function accountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error();
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof id === "string" && id.length > 0) return id;
	} catch {
		// The Codex provider uses this same claim for account routing.
	}
	throw new Error("No ChatGPT account ID in the Codex token. Run /login openai-codex and try again.");
}

async function generateSheet(prompt: string, ctx: ExtensionContext, signal: AbortSignal): Promise<Buffer> {
	const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
	signal.throwIfAborted();
	const token = resolved?.auth.apiKey;
	if (!token) throw new Error("No Codex login configured. Run /login openai-codex first.");

	const response = await fetch(ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"ChatGPT-Account-ID": accountId(token),
			"Content-Type": "application/json",
			Accept: "application/json",
			originator: "pi",
			"x-codex-image-turn-id": randomUUID(),
		},
		body: JSON.stringify({ ...IMAGE_OPTIONS, prompt }),
		signal,
		redirect: "error",
	});

	if (!response.ok) {
		await response.body?.cancel();
		const hint = response.status === 401
			? "Run /login openai-codex again."
			: response.status === 403
				? "This account may not have access to Codex image generation."
				: response.status === 429
					? "Codex image generation is rate-limited or its quota is exhausted. Try again later."
					: "The Codex image endpoint rejected the request; no automatic retry was made.";
		throw new Error(`Image generation failed (HTTP ${response.status}). ${hint}`);
	}

	if (!response.body) throw new Error("Codex returned an empty response.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_RESPONSE_BYTES) throw new Error("Codex image response exceeded 48 MiB.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}

	let payload;
	try {
		payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("Codex returned invalid JSON instead of an image.");
	}
	const base64 = payload?.data?.[0]?.b64_json;
	if (typeof base64 !== "string" || base64.length === 0 ||
		base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
		throw new Error("Codex returned no valid base64 image data.");
	}
	const bytes = Buffer.from(base64, "base64");
	if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Codex returned an image that is not a PNG.");
	return bytes;
}

export async function readSprite(key: string, signal: AbortSignal): Promise<Sprite | undefined> {
	let text: string;
	try {
		text = await readFile(join(SPRITES, `${key}.json`), { encoding: "utf8", signal });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof value?.directory !== "string" || !/^sprite-[A-Za-z0-9]+$/.test(value.directory)) return;
	const directory = join(SPRITES, value.directory);
	const frames: string[] = [];
	let size: number | undefined;
	for (let frame = 0; frame < COLUMNS * ROWS; frame++) {
		signal.throwIfAborted();
		let bytes: Buffer;
		try {
			bytes = await readFile(join(directory, `frame-${frame + 1}.png`), { signal });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return;
		try {
			const { info } = await sharp(bytes, { limitInputPixels: 16 * 1024 * 1024 }).raw().toBuffer({ resolveWithObject: true });
			if (info.width !== info.height || (size !== undefined && info.width !== size)) return;
			size = info.width;
		} catch {
			signal.throwIfAborted();
			return;
		}
		frames.push(bytes.toString("base64"));
	}
	signal.throwIfAborted();
	return { directory, frames };
}

export async function saveSprite(sheet: Buffer, key: string, signal: AbortSignal): Promise<Sprite> {
	const image = sharp(sheet, { limitInputPixels: 16 * 1024 * 1024 });
	const { width, height } = await image.metadata();
	if (!width || !height || width % COLUMNS !== 0 || height % ROWS !== 0 || width / COLUMNS !== height / ROWS) {
		throw new Error("The returned sheet must have a 3:2 aspect ratio with six equal square cells.");
	}
	const size = width / COLUMNS;
	const frames: Buffer[] = [];
	for (let frame = 0; frame < COLUMNS * ROWS; frame++) {
		signal.throwIfAborted();
		frames.push(await image.clone().extract({
			left: (frame % COLUMNS) * size,
			top: Math.floor(frame / COLUMNS) * size,
			width: size,
			height: size,
		}).png().toBuffer());
	}

	signal.throwIfAborted();
	await mkdir(SPRITES, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(SPRITES, "sprite-"));
	const manifest = join(SPRITES, `${key}.json`);
	const temporary = join(SPRITES, `.${key}-${randomUUID()}.json`);
	let published = false;
	try {
		await writeFile(join(directory, "sheet.png"), sheet, { flag: "wx", signal });
		for (const [index, frame] of frames.entries()) {
			signal.throwIfAborted();
			await writeFile(join(directory, `frame-${index + 1}.png`), frame, { flag: "wx", signal });
		}
		// Publish a pointer only after every PNG is written; existing readers keep their complete directory.
		await withFileMutationQueue(manifest, async () => {
			signal.throwIfAborted();
			await writeFile(temporary, `${JSON.stringify({ directory: basename(directory) })}\n`, { flag: "wx", mode: 0o600, signal });
			signal.throwIfAborted();
			await rename(temporary, manifest);
			published = true;
		});
		return { directory, frames: frames.map((frame) => frame.toString("base64")) };
	} finally {
		await rm(temporary, { force: true });
		if (!published) await rm(directory, { recursive: true, force: true });
	}
}

export async function generateSprite(description: string, emotion: Emotion, ctx: ExtensionContext, signal: AbortSignal): Promise<Sprite> {
	const sheet = await generateSheet(spritePrompt(description, emotion.action), ctx, signal);
	signal.throwIfAborted();
	return saveSprite(sheet, spriteKey(description, emotion), signal);
}

export async function clearSprites(): Promise<void> {
	await rm(SPRITES, { recursive: true, force: true });
}

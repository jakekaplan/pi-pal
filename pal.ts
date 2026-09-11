import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allocateImageId, getCapabilities, Image, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Position } from "./settings.ts";

const WIDGET = "pi-pal";
const FPS = 8;
const loadingFrames = ["●··", "·●·", "··●"];

type State =
	| { status: "loading" }
	| { status: "ready"; emotion: string; frames: string[] }
	| { status: "failed" };

export interface Pal {
	update(state: State): void;
	move(position: Position): void;
	hide(): void;
}

export function showPal(ctx: ExtensionContext, position: Position): Pal {
	let pal!: Pal;
	ctx.ui.setWidget(WIDGET, (tui, theme) => {
		const imageId = allocateImageId();
		let images: Image[] = [];
		let state: State = { status: "loading" };
		let frame = 0;
		let timer: ReturnType<typeof setInterval> | undefined;
		let loadingFrame = 0;
		let loadingTimer: ReturnType<typeof setInterval> | undefined;
		const panel = {
			render(width: number) {
				const innerWidth = width - 2;
				const border = (text: string) => theme.fg("border", text);
				const row = (text: string) => {
					// Pi's width scanner needs an SGR terminator after iTerm's cursor-up escape.
					text = text.replace(/^(\x1b\[\d+A)/, "$1\x1b[0m");
					return border("│") + text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text))) + border("│");
				};
				const imageLines = images.length > 0 ? images[frame].render(innerWidth)
					: Array.from({ length: 10 }, () => "");
				const label = state.status === "loading" ? loadingFrames[loadingFrame]
					: state.status === "ready" ? state.emotion : "Update failed";
				return [
					border("╭" + "─".repeat(innerWidth) + "╮"),
					...imageLines.map(row),
					row(theme.fg("muted", truncateToWidth(` ${label}`, innerWidth))),
					border("╰" + "─".repeat(innerWidth) + "╯"),
				];
			},
			invalidate() {
				for (const image of images) image.invalidate();
			},
		};
		const place = () => tui.showOverlay({ ...panel }, {
			anchor: position,
			width: 26,
			margin: { top: 1, right: 1, bottom: 6, left: 1 },
			nonCapturing: true,
			visible: (width, height) => width >= 30 && height >= 20,
		});
		let overlay = place();
		pal = {
			update(next) {
				state = next;
				if (state.status === "loading") {
					if (!loadingTimer) {
						loadingFrame = 0;
						loadingTimer = setInterval(() => {
							loadingFrame = (loadingFrame + 1) % loadingFrames.length;
							tui.requestRender();
						}, 250);
						loadingTimer.unref();
					}
				} else {
					clearInterval(loadingTimer);
					loadingTimer = undefined;
				}
				if (state.status === "ready") {
					images = state.frames.map((data) => new Image(data, "image/png", {
						fallbackColor: (text) => theme.fg("muted", text),
					}, { maxWidthCells: 22, maxHeightCells: 10, imageId }));
					frame = 0;
					if (!timer && getCapabilities().images) {
						timer = setInterval(() => {
							frame = (frame + 1) % images.length;
							// A reused Kitty image ID needs a fresh transmission on every loop.
							images[frame].invalidate();
							tui.requestRender();
						}, 1000 / FPS);
						timer.unref();
					}
				}
				tui.requestRender();
			},
			move(nextPosition) {
				if (position === nextPosition) return;
				position = nextPosition;
				overlay.hide();
				overlay = place();
				tui.requestRender();
			},
			hide() {
				ctx.ui.setWidget(WIDGET, undefined);
			},
		};
		// Keep Pi's widget lifecycle cleanup, without reserving space in the layout.
		return {
			render: () => [],
			invalidate: () => panel.invalidate(),
			dispose() {
				clearInterval(timer);
				clearInterval(loadingTimer);
				overlay.hide();
			},
		};
	});
	return pal;
}

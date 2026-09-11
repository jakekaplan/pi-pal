// Run: node --experimental-vm-modules --experimental-strip-types --test *.test.ts
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import sharp from "sharp";
import { loadPal, sheet, signal, waitFor } from "./test-host.ts";

test("bare /pi-pal opens settings and cancellation does not mutate state", async (t) => {
	const pal = await loadPal(t);
	const before = await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8");
	await pal.command("");
	assert.equal(pal.dialogs.shown[0].title, "Pi Pal settings");
	assert.equal(pal.dialogs.shown[0].options?.length, 5);
	assert.ok(pal.dialogs.shown[0].options?.includes("Position: Bottom right"));
	assert.equal(await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8"), before);
	assert.equal(pal.image.calls.length, 0);
	assert.equal(pal.model.calls.length, 0);
});

test("settings use short confirmations and status messages without quota warnings", async (t) => {
	const pal = await loadPal(t);
	pal.dialogs.choices.push(0, 0, 1, 3, 4);
	pal.dialogs.inputs.push("a small fox");
	pal.dialogs.confirmations.push(true, true, true);
	await pal.command("");
	assert.deepEqual(pal.notifications.map((notice) => notice.text), [
		"Automatic reactions off.",
		"Automatic reactions on.",
		"Avatar saved. Images cleared.",
		"Custom emotions reset.",
		"Images cleared.",
	]);
	assert.deepEqual(pal.dialogs.shown.filter((dialog) => dialog.kind === "confirm").map((dialog) => dialog.message), [
		"Old images will be cleared.",
		"Default emotions and cached images will stay.",
		"Your avatar and emotions will stay.",
	]);
});

test("settings preserve corners, migrate dock preferences, and reject invalid positions", async (t) => {
	const pal = await loadPal(t);
	assert.equal((await pal.api.readSettings()).position, "bottom-right");
	for (const corner of ["top-left", "bottom-left", "top-right", "bottom-right"]) {
		const parsed = pal.api.parseSettings({ description: "a robot", enabled: true, position: corner });
		assert.equal(parsed.position, corner);
	}
	for (const alignment of ["left", "right"]) {
		const parsed = pal.api.parseSettings({ description: "a robot", enabled: true, position: alignment });
		assert.equal(parsed.position, `bottom-${alignment}`);
	}
	for (const position of ["center", "", null, 3]) {
		assert.throws(() => pal.api.parseSettings({ description: "a robot", enabled: true, position }), /position/);
	}
	const original = await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8");
	pal.io.beforeWrite = (file) => {
		if (path.basename(file).startsWith(".pi-pal-")) throw new Error("Disk full");
	};
	await assert.rejects(pal.api.saveSettings({ position: "top-left" }), /Disk full/);
	assert.equal(await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8"), original);
});

test("the settings toggle and existing shortcuts share enable/disable behavior", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	pal.dialogs.choices.push(0);
	await pal.command("");
	assert.equal((await pal.api.readSettings()).enabled, false);
	assert.equal(pal.render().length, 0);
	pal.settleReply("We did it!");
	assert.equal(pal.model.calls.length, 0);
	await pal.command("on");
	assert.equal((await pal.api.readSettings()).enabled, true);
	await pal.command("stop");
	pal.dialogs.choices.push(0);
	await pal.command("");
	assert.equal((await pal.api.readSettings()).enabled, true);
	await pal.reply("We did it again!");
	assert.equal(pal.image.calls.length, 1);
});

test("all four corners persist without replacing PNGs or animation timers", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	const timers = [...pal.timers.keys()];
	const files = await fs.readdir(pal.sprites);
	for (const [index, position] of ["top-left", "top-right", "bottom-left", "bottom-right"].entries()) {
		pal.dialogs.choices.push(2, index);
		await pal.command("");
		assert.equal((await pal.api.readSettings()).position, position);
		assert.equal(pal.overlays.at(-1)?.anchor, position);
		assert.equal(pal.overlays.filter((overlay) => !overlay.hidden).length, 1);
		assert.deepEqual([...pal.timers.keys()], timers);
		assert.equal(pal.pngs.length, 6);
		assert.equal(pal.displayed.length, 1);
	}
	assert.deepEqual(await fs.readdir(pal.sprites), files);
	assert.equal(pal.image.calls.length, 1);
	const reloaded = await loadPal(t, pal.agentDir);
	await reloaded.act("happy");
	assert.equal(reloaded.overlays.at(-1)?.anchor, "bottom-right");
	assert.equal(reloaded.image.calls.length, 0);
});

test("repositioning during generation preserves the current sprite and pending update", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	const writing = Promise.withResolvers<void>();
	let waiting = false;
	pal.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) { waiting = true; return writing.promise; }
	};
	await pal.command("angry");
	try {
		await waitFor(() => waiting);
		const timers = [...pal.timers.keys()];
		pal.dialogs.choices.push(2, 0);
		await pal.command("");
		assert.equal(pal.overlays.at(-1)?.anchor, "top-left");
		assert.deepEqual([...pal.timers.keys()], timers);
		assert.equal(pal.displayed.length, 1);
	} finally {
		writing.resolve();
	}
	await waitFor(() => pal.displayed.length === 2);
	assert.equal(pal.labels.at(-1), "angry");
	assert.equal(pal.image.calls.length, 2);
});

test("avatar settings confirm cache deletion and use the same default operation", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	pal.dialogs.choices.push(1);
	pal.dialogs.inputs.push("a small fox");
	pal.dialogs.confirmations.push(false);
	await pal.command("");
	assert.equal((await pal.api.readSettings()).description, "a small robot");
	await fs.access(pal.sprites);
	pal.dialogs.choices.push(1);
	pal.dialogs.inputs.push("a small fox");
	pal.dialogs.confirmations.push(true);
	await pal.command("");
	assert.equal((await pal.api.readSettings()).description, "a small fox");
	await assert.rejects(fs.access(pal.sprites), { code: "ENOENT" });
	await pal.act("happy");
	assert.ok(pal.image.calls.at(-1).prompt.includes("a small fox"));
});

test("migrates learned entries once without changing the legacy catalog", async (t) => {
	const pal = await loadPal(t);
	const defaults = JSON.parse(await fs.readFile(new URL("./emotions.json", import.meta.url), "utf8"));
	const custom = { id: "juggling", action: "juggling three colorful balls" };
	const legacy = JSON.stringify([...defaults, custom]);
	await fs.mkdir(path.dirname(pal.legacy), { recursive: true });
	await fs.writeFile(pal.legacy, legacy);
	assert.equal((await pal.api.readEmotions(signal())).length, 31);
	assert.deepEqual(JSON.parse(await fs.readFile(pal.catalog, "utf8")), [custom]);
	assert.equal(await fs.readFile(pal.legacy, "utf8"), legacy);
	await pal.act("happy");
	const files = await fs.readdir(pal.sprites);
	pal.dialogs.choices.push(3);
	pal.dialogs.confirmations.push(true);
	await pal.command("");
	assert.deepEqual(JSON.parse(await fs.readFile(pal.catalog, "utf8")), []);
	assert.deepEqual(await fs.readdir(pal.sprites), files);
	const reloaded = await loadPal(t, pal.agentDir);
	assert.equal((await reloaded.api.readEmotions(signal())).length, 30, "reset must not re-import legacy entries");
	assert.equal(await fs.readFile(pal.legacy, "utf8"), legacy);
});

test("reset pauses Luna so an in-flight proposal cannot re-add cleared emotions", async (t) => {
	const pal = await loadPal(t);
	await pal.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	const selection = Promise.withResolvers<void>();
	pal.model.beforeComplete = () => selection.promise;
	pal.model.output = '{"new":{"id":"stretching","action":"stretching both arms overhead"}}';
	await pal.command("stretch your arms");
	await waitFor(() => pal.model.calls.length === 1);
	pal.dialogs.choices.push(3);
	pal.dialogs.confirmations.push(true);
	let reset = false;
	const resetting = pal.command("").then(() => { reset = true; });
	try {
		await waitFor(() => pal.dialogs.shown.some((dialog) => dialog.kind === "confirm"));
		assert.equal(reset, false);
	} finally {
		selection.resolve();
		await resetting;
	}
	assert.equal((await pal.api.readEmotions(signal())).length, 30);
	assert.equal(pal.image.calls.length, 0);
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 1);
});

test("reset cancellation preserves custom emotions; clear images preserves definitions and settings", async (t) => {
	const pal = await loadPal(t);
	await pal.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	await pal.act("juggling");
	const settings = await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8");
	const catalog = await fs.readFile(pal.catalog, "utf8");
	pal.dialogs.choices.push(3, 4);
	pal.dialogs.confirmations.push(false, false);
	await pal.command("");
	assert.equal(await fs.readFile(pal.catalog, "utf8"), catalog);
	await fs.access(pal.sprites);
	pal.dialogs.choices.push(4);
	pal.dialogs.confirmations.push(true);
	await pal.command("");
	await assert.rejects(fs.access(pal.sprites), { code: "ENOENT" });
	assert.equal(await fs.readFile(pal.catalog, "utf8"), catalog);
	assert.equal(await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8"), settings);
	await pal.act("juggling");
	assert.equal(pal.image.calls.length, 2);
});

test("invalid legacy data is left untouched and an explicit reset can recover", async (t) => {
	const pal = await loadPal(t);
	await fs.mkdir(path.dirname(pal.legacy), { recursive: true });
	await fs.writeFile(pal.legacy, "{");
	await assert.rejects(pal.api.readEmotions(signal()));
	await assert.rejects(fs.access(pal.catalog), { code: "ENOENT" });
	assert.equal(await fs.readFile(pal.legacy, "utf8"), "{");
	pal.dialogs.choices.push(3);
	pal.dialogs.confirmations.push(true);
	await pal.command("");
	assert.equal((await pal.api.readEmotions(signal())).length, 30);
	assert.equal(await fs.readFile(pal.legacy, "utf8"), "{");
});

test("failed menu changes preserve stored values and release the reaction pause", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	await pal.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	const catalog = await fs.readFile(pal.catalog, "utf8");
	pal.io.beforeWrite = (file) => {
		if (path.basename(file).startsWith(".")) throw new Error("Disk full");
	};
	pal.dialogs.choices.push(2, 0, 3);
	pal.dialogs.confirmations.push(true);
	await pal.command("");
	assert.equal((await pal.api.readSettings()).position, "bottom-right");
	assert.equal(await fs.readFile(pal.catalog, "utf8"), catalog);
	assert.equal(pal.notifications.filter((notice) => notice.level === "error" && notice.text.includes("Disk full")).length, 2);
	pal.io.beforeWrite = undefined;
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 1);
});

test("renders PNGs in a non-capturing corner overlay with only an emotion label", async (t) => {
	const pal = await loadPal(t);
	for (let update = 0; update < 2; update++) {
		await pal.act("happy");
		const lines = pal.render();
		assert.equal(pal.layout().length, 0, "no dock should reserve editor space");
		assert.equal(lines.at(-2), `│ happy${" ".repeat(18)}│`);
		assert.ok(lines.at(-1)!.startsWith("╰"));
		assert.ok(lines.every((line) => stripVTControlCharacters(line).length === 26));
		assert.ok(!lines.join("\n").includes("/pi-pal stop"));
		assert.ok(!lines.join("\n").includes("(cached)"));
	}
	const overlay = pal.overlays.at(-1)!;
	assert.equal(overlay.nonCapturing, true);
	assert.equal(overlay.visible(80, 40), true);
	assert.equal(overlay.visible(20, 40), false);
	assert.equal(overlay.visible(80, 10), false);
	assert.equal(pal.image.calls.length, 1);
	assert.ok(!pal.notifications.some((notice) => notice.level === "warning"));
	await pal.command("stop");
	assert.equal(pal.timers.size, 0);
	assert.equal(pal.render().length, 0);
	assert.ok(pal.overlays.every((overlay) => overlay.hidden));
	assert.ok(pal.notifications.some((notice) => notice.text === "Automatic reactions off."));
});

test("leaves the image area blank while the first sprite loads", async (t) => {
	const pal = await loadPal(t);
	const selection = Promise.withResolvers<void>();
	pal.model.beforeComplete = () => selection.promise;
	await pal.command("say hello");
	try {
		await waitFor(() => pal.model.calls.length === 1);
		const lines = pal.render();
		assert.equal(lines.length, 13);
		assert.ok(lines.slice(1, -2).every((line) => line === `│${" ".repeat(24)}│`));
		assert.equal(lines.at(-2), `│ ●··${" ".repeat(20)}│`);
		assert.equal(pal.timers.size, 1);
		assert.equal([...pal.timers.values()][0].interval, 250);
		for (const dots of ["·●·", "··●", "●··"]) {
			pal.tick();
			assert.equal(pal.render().at(-2), `│ ${dots}${" ".repeat(20)}│`);
			assert.deepEqual(pal.render().slice(0, -2), lines.slice(0, -2));
		}
		assert.equal(pal.displayed.length, 0);
	} finally {
		selection.resolve();
	}
	await waitFor(() => pal.displayed.length === 1);
	assert.equal(pal.timers.size, 1);
	assert.equal([...pal.timers.values()][0].interval, 125);
});

test("keeps the existing sprite and shows loading dots throughout an update", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	assert.deepEqual(pal.labels, ["●··", "happy"]);
	const previous = pal.render();
	const selection = Promise.withResolvers<void>();
	pal.model.output = '{"id":"angry"}';
	pal.model.beforeComplete = () => selection.promise;
	pal.io.beforeWrite = (file) => {
		if (file.endsWith(".png")) {
			assert.equal(pal.render().at(-2), `│ ·●·${" ".repeat(20)}│`);
			assert.equal(pal.displayed.length, 1);
		}
	};
	await pal.command("get mad");
	try {
		await waitFor(() => pal.model.calls.length === 1);
		assert.equal(pal.render().at(-2), `│ ●··${" ".repeat(20)}│`);
		pal.tick();
		assert.equal(pal.render().at(-2), `│ ·●·${" ".repeat(20)}│`);
		assert.deepEqual(pal.render().slice(0, -2), previous.slice(0, -2));
		assert.equal(pal.displayed.length, 1);
	} finally {
		selection.resolve();
	}
	await waitFor(() => pal.displayed.length === 2);
	assert.deepEqual(pal.labels, ["●··", "happy", "●··", "·●·", "angry"]);
	assert.equal(pal.timers.size, 1);
	await pal.act("angry");
	assert.deepEqual(pal.labels.slice(-2), ["●··", "angry"]);
	assert.equal(pal.image.calls.length, 2, "the repeated emotion still uses its cache");
});

test("loops original PNG bytes and invalidates each frame for retransmission", async (t) => {
	const pal = await loadPal(t);
	const frames = await Promise.all(["#f00", "#00f"].map(async (background) => {
		const png = await sharp({ create: { width: 336, height: 336, channels: 3, background } }).png().toBuffer();
		return png.toString("base64");
	}));
	const view = pal.api.showPal(pal.ctx, "bottom-right");
	t.after(() => view.hide());
	view.update({ status: "ready", emotion: "happy", frames });
	assert.deepEqual(pal.pngs.map((png) => png.data), frames);
	assert.ok(pal.pngs.every((png) => png.mimeType === "image/png" && png.imageId === 1));
	const first = pal.render();
	pal.tick();
	assert.notDeepEqual(pal.render(), first);
	assert.equal(pal.pngs[1].invalidations, 1);
	pal.tick();
	assert.deepEqual(pal.render(), first);
	assert.equal(pal.pngs[0].invalidations, 1);
	view.update({ status: "loading" });
	assert.equal(pal.timers.size, 2);
	view.update({ status: "failed" });
	assert.equal(pal.timers.size, 1);
	assert.deepEqual(pal.render().slice(0, -2), first.slice(0, -2));
	view.hide();
	assert.equal(pal.timers.size, 0);
	assert.equal(pal.render().length, 0);
});

test("unsupported terminals retain PNGs on disk without an animation timer", async (t) => {
	const pal = await loadPal(t);
	pal.capabilities.images = null;
	await pal.act("happy");
	assert.equal(pal.timers.size, 0);
	assert.ok(pal.notifications.some((notice) => notice.text.includes("cannot display images")));
	await fs.access(pal.sprites);
});

test("stopping the pal clears the loading timer", async (t) => {
	const pal = await loadPal(t);
	const selection = Promise.withResolvers<void>();
	pal.model.beforeComplete = () => selection.promise;
	await pal.command("say hello");
	try {
		await waitFor(() => pal.model.calls.length === 1);
		assert.equal(pal.timers.size, 1);
		await pal.command("stop");
		assert.equal(pal.timers.size, 0);
		const renders = pal.labels.length;
		pal.tick();
		assert.equal(pal.labels.length, renders);
	} finally {
		selection.resolve();
	}
});

test("a failed update stops the loading timer", async (t) => {
	const pal = await loadPal(t);
	pal.image.status = 500;
	await pal.command("happy");
	await waitFor(() => pal.notifications.some((notice) => notice.text.includes("HTTP 500")));
	assert.equal(pal.labels.at(-1), "Update failed");
	assert.equal(pal.timers.size, 0);
});

test("combines 30 bundled emotions with separately persisted additions across reloads", async (t) => {
	const pal = await loadPal(t);
	const emotions = await pal.api.readEmotions(signal());
	assert.equal(emotions.length, 30);
	assert.equal(new Set(emotions.map((emotion: any) => emotion.id)).size, 30);
	assert.equal(JSON.parse(await fs.readFile(pal.catalog, "utf8")).length, 0);
	await Promise.all([
		pal.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal()),
		pal.api.addEmotion({ id: "stretching", action: "stretching both arms overhead" }, signal()),
		pal.api.addEmotion({ id: "juggling", action: "juggling four colorful balls" }, signal()),
	]);
	const reloaded = await loadPal(t, pal.agentDir);
	const saved = await reloaded.api.readEmotions(signal());
	assert.equal(saved.length, 32);
	assert.equal(saved.find((emotion) => emotion.id === "juggling")?.action, "juggling three colorful balls");
	assert.equal(JSON.parse(await fs.readFile(new URL("./emotions.json", import.meta.url), "utf8")).length, 30);
});

test("deduplicates an identical visual action under a different ID", async (t) => {
	const pal = await loadPal(t);
	const emotions = await pal.api.readEmotions(signal());
	const existing = emotions.find((emotion) => emotion.id === "waving");
	assert.ok(existing);
	const selected = await pal.api.addEmotion({ id: "greeting", action: existing.action }, signal());
	assert.equal(selected.id, "waving");
	assert.equal((await pal.api.readEmotions(signal())).length, 30);
});

test("rejects damaged or invalid catalogs without overwriting them", async (t) => {
	const pal = await loadPal(t);
	await pal.api.readEmotions(signal());
	for (const text of ["{", "{}", '[{"id":"happy","action":"smiling with a gentle bounce"}]', '[{"id":"../escape","action":"waving hello to everyone"}]',
		'[{"id":"happy","action":"smiling with a gentle bounce"},{"id":"happy","action":"bouncing with a happy smile"}]']) {
		await fs.writeFile(pal.catalog, text);
		await assert.rejects(pal.api.readEmotions(signal()));
		assert.equal(await fs.readFile(pal.catalog, "utf8"), text);
	}
});

test("Luna selects canonical definitions and proposes normalized new actions", async (t) => {
	const pal = await loadPal(t);
	const emotions = await pal.api.readEmotions(signal());
	const initial = await fs.readFile(pal.catalog, "utf8");
	const happy = emotions.find((emotion) => emotion.id === "happy");
	assert.ok(happy);
	let selected = await pal.api.selectEmotion("That worked!", "reply", emotions, pal.ctx, signal());
	assert.equal(selected.id, "happy");
	assert.equal(selected.action, happy.action);
	assert.ok(pal.model.calls[0].input.systemPrompt.includes('"id":"facepalming"'));
	assert.equal(pal.model.calls[0].options.reasoningEffort, "none");
	pal.model.output = '{"new":{"id":"juggling","action":" juggling   three colorful balls "}}';
	selected = await pal.api.selectEmotion("juggle", "action", emotions, pal.ctx, signal());
	assert.equal(selected.id, "juggling");
	assert.equal(selected.action, "juggling three colorful balls");
	assert.equal(await fs.readFile(pal.catalog, "utf8"), initial, "selection alone must not mutate the catalog");
	pal.model.output = '{"new":{"id":"happy","action":"doing a completely different animation"}}';
	selected = await pal.api.selectEmotion("happy", "reply", emotions, pal.ctx, signal());
	assert.equal(selected.action, happy.action);
});

test("rejects malformed Luna choices without adding emotions", async (t) => {
	const pal = await loadPal(t);
	const emotions = await pal.api.readEmotions(signal());
	const initial = await fs.readFile(pal.catalog, "utf8");
	for (const output of [
		"not JSON", 'null', '[]', '{"id":"unknown"}', '{"id":"happy","new":{}}',
		'{"new":{"id":"../escape","action":"juggling three colorful balls"}}',
		'{"new":{"id":"Juggling","action":"juggling three colorful balls"}}',
		'{"new":{"id":"juggling","action":"juggle"}}',
		'{"new":{"id":"juggling","action":"one two three four five six seven eight nine"}}',
		'{"new":{"id":"juggling","action":"juggling three colorful balls","appearance":"robot"}}',
	]) {
		pal.model.output = output;
		await assert.rejects(pal.api.selectEmotion("hello", "reply", emotions, pal.ctx, signal()), /emotion/i, output);
	}
	pal.model.output = '{"id":"happy"}';
	pal.model.stopReason = "length";
	await assert.rejects(pal.api.selectEmotion("hello", "reply", emotions, pal.ctx, signal()), /could not select/);
	assert.equal(await fs.readFile(pal.catalog, "utf8"), initial);
});

test("publishes six square PNGs and reuses them through the cache manifest", async (t) => {
	const pal = await loadPal(t);
	assert.equal(await pal.api.readSprite("test", signal()), undefined);
	const sprite = await pal.api.saveSprite(sheet, "test", signal());
	assert.equal(sprite.frames.length, 6);
	assert.equal((await fs.readdir(sprite.directory)).length, 7);
	for (const frame of sprite.frames) {
		const metadata = await sharp(Buffer.from(frame, "base64")).metadata();
		assert.equal(metadata.width, 336);
		assert.equal(metadata.height, 336);
	}
	const cached = await pal.api.readSprite("test", signal());
	assert.ok(cached);
	assert.equal(cached.directory, sprite.directory);
	assert.deepEqual([...cached.frames], [...sprite.frames]);
});

test("missing, malformed, and corrupt cache entries become misses", async (t) => {
	const pal = await loadPal(t);
	const sprite = await pal.api.saveSprite(sheet, "test", signal());
	const manifest = path.join(pal.sprites, "test.json");
	const original = await fs.readFile(manifest, "utf8");
	for (const value of ["{", "null", '{"directory":"../../outside"}', '{"directory":"sprite-missing"}']) {
		await fs.writeFile(manifest, value);
		assert.equal(await pal.api.readSprite("test", signal()), undefined);
	}
	await fs.writeFile(manifest, original);
	await fs.writeFile(path.join(sprite.directory, "frame-3.png"), sheet.subarray(0, 40));
	assert.equal(await pal.api.readSprite("test", signal()), undefined, "a PNG header alone is not a valid frame");
	await pal.api.saveSprite(sheet, "test", signal());
	assert.ok(await pal.api.readSprite("test", signal()));
});

test("failed and cancelled writes never publish partial cache entries", async (t) => {
	const pal = await loadPal(t);
	pal.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) throw new Error("Disk full");
	};
	await assert.rejects(pal.api.saveSprite(sheet, "failed", signal()), /Disk full/);
	assert.deepEqual(await fs.readdir(pal.sprites), []);
	const controller = new AbortController();
	pal.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) controller.abort();
	};
	await assert.rejects(pal.api.saveSprite(sheet, "cancelled", controller.signal));
	assert.deepEqual(await fs.readdir(pal.sprites), []);
});

test("cancelled catalog writes and failed regeneration preserve existing data", async (t) => {
	const pal = await loadPal(t);
	await pal.api.readEmotions(signal());
	const initial = await fs.readFile(pal.catalog, "utf8");
	const controller = new AbortController();
	pal.io.beforeWrite = (file) => {
		if (path.basename(file).startsWith(".custom-emotions-")) controller.abort();
	};
	await assert.rejects(pal.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, controller.signal));
	assert.equal(await fs.readFile(pal.catalog, "utf8"), initial);
	assert.deepEqual(await fs.readdir(path.dirname(pal.catalog)), ["custom-emotions.json"]);
	pal.io.beforeWrite = undefined;
	const existing = await pal.api.saveSprite(sheet, "test", signal());
	const files = await fs.readdir(pal.sprites);
	pal.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) throw new Error("Disk full");
	};
	await assert.rejects(pal.api.saveSprite(sheet, "test", signal()), /Disk full/);
	assert.deepEqual(await fs.readdir(pal.sprites), files);
	assert.equal((await pal.api.readSprite("test", signal()))?.directory, existing.directory);
});

test("superseded Luna selections neither add new emotions nor generate their sprites", async (t) => {
	const pal = await loadPal(t);
	let release!: () => void;
	pal.model.beforeComplete = () => new Promise<void>((resolve) => { release = resolve; });
	pal.model.output = '{"new":{"id":"juggling","action":"juggling three colorful balls"}}';
	await pal.command("juggle some balls");
	await waitFor(() => pal.model.calls.length === 1);
	await pal.command("happy");
	release();
	await waitFor(() => pal.notifications.some((notice) => notice.text.includes("Pi Pal happy:")));
	assert.equal((await pal.api.readEmotions(signal())).length, 30);
	assert.equal(pal.image.calls.length, 1);
	assert.ok(pal.image.calls[0].prompt.includes("smiling with a gentle bounce"));
});

test("different replies reuse one sprite; exact IDs bypass Luna across sessions and projects", async (t) => {
	const pal = await loadPal(t);
	await pal.reply("The fix works!");
	await pal.reply("The next fix works too!");
	assert.equal(pal.model.calls.length, 2);
	assert.equal(pal.image.calls.length, 1);
	assert.equal(pal.image.calls[0].quality, "low");
	assert.equal(pal.image.calls[0].size, "1008x672");
	assert.ok(pal.image.calls[0].prompt.includes("six equal 336 by 336 cells"));
	const reloaded = await loadPal(t, pal.agentDir);
	reloaded.ctx.cwd = path.join(pal.agentDir, "another-project");
	reloaded.model.available = false;
	await reloaded.act("happy");
	assert.equal(reloaded.model.calls.length, 0);
	assert.equal(reloaded.image.calls.length, 0);
	assert.deepEqual(reloaded.displayed, pal.displayed.slice(0, 1));
	assert.ok(reloaded.notifications.some((notice) => notice.text.includes("Pi Pal happy:")));
});

test("new emotions persist automatically, even when the first image request fails", async (t) => {
	const pal = await loadPal(t);
	pal.model.output = '{"new":{"id":"juggling","action":"juggling three colorful balls"}}';
	pal.image.status = 500;
	await pal.command("juggle some balls");
	await waitFor(() => pal.notifications.some((notice) => notice.text.includes("HTTP 500")));
	assert.equal((await pal.api.readEmotions(signal())).length, 31);
	assert.equal(pal.displayed.length, 0);
	pal.image.status = 200;
	await pal.act("juggling");
	await pal.act("juggling");
	assert.equal(pal.model.calls.length, 1);
	assert.equal(pal.image.calls.length, 2, "one failed request, then one successful request, then a cache hit");
});

test("cache keys change with avatar, emotion action, and image settings", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	await pal.command("default a small fox");
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 2);
	await pal.command("default a small robot");
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 3, "returning to the original avatar generates fresh sprites");
	await pal.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	await pal.act("juggling");
	assert.equal(pal.image.calls.length, 4);
	const custom = JSON.parse(await fs.readFile(pal.catalog, "utf8"));
	custom[0].action = "juggling five colorful balls";
	await fs.writeFile(pal.catalog, JSON.stringify(custom));
	await pal.act("juggling");
	assert.equal(pal.image.calls.length, 5);
	const key = pal.api.spriteKey("a small robot", custom[0]);
	const expected = crypto.createHash("sha256").update(JSON.stringify({ id: "juggling", ...pal.image.calls.at(-1) })).digest("hex");
	assert.equal(key, expected, "cache keys include all request settings and the full prompt");
	await fs.access(path.join(pal.sprites, `${key}.json`));
});

test("changing the default clears all managed sprites but keeps emotions and project exports", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	await pal.act("angry");
	await pal.api.saveSprite(sheet, "earlier-avatar", signal());
	await pal.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	const catalog = await fs.readFile(pal.catalog, "utf8");
	const exports = path.join(pal.ctx.cwd, "generated_images");
	await fs.mkdir(exports, { recursive: true });
	await fs.writeFile(path.join(exports, "sheet.png"), sheet);
	await pal.command("default a small fox");
	await assert.rejects(fs.access(pal.sprites), { code: "ENOENT" });
	assert.equal(await fs.readFile(pal.catalog, "utf8"), catalog);
	assert.deepEqual(await fs.readFile(path.join(exports, "sheet.png")), sheet);
	assert.equal(JSON.parse(await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8")).description, "a small fox");
	assert.ok(pal.notifications.some((notice) => notice.text === "Avatar saved. Images cleared."));
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 3);
	assert.ok(pal.image.calls.at(-1).prompt.includes("a small fox"));
});

test("saving the same trimmed default retains its sprite cache", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	const files = await fs.readdir(pal.sprites);
	await pal.command("default   a small robot  ");
	assert.deepEqual(await fs.readdir(pal.sprites), files);
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 1);
	assert.ok(pal.notifications.some((notice) => notice.text === "Avatar saved."));
});

test("changing the default works before any sprites have been generated", async (t) => {
	const pal = await loadPal(t);
	await pal.command("default a small fox");
	assert.ok(!pal.notifications.some((notice) => notice.level === "error"));
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 1);
	assert.ok(pal.image.calls[0].prompt.includes("a small fox"));
});

test("avatar changes await cancelled writes and cleanup, dropping queued and paused reactions", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	const write = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	let writing = false;
	let cleaning = false;
	let changed = false;
	pal.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) {
			writing = true;
			return write.promise;
		}
	};
	pal.io.beforeRemove = (file) => {
		if (path.basename(file).startsWith("sprite-")) {
			cleaning = true;
			return cleanup.promise;
		}
	};
	await pal.command("angry");
	await waitFor(() => writing);
	await pal.command("sad");
	const changing = pal.command("default a small fox").then(() => { changed = true; });
	try {
		await pal.command("excited");
		pal.settleReply("We did it!");
		assert.ok(pal.notifications.some((notice) => notice.text.includes("Updating settings")));
		assert.equal(pal.image.calls.length, 2);
		assert.equal(pal.model.calls.length, 0);
		write.resolve();
		await waitFor(() => cleaning);
		assert.equal(changed, false, "the default command must await cleanup, not just abort the request");
		await fs.access(pal.sprites);
		assert.equal(JSON.parse(await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8")).description, "a small robot");
	} finally {
		write.resolve();
		cleanup.resolve();
		await changing;
	}
	await assert.rejects(fs.access(pal.sprites), { code: "ENOENT" });
	assert.equal(pal.displayed.length, 1, "the cancelled sprite must never be displayed");
	assert.equal(pal.image.calls.length, 2, "no queued or paused reaction should restart after cleanup");
	pal.io.beforeWrite = undefined;
	pal.io.beforeRemove = undefined;
	await pal.act("angry");
	assert.equal(pal.image.calls.length, 3);
	assert.ok(pal.image.calls.at(-1).prompt.includes("a small fox"));
});

test("cache deletion failures retain the old default and release the reaction pause", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	pal.io.beforeRemove = (file) => {
		if (file === pal.sprites) throw new Error("Permission denied");
	};
	await pal.command("default a small fox");
	assert.ok(pal.notifications.some((notice) => notice.level === "error" && notice.text.includes("Permission denied")));
	assert.equal(JSON.parse(await fs.readFile(path.join(pal.agentDir, "pi-pal.json"), "utf8")).description, "a small robot");
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 1);
	pal.io.beforeRemove = undefined;
	await pal.command("default a small fox");
	await assert.rejects(fs.access(pal.sprites), { code: "ENOENT" });
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 2);
});

test("a damaged cached frame triggers generation on the next reaction", async (t) => {
	const pal = await loadPal(t);
	await pal.act("happy");
	const manifest = (await fs.readdir(pal.sprites)).find((file) => file.endsWith(".json"))!;
	const { directory } = JSON.parse(await fs.readFile(path.join(pal.sprites, manifest), "utf8"));
	await fs.rm(path.join(pal.sprites, directory, "frame-2.png"));
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 2);
	await pal.act("happy");
	assert.equal(pal.image.calls.length, 2);
});

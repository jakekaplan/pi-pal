# Pi Pal

An animated pixel-art companion for [Pi](https://github.com/earendil-works/pi). Describe your avatar, and it reacts to assistant replies with looping animations in a corner of your terminal.

## Install

```sh
pi install git:github.com/jakekaplan/pi-pal
```

Restart Pi, or run `/reload` in an existing session. Open `/pi-pal` to choose your avatar and enable automatic reactions.

Pi installs the package's dependencies automatically. No build step or npm publication is required; the package declares its entrypoint using [Pi's package manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## Requirements

- Node.js 22.19 or newer and a current Pi release using the `@earendil-works` packages.
- Pi's interactive terminal UI, with image support for animation. Without image support, generated PNGs are still saved on disk.
- An `openai-codex` login in Pi (`/login openai-codex`) with access to Codex image generation.
- The `gpt-5.6-luna` model in Pi's `openai-codex` catalog for automatic reactions and free-form actions.

Pi Pal uses the existing Codex login to request `gpt-image-2` sprites from the ChatGPT Codex image endpoint. Access depends on your account. Automatic reactions send the latest assistant reply (up to 12,000 characters) to Luna to select an emotion; the avatar description and selected action are sent for image generation. Matching animations are cached locally and reused.

## Use

| Command | Action |
| --- | --- |
| `/pi-pal` | Open settings |
| `/pi-pal default a small orange fox` | Set the avatar and enable automatic reactions |
| `/pi-pal happy` | Animate a bundled emotion directly |
| `/pi-pal juggle some balls` | Select or create an emotion for a free-form action |
| `/pi-pal on` | Enable automatic reactions |
| `/pi-pal stop` | Disable automatic reactions and hide the avatar |

Settings let you move the avatar to any corner, reset custom emotions, and clear cached images. Changing the avatar clears its previous images. Manual reactions remain available when automatic reactions are off.

Reactions run in the background after an assistant reply completes. New animations contain six frames and loop at eight frames per second. The overlay is visible when the terminal is at least 30 columns by 20 rows.

## Saved data

Pi Pal stores data in Pi's agent directory (normally `~/.pi/agent`, or your `PI_CODING_AGENT_DIR` override):

```text
pi-pal.json                  Avatar, enabled state, and corner preference
pi-pal/custom-emotions.json  Additional emotions
pi-pal/sprites/              Cached sprite sheets and animation frames
```

### Migrating from Pi Buddy

Disable the old Pi Buddy extension before enabling Pi Pal to avoid running both. Close Pi sessions before copying data.

To retain your existing avatar, emotions, and cached images, copy `pi-buddy.json` to `pi-pal.json` and the `pi-buddy/` directory to `pi-pal/` within your agent directory. Do this before first using Pi Pal, and only if the destinations do not already exist. The data formats are unchanged; migration is manual.

## Development

```sh
npm ci
npm test
pi -e .
```

The tests exercise commands, animation lifecycle, caching, cancellation, and file locking across processes. Model and image requests are mocked, so tests need no login or network access.

Pi provides the optional peer dependencies at runtime. `sharp` and `proper-lockfile` are installed with this package.

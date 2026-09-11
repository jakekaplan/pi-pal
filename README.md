# Pi Pal

Give [Pi](https://github.com/earendil-works/pi) a little pixel-art pal. Pick a character, and it hangs out in your terminal, reacting to your conversation with animated expressions.

## Install

```sh
pi install git:github.com/jakekaplan/pi-pal
```

Set your default avatar:

```text
/pi-pal default a small orange fox
```

Make it a robot, a sleepy cat, or whatever you like. Setting an avatar turns on automatic reactions to Pi's replies.

## Models

Sign in with `/login openai-codex`. Your account needs access to both models Pi Pal uses:

- **GPT-5.6 Luna** (`gpt-5.6-luna`) chooses your pal's reactions.
- **GPT Image 2** (`gpt-image-2`) draws your pal's animations.

Your main Pi conversation can use a different model. You'll also need a terminal with image support to see your pal animate.

## Use

Your pal reacts automatically as you chat, but you can also ask it to do something. It comes with 30 built-in actions, including `happy`, `thinking`, `celebrating`, and `waving`. Try `/pi-pal waving` to say hello.

For a custom action, describe what you want: `/pi-pal do a little dance`. Your pal uses an existing action when it fits, or learns a new one and remembers it for future reactions.

| Command | Action |
| --- | --- |
| `/pi-pal` | Change your avatar, corner, and other settings |
| `/pi-pal happy` | Make your pal look happy |
| `/pi-pal do a little dance` | Request a custom action |
| `/pi-pal stop` | Hide your pal and pause automatic reactions |
| `/pi-pal on` | Turn automatic reactions back on |

You can also reset custom emotions or clear saved animations from `/pi-pal` settings.

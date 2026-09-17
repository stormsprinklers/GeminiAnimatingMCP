# Chestnut & Cheer Animation Studio

This Windows app turns the supplied squirrel mascot image into a Veo animation, downloads the video, removes the blue background, and saves a transparent WebM in an organized library.

## Use the app

1. Double-click **Start Studio.cmd** in this folder. Keep its window open while using the app.
2. Your browser opens to **http://127.0.0.1:4177/**. If it opens before the app is ready, refresh the page once.
3. Enter a name. Leave the image field empty to use the included mascot, or choose another PNG, JPG, or WebP mascot image.
4. To change the opening pose, position, props, or design, describe the desired starting picture and click **Prepare starting frame**. Check the resulting picture before generating video. For example: “Seat the chipmunk holding a wrapped Christmas present.” Edit the description and prepare again if the picture needs work. Gemini image preparation may incur a charge.
5. In **What happens in the animation?**, describe the motion separately. For the example above: “He opens the present and smiles at what is inside.” Turn **Seamless loop** off if the ending pose should differ from the opening pose. Describe the exact final pose and click **Prepare ending frame**. Gemini uses the prepared starting picture and original mascot reference to make a second picture. Review both pictures before submitting the video. Change either description and prepare again if needed. This second image preparation may incur a charge. Leave looping on for one complete cycle that returns to the starting pose; loops use the same frame at both ends.
6. For a loop, choose one of the ten motion presets and a length of 4, 6, or 8 seconds. The app uses Veo 3.1 Lite at 720p by default. Some model settings only work at 8 seconds; the app retries there when Veo rejects a shorter loop.
7. Click **Generate animation**. Veo may take several minutes. The page checks job status automatically.
8. When the entry says **ready**, open **Preview loop** for a loop, or play the library video. Download **transparent WebM** or the **original MP4** from the library.

The loop request sends the same blue-background frame at both ends, made from your transparent mascot artwork. This preserves solid chroma blue during generation so the app can remove it after download. The app compares the first and last frames, adds a short transition when needed, removes audio, verifies that the exported WebM has transparent background pixels, and records these checks in `metadata.json`. The preview page plays the blue-screen MP4 for reliable playback, repeating it only for loops, and has a button to try the transparent WebM. Some browsers cannot play transparent VP9 video reliably; playback in other programs depends on that program's repeat setting.

Prepared frames use Gemini image editing to change the reference before Veo starts. A non-loop animation can send a different prepared picture as Veo's last frame to guide the final pose. Both pictures and their prompts are saved with the animation. The library records how closely the video starts and ends against the prepared pictures. Veo first/last-frame generation may require an 8-second clip and may reject an audio setting; the app retries supported settings and removes audio from the transparent export. Image generation and video generation are creative models, so review both pictures and the motion: Veo may still change a pose or prop between the controlled endpoints. The chroma key removes blue, so a mascot or prop with blue coloring may need a different background color in a future version.

The app only listens on this computer (`127.0.0.1`). Closing the command window stops the local app. Jobs and videos stay in `library/`, and you can resume checking an unfinished job next time you start it.

## API key

The Gemini API key lives in `.env` as `GEMINI_API_KEY=...`. The app never sends its value to the browser, and `.env` is excluded from Git. Do not share or commit that file. This project is in a OneDrive folder, so OneDrive may sync `.env` to your account; move the project outside a synced folder if you need the key to stay only on this computer.

Each Veo generation may use paid Google API credits. Changing the action and clicking Generate again creates a new paid job. Reprocessing an existing MP4 with MCP does not call Veo.

## Use from Codex

This computer has `.codex/config.toml`, which connects the local `mascot_animations` MCP server when Codex loads this project. The GitHub backup includes `.codex/config.example.toml` instead; after restoring to another folder or computer, copy that example to `config.toml` and update its absolute paths. Start a new Codex task in this project if the tools do not appear in the current one. Codex can use `prepare_start_frame`, `prepare_ending_frame`, and `inspect_prepared_frame` to make and review distinct start and end poses, then pass both frame IDs to `generate_animation` with looping off. It can also submit loop variations, check job status, preview and evaluate a loop, reprocess transparency, approve a reviewed version, and list approved loops. Image preparation and Veo generation may incur charges; reprocessing saved video does not.

## Restore from the GitHub backup

Clone the repository, open a terminal in its folder, and run `npm install`. Copy `.env.example` to `.env`, add your Gemini API key there, then double-click **Start Studio.cmd**. The GitHub backup contains the app, mascot artwork, and MCP configuration example. Your API key in `.env` and generated media in `library/` stay on this computer and are not included in GitHub.

## For troubleshooting

In a terminal opened in this folder, `npm run doctor` checks Node.js, FFmpeg, the mascot image, and whether the API key is present without printing the key. `npm test` checks generation request shapes, loop fallback behavior, frame correction, transparency, the library, and the MCP connection. `npm start` starts the app without using the double-click launcher.

The included image is at `assets/full-body-mascot.png`. Every animation gets a unique folder under `library/` with `metadata.json`, its input image, `original.mp4`, and `transparent.webm`. Earlier failed setup attempts are preserved under `library/_failed/` and hidden from the app library.

Implementation follows the [Google Veo image-to-video guide](https://ai.google.dev/gemini-api/docs/veo), [Gemini image-editing guide](https://ai.google.dev/gemini-api/docs/image-generation), and [Codex MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp).

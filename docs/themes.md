# Theme authoring guide

A WSC theme decides how the station looks and sounds in words: palette, pixel art, room names and
the crew's catchphrases. It never decides **where** things go. Layout (zones, desks, the command
table, the lounge) is computed by shared code, so every theme works with any number of projects
and agents.

The manifest schema is the source of truth for every rule here: `src/shared/themeSchema.ts`. A
complete, installable example is in [`examples/minimal-theme/`](examples/minimal-theme/).

## 1. What a theme is

A folder whose name is the theme id. The id is a lowercase slug (`a-z`, `0-9`, `-`, max 40 chars):

```
my-theme/
├─ theme.json        # manifest (required)
├─ sheet.png         # only for sprite-sheet themes
└─ crew.png          # optional separate crew sheet
```

There are two kinds of art:

| `art.kind`  | What it does                                                                                                                           | Use it for                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `generated` | Reuses a built-in pixel-art generator (`spaceship`, `office`, `home`, `terminal`). Only the palette, room names and phrases are yours. | A new voice or color scheme in one file, with no drawing |
| `sheet`     | Your own PNG sprite sheet(s), cut into frames by rects in the manifest                                                                 | Hand-made art                                            |

Built-in themes live in `/themes/<id>/` in the repo. User and community themes live in the user
themes folder (section 7).

## 2. Manifest reference (`theme.json`)

| Field         | Type    | Rules                                                                                                                                                        |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | string  | Lowercase slug, must equal the folder name                                                                                                                   |
| `name`        | string  | 1–40 chars, shown in the theme menu                                                                                                                          |
| `author`      | string  | 1–80 chars                                                                                                                                                   |
| `license`     | string  | SPDX id, e.g. `MIT`, `CC0-1.0` (see section 8)                                                                                                               |
| `version`     | string  | Semver, e.g. `1.0.0`                                                                                                                                         |
| `description` | string? | ≤ 280 chars                                                                                                                                                  |
| `palette`     | object  | Nine `#rrggbb` colors: `background`, `panel`, `text`, `accent`, `working`, `waiting`, `done`, `error`, `stale`                                               |
| `tileSize`    | int     | 8–32 px per tile. All built-ins use 16                                                                                                                       |
| `pixelScale`  | int     | 1–8, default integer zoom                                                                                                                                    |
| `roomNames`   | object  | `center`, `lounge`, `zone`, each 1–24 chars (e.g. "Bridge", "Crew Lounge", "Section")                                                                        |
| `fontFamily`  | string? | CSS font family for labels and bubbles. Defaults to the system monospace                                                                                     |
| `art`         | object  | `generated` or `sheet` (sections 3 and 4)                                                                                                                    |
| `gear`        | object? | Per tool category, a prop name to show as station gear instead of the default gear icon                                                                      |
| `ambient`     | object? | `starfield`, `twinkle`, `scanlines`, `dust` booleans. Generators read what they support. `starfield: false` turns off the spaceship backdrop                 |
| `phrases`     | object  | **Required.** Catchphrases per moment (section 5)                                                                                                            |
| `decor`       | object? | Reserved. Validated but not used in v1, because layout picks decor props (`plant`, `sofa`, `console`, `bookshelf`, `lamp`, `coffee_machine`, `rug`, `crate`) |
| `sounds`      | object? | Reserved. Per-moment relative paths to sound files. Validated, not played in v1                                                                              |

Palette colors drive the station and the UI: `accent` is used for nameplates and highlights, and the
status colors are used for status lights and zone counts.

## 3. Generated art

```json
"art": { "kind": "generated", "generator": "spaceship", "options": {} }
```

`generator` must name a registered generator: `spaceship`, `office`, `home` or `terminal`. Any
`options` object is passed to the generator, and the built-ins currently ignore it. Generators draw
every crew animation, floor, wall, prop and gear icon in code, so a generated theme needs no image
files.

## 4. Sprite-sheet art

```json
"art": {
  "kind": "sheet",
  "image": "sheet.png",
  "crew": {
    "image": "crew.png",
    "frameWidth": 16, "frameHeight": 24,
    "variants": 4, "maxFrames": 4, "x": 0, "y": 0,
    "anims": { "idle": { "frames": 4 }, "walk": { "frames": 4, "fps": 8 } }
  },
  "floors": { "center": [{ "x": 0, "y": 0, "w": 16, "h": 16 }], "lounge": [...], "zone": [...], "corridor": [...] },
  "wall": { "x": 64, "y": 0, "w": 16, "h": 16 },
  "props": { "command_table": { "x": 0, "y": 32, "w": 48, "h": 48 }, "desk": {...}, ... },
  "gear": { "read": {...}, "other": {...} },
  "backdrop": { "x": 0, "y": 128, "w": 256, "h": 256 }
}
```

All rects are pixel rects `{ x, y, w, h }` inside `image`. Asset paths must be relative and stay
inside the theme folder, and only PNG files are loaded.

### Crew sheet layout

The crew sheet is `crew.image` if set, otherwise `image`. Frames start at `(x, y)`:

- **Columns:** each variant is a block of `maxFrames` columns, placed left to right. Variant `v`,
  frame `k` is at column `v * maxFrames + k`.
- **Rows:** row = `animIndex * 4 + facingIndex`.
  - Animation order (13): `idle, walk, sit, type, read, scan, terminal, comms, report, celebrate, error, wait, think`.
  - Facing order (4): `down, left, right, up`.
  - So a crew sheet is `13 × 4 = 52` rows tall.
- **Frame counts:** `anims.<name>.frames` says how many frames an animation has (default 1, at most
  `maxFrames`). `fps` overrides its speed. Defaults: walk 8, type 6, terminal and celebrate 5, think,
  comms, report and error 3, idle, scan and wait 2, read 1.5, sit 1.

| Animation   | When it plays                                     |
| ----------- | ------------------------------------------------- |
| `idle`      | Standing in the lounge                            |
| `walk`      | Moving (any direction)                            |
| `sit`       | Seated: lounge benches, orchestrator at the table |
| `type`      | `write` tools (Edit, Write) and unknown tools     |
| `read`      | `read` tools (Read)                               |
| `scan`      | `search` (Grep, Glob) and `plan` tools            |
| `terminal`  | `execute` (Bash) and `mcp` tools                  |
| `comms`     | `web` tools (WebFetch, WebSearch)                 |
| `report`    | Reporting to the orchestrator; delegating         |
| `celebrate` | Task finished                                     |
| `error`     | Task failed                                       |
| `wait`      | Waiting for you (permission or input)             |
| `think`     | Between tool calls                                |

**Anchors:** the scene draws a crew frame with anchor `(0.5, 1)`, so the bottom-center pixel is the
character's feet, standing on the bottom-center of its tile. The built-in crew are 16×24 on a
16 px tile: the head rises above the tile. Keep a 1–2 px transparent margin at the top for bubbles
to breathe.

### Props, floors, wall, gear

- **Floors:** each kind (`center`, `lounge`, `zone`, `corridor`) takes a list of tile-sized rects.
  The renderer picks one per tile by a coordinate hash, so several variants make the floor less
  repetitive. A missing kind falls back to `center`.
- **Wall:** one tile-sized rect, drawn on empty tiles next to floor.
- **Props:** a map from name to rect. Props are drawn with anchor `(0, 1)` at the bottom-left of
  their footprint, so taller art extends upward (3/4 view). Footprints:

| Prop                                                      | Footprint (tiles)                     | Notes                                                                    |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| `command_table`                                           | the layout's table rect (6×3 to 10×3) | **Nine-slice:** a 48×48 image with 16 px borders, stretched to the table |
| `desk`                                                    | 2×1                                   | e.g. 32×24 px                                                            |
| `chair`, `lounge_seat`, `door`, `plant`, `nameplate`      | 1×1                                   | Core props: always provide these                                         |
| `sofa`, `rug`                                             | 2×1                                   | Decor                                                                    |
| `console`, `bookshelf`, `lamp`, `coffee_machine`, `crate` | 1×1                                   | Decor. A missing decor prop is simply skipped                            |

- **Gear:** small icons (built-ins are 16×16) per tool category, drawn on a desk while someone works:
  `read, search, write, execute, web, delegate, plan, mcp, other`. A missing category uses `other`.
- **Backdrop:** optional, tileable. It is drawn with a tiling sprite behind the whole station.

## 5. Catchphrases

`phrases` must contain **every** moment, each a list of 1–20 strings of at most 40 characters. One
is picked at random each time:

| Moment        | When                                              |
| ------------- | ------------------------------------------------- |
| `assigned`    | A lounge crew member takes a new task             |
| `heading_out` | Walking to the project's zone                     |
| `done`        | Reporting a finished task                         |
| `error`       | Reporting a failure                               |
| `waiting`     | Asking you for permission or input                |
| `lounge`      | Heading back to the lounge                        |
| `delegating`  | The orchestrator hands work out                   |
| `arrive`      | Extra crew arrive because the lounge pool ran out |

Phrases are shown verbatim in speech bubbles, so keep them short, friendly and original. Status
bubbles ("reading auth.ts") are generated by the app and always redacted. Themes can't change them.

## 6. Validation and fallback

Manifests are validated with zod when loaded. If a theme is invalid, or its art can't be loaded,
WSC **never shows a blank window**. It loads Spaceship instead and shows a banner such as:

> Theme "Neon" is invalid — palette.accent: must be a #rrggbb color; phrases.lounge: needs at least
> one phrase. Using Spaceship.

Error paths name the exact field. The first three errors are shown, plus a count of the rest.

## 7. Installing a user theme

Copy the theme folder into the user themes folder:

| OS      | Folder                                      |
| ------- | ------------------------------------------- |
| macOS   | `~/Library/Application Support/WSC/themes/` |
| Windows | `%APPDATA%\WSC\themes\`                     |
| Linux   | `${XDG_CONFIG_HOME:-~/.config}/WSC/themes/` |

So the minimal example ends up at `…/WSC/themes/minimal-theme/theme.json`. Then pick it from the
theme menu, or type `/station theme minimal-theme` in Claude Code.

Rules for user themes:

- If a user theme has the same id as a built-in, the built-in wins. Pick a unique id.
- Limits: the manifest is at most 256 KB, each PNG at most 4 MB. Symlinks that point outside the
  theme folder are ignored.

**Live editing:** when running from source (`npm run dev`), WSC watches the themes folder and
reloads the theme list when files change. Re-select your theme to see edits. The validation banner
tells you what's wrong.

## 8. Licensing and content rules

- Art must be **your own original work** or **CC0**. Put the license in `license`. For anything
  not generated in code, add an entry to `ASSETS_LICENSES.md` when you submit it to the repo.
- **No third-party IP:** no characters, logos or catchphrases from games, films, TV or other
  brands. No Anthropic or Claude logos, trademarks or mascots.
- 2D pixel art only: crisp, integer-scaled, limited palette.

To submit a theme to the community gallery, see `CONTRIBUTING.md` (folder, a preview screenshot
from demo mode, and the license declaration).

## 9. Minimal complete example

[`examples/minimal-theme/theme.json`](examples/minimal-theme/theme.json) is a full, valid theme. It
reuses the spaceship art with a mint palette, its own room names and its own voice:

```json
{
  "id": "minimal-theme",
  "name": "Minimal Mint",
  "author": "Your Name",
  "license": "CC0-1.0",
  "version": "1.0.0",
  "palette": {
    "background": "#0f1a17",
    "panel": "#16251f",
    "text": "#e4f5ec",
    "accent": "#6ee7b7",
    "working": "#6ee7b7",
    "waiting": "#fcd34d",
    "done": "#a7f3d0",
    "error": "#f87171",
    "stale": "#6b7f76"
  },
  "tileSize": 16,
  "pixelScale": 3,
  "roomNames": { "center": "Hub", "lounge": "Greenhouse", "zone": "Pod" },
  "art": { "kind": "generated", "generator": "spaceship" },
  "phrases": {
    "assigned": ["On it!", "Leaf it to me."],
    "heading_out": ["Heading out.", "Off to the pod."],
    "done": ["Fresh and done!", "All wrapped up."],
    "error": ["Oops, wilted.", "That didn't take."],
    "waiting": ["Need your say-so.", "Your call?"],
    "lounge": ["Back to the greenhouse.", "Watering break."],
    "delegating": ["Could you grab this?", "Over to you."],
    "arrive": ["Hello, hub!", "New sprout here."]
  }
}
```

A test (`tests/userThemes.test.ts`) keeps this example valid.

## 10. For contributors: adding a built-in theme

1. Write a generator in `src/renderer/themes/generators/<id>.ts`, returning `GeneratedArt`. See
   `generators/types.ts` and `spaceship.ts`. Generators are pure: they draw into `PixelBuffer`s
   with no DOM.
2. Register it in `src/renderer/themes/generators/index.ts`.
3. Add `themes/<id>/theme.json`. The loader bundles every `themes/*/theme.json` automatically.
4. Run `npm test` (manifest validation) and check every state visually with `npm run demo`, then
   switch themes with `/station theme <id>`.

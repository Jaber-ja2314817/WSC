# Asset licenses

## Built-in art: generated in code (MIT)

All art in the built-in themes is **generated programmatically** when the app starts, by the TypeScript generators in `src/renderer/themes/`:

- **Spaceship:** `generators/spaceship.ts`
- **Office:** `generators/office.ts`
- **Home:** `generators/home.ts`
- **Terminal:** `generators/terminal.ts`
- **Crew characters:** `crew.ts`

Every sprite, tile, prop, gear icon and backdrop is drawn pixel by pixel from code in this repository. It is covered by the project's [MIT license](LICENSE). No image files are shipped for the built-in themes, and none were traced or derived from third-party art.

The catchphrases in each `themes/*/theme.json` are original writing, also MIT. They don't quote films, TV series or games.

## Fonts

WSC bundles no fonts. Text uses the operating system's monospace fonts through CSS (`ui-monospace`, `SF Mono`, `Menlo`, `Consolas`, `monospace`).

## Third-party assets

None.

## Community themes

Each community theme declares its own `author` and `license` in its `theme.json`. If a theme in this repository includes non-generated art, list it here:

| Theme | Asset | Author | License | Source |
| ----- | ----- | ------ | ------- | ------ |
| —     | —     | —      | —       | —      |

Only original or CC0 / MIT-compatible art is accepted. Characters, logos and art from games, films or other IP, and Anthropic or Claude branding, are not allowed.

# README assets

The pictures under `.github/readme/` come from two places, and the README says
which is which.

| Asset | Made by | Source of truth |
|---|---|---|
| `verify.svg` | `node scripts/readme/verify.mjs` | **The live site.** The script performs every request the picture shows (site, gate, origin lock, CSP header) and prints what came back. If an answer differs from the claim written beside it, it exits 1 and writes nothing, so the README can never show a passing check that is failing today. Re-run it after anything that changes those answers; the timestamp line records when it last ran. |
| `hero.jpg`, `path.jpg`, `social.jpg` | ChatGPT's image model, from a written brief | The brief names every word in the picture, and every word is a claim the README makes in text next to it. When the query path or a claim changes, re-brief the picture in the same pass that edits the prose. JPEG quality 95. `social.jpg` is the hero scaled to 1280×640 for GitHub's 1 MB social-preview cap and is uploaded by hand at Settings → General → Social preview; there is no API for it. |

## Why SVG for the terminal, and how it looks the same everywhere

GitHub serves README images through its camo proxy inside an `<img>`, which
loads no external fonts, stylesheets or scripts. So `verify.svg` embeds Space
Mono (SIL OFL, `src/fonts/OFL.txt`) from the same Latin-subset files the site
self-hosts, and pins every monospace run with `textLength` so alignment
survives a fallback font. The typing animation is SMIL, which renders inside
`<img>` on GitHub; a `prefers-reduced-motion` rule turns the cursor blink off.
One dark terminal serves both GitHub themes.

## Zero dependencies

`lib.mjs` and `verify.mjs` use Node's standard library only. A package added to
draw a README picture would be one more thing the OpenSSF Scorecard
Vulnerabilities check has to watch forever.

## Checks

`scripts/check-readme-links.mjs` (CI, and `npm run check:links`) fails when a
relative link, image or `#anchor` in the README or `docs/` stops resolving.

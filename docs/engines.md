# Engine coverage

Back to the [README](../README.md).

## Engine coverage

SearXNG's catalog spans **155+ engines**, and self-hosters get all of it. The hosted instance runs a **curated set that works from behind a VPN**, kept honest by measurement rather than by hope.

**Live for web search:** Brave, Bing, DuckDuckGo, Yandex, Crowdview, searchmysite. Plus per-category engines for news, images, videos, science, developer sources (GitHub, GitLab, Stack Overflow, npm, PyPI, crates.io, Docker Hub, MDN, Hugging Face, NVD), social, and files. The exact set, with a dated reason next to every disabled engine, is in [`infra/searxng/settings.yml`](../infra/searxng/settings.yml).

**Why not Google, Mojeek, Qwant?** They block datacenter IP ranges wholesale, and every VPN exit is a datacenter IP. Tested and confirmed; no exit unblocks them. That is the privacy-versus-coverage trade-off made explicit: **the engines that cannot see you are the engines you get.**

**Why engines get removed.** Presearch was dropped in August after it ignored the per-engine timeout and pinned every search at a constant 5.2 s; without it, searches complete in roughly one second with *more* results. Startpage went for chronic CAPTCHAs behind VPN. Broken engines are disabled rather than left to time out. That policy is why the site is fast.

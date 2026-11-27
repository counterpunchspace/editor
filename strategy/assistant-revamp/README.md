# Assistant revamp

Plan and status for the AI assistant’s next stage: chat history per font, a model picker with live per-prompt prices and quality, strict zero data retention (ZDR) everywhere, image input, credit and overage display, tool hints, and new reference and engineering tools. This file is the hand-off: what was decided, what already shipped, and what is left.

## Files

| File | What it is |
| --- | --- |
| `full-plan.html` | The full plan with every decision, the interactive model picker mockup (switch for normal, low-credit and overage states), the chat panel and history mockup, the thumbs mockup, the credit meter mockups, the tool hint table, drafts of the four handbook pages, phases and the decision log. Open it in a browser. |
| `minimal-plan.html` | The minimal plan that was implemented first: DeepSeek Flash reliability, caching and ZDR (steps A0–A8 on the website, B1–B4 in the editor), with the checks to run after deploying. |
| `live-check.mjs` | A script that drives a local website’s `/api/ai/assistant` like the editor does, to check pinning, caching and speed rows with real Flash replies. Its header says how to run it. |

Both HTML files are snapshots of the plans as agreed on 22–24 Nov 2026. Where this README and the HTML disagree, this README is newer.

## Status

The minimal plan shipped in production release **v0.4.5** (editor `7671c44d`, website `ca087bf`, both also in preview `v0.0.67-pre.20261124` and later). Everything else in the full plan is still to do.

### Done

From the minimal plan, all steps:

- **A0** One structured log line per assistant step (`assistant_step`: provider, endpoint tag, pin kept/new/moved, attempt, first prompt, round, time to first token, cached tokens, cost) and `assistant_flash_failure` / `assistant_fallback_failure` lines. No user id, no content.
- **A1** A failed route refresh keeps the last good route. Routes are stored under the key `assistant:zdr-v1` (`ROUTE_POLICY` in `website/utils/ai-route-store.js`), so builds under other rules never share a row. Raising the policy starts from no route on the next deploy. The deploy health check and the first request refresh a missing route straight away.
- **A2** Only failures a re-probe can fix (thrown fetch, 5xx, 404) demote and re-probe. A user’s own 4xx goes straight to Luna.
- **A3** The hourly cron always reaches the route refresh, even when maintenance throws.
- **A4** A stream that ends without a usage chunk still sends done, bills, and runs the empty-reply guard.
- **A5** The previous first endpoint keeps its place unless it fails or is clearly worse (`keepPrevious`, 15 % margin).
- **A6** Strict ZDR (`PRIVACY` in `website/plugins-worker/review/ai-route.mjs`) on every Flash, Luna and probe request. Luna is served by Azure under ZDR.
- **A7** Speed ranking: endpoints within 1.3× of the cheapest passing price compete on expected reply time; `ai_route_speed` stores real time to first token and output speed per endpoint. The first prompt of a new chat already hits the shared cache of the static system prompt (about 95 % cached in the live check).
- **A8 / B4** Each chat is pinned to one endpoint: every Flash request names one tag, the done event returns `providerPin`, the editor sends it back on every request.
- **B1 / B2** The system prompt is identical every round in the assistant and the glyph filter chat; editor state, permission and filter code go in a labelled last message that is never stored.
- **B3** 503 and 504 are retried; finished tool rounds survive an error or a stop.

Added while testing live, beyond the minimal plan:

- OpenRouter’s catalog is fetched with the API key, because only then does it include each endpoint’s `latency_last_30m` and `throughput_last_30m`.
- Probes go only to endpoints on OpenRouter’s `/endpoints/zdr` list.
- Output speed is recorded only for streams of at least 50 visible tokens over 300 ms, without reasoning tokens. The ranking never mixes our measurements with OpenRouter’s figures.
- **Plugin preflight (security review) is strict ZDR too**: the `review` profile, its routing and its probes send `zdr: true`.
- `/api/health?ai=1` makes one tiny real request to Flash (on the route’s first endpoint, with the assistant’s routing) and to Luna. It fails only when both fail. `editor/scripts/wait-for-stack.mjs` reports the route policy, a one-sided live failure and a missing speed table as non-blocking warnings, so staging, preview and production cutovers now check this.

### Missing, by phase of the full plan

| Phase | State | What is left |
| --- | --- | --- |
| P0 Strict ZDR | Done | Nothing for today’s models. Each new model gets the same `PRIVACY` routing. |
| P0b Caching | Done for Flash | Claude `cache_control` breakpoints and GPT `prompt_cache_key` once those models exist. A per-chat idle rule is not needed: staying on the pinned endpoint is never worse. |
| P1 Server model registry | Not started | Catalog sync with version gate and curation (`ai_model_versions`), our own “Latest” resolution, `model` and `version` request parameters with an allow-list, routing profiles for the other open-weight models, `ai_prompt_metrics` (price window of 200 chats per model, quality window of 500 prompts per model and provider, 180-day limit), `ai_model_price_stats` (low, high, avg), seed rows for new versions, the token-profile estimate for new families, `/api/ai/settings` with prices, credit, renewal date and overage total. A0’s log line and `ai_route_speed` are a start but are not these tables. |
| P1b Benchmark | Not started | Font task suite, seed run for every model and provider, nightly cron within the approved €5–15 a month. |
| P2 Picker UI | Not started | Model chip and picker in the chat and both filter modes: three columns, maker line for open weight, Quality and Per prompt dot lines shared by cards and version rows, at most three badges (Cheapest, Fastest, Best quality), version menu, per-reply model labels, Retry on an unavailable model, model memory per chat and per surface. Credit meter, low and overage banners, doubled prices in overage, higher-plan line. |
| P2b Quality and feedback | Not started | Signal counters, live `ai_quality_stats`, thumbs up and down (no text, no contact; thumbs down fails the prompt, thumbs up cancels its soft signals), unrecovered-failure rule for Python errors, internal view with stumbles and docs-first refusals per model. |
| P2c Tool hints | Not started | Read-only, consequential or unsafe hint on every tool, badges in the tool dialog and on tool cards, description tags and toolbox rules for the model, coverage test, later WebMCP mapping. |
| — Docs first | Not started | System prompt line “Before your first Python code in a chat, call `python_api_docs`” and the editor block on the four Python tools until it has been read. Counted per model in the internal view, never against quality. |
| P3 Chat persistence | Not started | History per font in localStorage (compressed records, LRU), history picker beside **+**, restore-equals-original DOM test, filter chats in sessionStorage with Clear chat. Save `providerPin` and the model per chat with each record. |
| P4 Images | Not started | Image size experiment first, then content-part messages, `snapshot_canvas` with per-model size and `region`, thumbnails in tool cards, images in IndexedDB. A key exists in `website/.dev.vars`; confirm it is a development key with a spend limit and ZDR-only routing in its OpenRouter settings before running the experiment. |
| P5 Reference tools | Not started | FEA spec bundle, OpenType proxy, tag and Unicode registries. |
| P6 Engineering tools | Not started | `fea_check`, `interpolation_check`, `glyph_grid`, `render_proof`, `ttx_dump`, `qa_checks`, then the rest. |
| Docs | Not started | New handbook page `ai/04-models-and-prices.md` and the revised AI pages, drafted in `full-plan.html`. Each ships with the phase it describes. |

### Open decisions

- **Price ceiling for speed.** At 1.3× only the cheapest endpoint usually competes on speed (in the live check the faster endpoints cost 1.35–1.8×; the fastest would answer in about 3.4 s instead of 6.4 s for still a fraction of a cent). Raising `SPEED_PRICE_CEILING` to about 2× would let speed count.
- **Thinking levels.** Not in either plan. Recommendation from the discussion: no user control; one fixed level per model, chosen by the benchmark when a version is added and treated as part of the version.
- **The development OpenRouter key and account settings** for the image experiment (see P4).

## Notes for the next agent

- `provider.order` switches off OpenRouter’s own sticky routing, so per-chat stickiness is entirely ours (A8/B4).
- On DeepSeek through OpenRouter, cache reads cost 0.1× the input price and writes 1×. A cache miss on a long chat is expensive.
- OpenRouter publishes no cache lifetime for third-party DeepSeek hosts; DeepSeek’s own API clears unused cache within hours to days.
- The browser pane’s launcher (`preview_start`) blocks outbound network for the server it starts. Start the website from a shell for anything that calls OpenRouter.
- Preview and production share D1, so anything stored per route or per model must not let an older build overwrite a newer one (see `routeKey`).
- The shared routing code in `website/plugins-worker/review/ai-route.mjs` serves both the assistant (`assistant` profile) and plugin preflight (`review` profile, through `route.mjs`, which forces that profile).

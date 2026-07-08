# Applaud Backlog

Findings and proposed improvements from a full code review of the project (server, web UI, shared package, installers, and docs). Items are grouped by theme and tagged with a suggested priority:

- **P1** — bugs or gaps that block or badly confuse users; fix first
- **P2** — high-value usability/feature work
- **P3** — polish, nice-to-haves, and longer-term ideas

---

## 1. Bugs & correctness

### 1.1 No way to re-authenticate after the token expires — P1
When the Plaud token expires or is revoked, the poller sets `authRequired` and the UI shows an "auth required" badge (`web/src/components/SyncStatusBadge.tsx:42`), but there is no path to fix it: `/setup` redirects back to `/` once `setupComplete` is true (`web/src/App.tsx:27`), and the Settings page has no token entry UI. The `/api/auth/*` endpoints exist but are unreachable from the UI. Tokens last ~10 months, so this is rare but fatal when it happens — the only workaround is hand-editing `settings.json`.
**Fix:** add a "Reconnect Plaud account" section to Settings (reusing the AuthStep detect/watch/manual-paste flow), and make the "auth required" badge link to it.

### 1.2 Per-recording Resync fails with "webhook failed" when no webhook is configured — P1
`POST /api/recordings/:id/resync` treats a false return from `fireWebhookForRecording` as a hard error and responds 502 (`server/src/routes/recordings.ts:216-220`). But `fireWebhookForRecording` also returns false when no webhook is configured or it is disabled (`server/src/webhook/post.ts:166`). Result: for users without a webhook, every resync appears to fail even though the assets were re-downloaded successfully.
**Fix:** distinguish "webhook not configured" (success, skip) from "webhook delivery failed" (502 or a warning in the response).

### 1.3 Poll interval changes don't take effect until restart — P1
The poller captures the interval once in `start()` (`server/src/sync/poller.ts:64-77`) and `POST /api/config` never restarts it. Yet the Settings footer says "Changes take effect immediately on local engine" (`web/src/routes/Settings.tsx:436`).
**Fix:** on config save, if `pollIntervalMinutes` changed, `poller.stop(); poller.start()` (or have the poller re-read config each cycle).

### 1.4 Trash and Settings unreachable on mobile — P1
The nav links are `hidden md:flex` (`web/src/components/AppShell.tsx:43`) with no hamburger fallback, so on phones the only reachable page is the dashboard.
**Fix:** add a mobile menu (hamburger or bottom nav) for Recordings / Trash / Settings.

### 1.5 Live status updates die permanently after any SSE hiccup — P2
`SyncStatusBadge` closes the `EventSource` on the first error and never reconnects (`web/src/components/SyncStatusBadge.tsx:35`). After a laptop sleep or transient network error, the badge silently falls back to 10-second polling only, and other components lose the invalidation signal until page reload.
**Fix:** let `EventSource` auto-reconnect (don't call `close()` in `onerror`), or implement reconnect with backoff.

### 1.6 Dashboard row Resync swallows errors — P2
`resyncRecording` on the dashboard has `try/finally` with no `catch` (`web/src/routes/Dashboard.tsx:111-126`); a failure produces an unhandled promise rejection and no user feedback — the spinner just stops. (The detail page does this correctly with `setResyncError`.)
**Fix:** catch and surface errors, ideally as a toast (see 3.4).

### 1.7 `plaudFetch` mutates config on 401 — P2
On a 401, the client calls `updateConfig({ setupComplete: true })` before throwing (`server/src/plaud/client.ts:90`). A low-level HTTP helper silently writing settings is surprising; if it's meant to keep the app out of the setup wizard on token expiry, that state transition belongs in the poller/auth layer, and setting it to the value it already has is a no-op that hides intent.
**Fix:** remove or move this side effect and document the intended expired-token flow (ties into 1.1).

### 1.8 Suffix byte ranges are mishandled in the media server — P2
For `Range: bytes=-500` (meaning "last 500 bytes"), the parser yields `start=0, end=500` (`server/src/routes/media.ts:70-84`) — the wrong bytes with a 206 status. Safari in particular uses suffix ranges when probing audio.
**Fix:** implement suffix-range semantics, or respond 200 with the full body when the form isn't supported (never a wrong 206).

### 1.9 Poll interval slider max (60) disagrees with API max (120) — P3
`PatchSchema` allows up to 120 minutes (`server/src/routes/config.ts:33`); the Settings slider stops at 60 (`web/src/routes/Settings.tsx:389`). A config set to >60 out-of-band renders the slider incorrectly.
**Fix:** align the two (and consider labeled presets instead of a slider — see 3.6).

### 1.10 Webhook / test User-Agent is hardcoded to `applaud/0.1.0` — P3
The project is at 0.5.10 but outgoing webhooks still send `applaud/0.1.0` (`server/src/webhook/post.ts:187`, `:314`), and the README documents that stale value.
**Fix:** read the version from package.json at build time and use it in the UA header (and expose it in the UI footer / an `/api/version` endpoint — useful for support).

### 1.11 `countErrorsLast24h` misses most errors — P3
The query counts rows with `last_error` set *and* a download timestamp in the last 24h (`server/src/sync/state.ts:391-399`), so recordings that error before ever downloading anything (the common failure case) are never counted. The value is also returned by `/api/sync/status` but never shown in the UI.
**Fix:** track error recency with a dedicated `last_error_at` column, and actually surface the count (see 2.3).

### 1.12 LIKE search doesn't escape wildcards — P3
Search terms are interpolated into `LIKE '%…%'` without escaping `%`/`_` (`server/src/sync/state.ts:217`), so searching for literal `%` or `_` gives confusing results. Superseded by FTS5 (see 5.1), otherwise escape with `ESCAPE '\'`.

### 1.13 `listAttachments` builds a wrong URL that the caller throws away — P3
The helper sets `url: /media/<relPath>` without the recording folder (`server/src/routes/recordings.ts:38-41`), and the only caller immediately rebuilds the URL with the folder prefix (`:158-161`). Dead/misleading code — return filenames only, or build the correct URL once.

### 1.14 Manual "Sync Now" doesn't update the next-poll time — P3
`poller.trigger()` runs a cycle but never refreshes `nextPollAt` (`server/src/sync/poller.ts:87-94`), so any UI showing "next poll" drifts after manual syncs.

---

## 2. Usability improvements

### 2.1 "Sync Now" blocks until the entire sync finishes — P1
`POST /api/sync/trigger` awaits the full poll cycle (`server/src/routes/sync.ts:24-27`), and the dashboard button spins for the whole duration. A first sync of a large library (hundreds of audio downloads) can run many minutes — long past browser/proxy request timeouts, at which point the UI shows a failure while the sync actually continues.
**Fix:** return `202 Accepted` immediately and report progress via the existing SSE channel; show "syncing" state from `/api/sync/status`.

### 2.2 No sync progress feedback during initial import — P1
During the first big sync there is no indication of progress — just "syncing" and rows appearing. Users can't tell whether it's stuck.
**Fix:** extend `PollerStatus` with counters (e.g. `discovered`, `downloaded`, `remaining`, current filename) emitted over SSE, and render a progress bar/toast on the dashboard. Pairs with 2.1.

### 2.3 Failed recordings are invisible on the dashboard — P2
`last_error` is only shown if you open a recording's detail page (`web/src/routes/RecordingDetail.tsx:484`). A recording stuck in a retry loop looks merely "pending" in the list.
**Fix:** add an error badge to dashboard rows with the error text on hover/click, and a "N errors" filter chip fed by a fixed `errorsLast24h` (see 1.11).

### 2.4 No pagination — libraries over 200 recordings are silently truncated — P2
The dashboard requests `limit: 200` with no paging UI (`web/src/routes/Dashboard.tsx:106`), while the header shows the true total ("312 items total" but only 200 rendered). Trash has the same issue (`web/src/routes/Trash.tsx:20`).
**Fix:** infinite scroll or a "Load more" button using the existing `offset` parameter (the API already supports it).

### 2.5 Search fires a request on every keystroke — P2
The search input feeds straight into the query key (`web/src/routes/Dashboard.tsx:104-107`) with no debounce, generating a burst of LIKE-scans per word typed.
**Fix:** debounce ~300 ms and keep the previous results while loading (`placeholderData: keepPreviousData`) to stop flicker.

### 2.6 Search results give no context — P2
Transcript search only tells you *that* a recording matched, not *where*. Users must open each recording and re-search inside the transcript.
**Fix:** return a highlighted snippet per match from the API and render it under the row title; clicking could deep-link to the detail page with the query pre-filled in the transcript search.

### 2.7 Attachments are fetched by the API but never shown — P2
`GET /api/recordings/:id` returns an `attachments` array (extra Plaud notes, images, polished transcripts — `server/src/routes/recordings.ts:155-162`), but `RecordingDetail.tsx` never renders it. The extra markdown notes the poller carefully downloads (`downloadContentListMarkdown`) are invisible in the UI.
**Fix:** add an "Attachments / Notes" card on the detail page listing the files with view/download links, rendering `.md` inline.

### 2.8 Recording detail lacks transcript/summary download buttons — P3
Only `audio.ogg` gets a download link (`web/src/routes/RecordingDetail.tsx:383`). Users wanting `transcript.txt`, `transcript.json`, or `summary.md` must know the `/media/...` URL scheme.
**Fix:** add a small download menu (audio / transcript .txt / transcript .json / summary .md / open folder).

### 2.9 Audio player is missing table-stakes controls — P2
No playback speed (huge for reviewing meetings at 1.5–2×), no volume/mute, no keyboard shortcuts (space = play/pause, ←/→ = seek). All state is already in place in `RecordingDetailPage`.
**Fix:** add a speed selector (0.75×–2×, persisted in localStorage), volume control, and key bindings scoped to the detail page.

### 2.10 Token expiry is only visible if you open Settings — P3
Settings shows "Expires in N days" (`web/src/routes/Settings.tsx:227`), but nothing warns proactively.
**Fix:** show a dismissible banner (or badge state) when expiry is under ~14 days, linking to the reconnect flow from 1.1.

### 2.11 Setup wizard: webhook test forces a detour — P3
On the Settings page, a newly typed signing secret can't be tested until saved, which the UI explains with a warning box (`web/src/routes/Settings.tsx:324-328`). Better: let `POST /api/config/test-webhook` accept an optional secret override so Test always uses what's on screen.

### 2.12 Unsaved-changes are silently discarded — P3
Settings tracks `dirty` but navigating away loses edits without warning.
**Fix:** prompt on navigation when dirty (router blocker), or switch to auto-save per section.

---

## 3. User interface improvements

### 3.1 Real waveform instead of decorative noise — P2
The waveform is generated from a PRNG seeded by the recording id (`web/src/components/Waveform.tsx:9-21`) — it looks like audio data but is fake, which undermines trust and makes click-to-seek less useful (peaks don't correspond to speech). The README advertises "waveform visualization".
**Fix:** compute real peaks client-side with `AudioContext.decodeAudioData` on the already-fetched audio (cache peaks in localStorage or a sidecar JSON generated at sync time for long files).

### 3.2 Replace native `confirm()` dialogs with styled modals — P2
Trash/purge/blocklist actions use `window.confirm` (`web/src/routes/RecordingDetail.tsx:214`, `web/src/routes/Trash.tsx:36`, `web/src/routes/Settings.tsx:180`), which clashes with the otherwise polished design, can't be styled, and truncates the long explanatory text poorly.
**Fix:** a small `ConfirmDialog` component (danger variant for purge) used everywhere.

### 3.3 Summary card renders with `prose-invert` in light mode — P3
Both summary renderings hardcode `prose-invert` (`web/src/routes/RecordingDetail.tsx:431`, `:464`). Most colors are overridden by explicit `[&_*]` classes, but anything not overridden (blockquotes, code blocks, hr, tables) will use inverted colors in light theme.
**Fix:** drop `prose-invert` and rely on the token-based overrides, or gate it on the active theme.

### 3.4 No toast/notification system — P2
Background events (sync errors, webhook failures, resync results) have nowhere to surface except page-local text. Several fixes above (1.6, 2.2, 2.3) want a shared toast component.
**Fix:** add a lightweight toast provider in `AppShell` fed by mutations and the SSE stream.

### 3.5 Icon-only buttons lack accessible names — P3
Resync, expand-summary, search, close, prev/next buttons rely on `title` only; inline SVGs have no `aria-hidden`/labels; status is sometimes conveyed by color alone (status dots, sync badge).
**Fix:** add `aria-label` to icon buttons, `aria-hidden="true"` on decorative SVGs, and check color-contrast on the pill/badge text.

### 3.6 Settings layout polish — P3
- The green "All systems operational" label is styled `text-secondary` even when unhealthy (`web/src/routes/Settings.tsx:135`) — only the dot changes color.
- Slider labels read "1 min / 30 mins / 60 mins" but the scale's midpoint isn't visually anchored; consider preset chips (5/10/15/30/60) instead of a slider.
- "Pending: N transcripts" tile could link to a filtered dashboard view.

### 3.7 Empty states could do more — P3
The dashboard empty state says "Click Sync now" (`web/src/routes/Dashboard.tsx:195-201`) — good, but the first-run state (sync in progress) and the "no results for search" state are indistinguishable from "no recordings".
**Fix:** dedicated empty states: first sync running (spinner + progress), no search matches ("no results for 'x'"), and genuinely empty library.

### 3.8 Show "next sync at" in the UI — P3
The API exposes `nextPollAt` but nothing renders it. Add it to the sync badge tooltip and the Settings status card ("next poll in 7m") — after fixing 1.14.

---

## 4. Feature enhancements

### 4.1 Webhook delivery log & manual redelivery — P2
Every attempt is already logged to the `webhook_log` table (`server/src/webhook/post.ts:144-159`) but there is no way to see it. Debugging n8n integrations currently means watching server logs.
**Fix:** a "Webhook activity" panel in Settings (or its own page): recent deliveries with event, status code, duration, response snippet, and a "redeliver" button. Also prune the table (e.g. keep 30 days) — today it grows forever.

### 4.2 Multiple webhook destinations — P3
Only one URL is supported (`AppConfig.webhook`). Users mixing n8n + a custom endpoint must fan out themselves.
**Fix:** make `webhook` an array with per-destination enable/secret/event filters. Keep single-webhook config auto-migrating.

### 4.3 Webhook event filtering — P3
Both `audio_ready` and `transcript_ready` always fire. Many workflows only care about `transcript_ready`.
**Fix:** per-destination event checkboxes.

### 4.4 Bulk actions — P2
No multi-select anywhere: can't trash several recordings, resync a batch, or "Empty trash" in one click (`web/src/routes/Trash.tsx` requires per-row purging).
**Fix:** checkbox selection on dashboard and trash lists with bulk trash/restore/purge/resync; an "Empty trash now" button.

### 4.5 Date-range and status filtering — P3
Beyond text search there's no way to narrow the list (by month, device serial, has-summary, pending, error).
**Fix:** filter chips + a date picker; all filterable server-side with the existing SQL.

### 4.6 Export / integration niceties — P3
- "Download all as ZIP" for a recording (audio + transcript + summary + notes).
- Obsidian-style export is currently a PowerShell script in `scripts/` — consider a first-class "export templates" feature or at least document the script in the README.
- Optional `.srt`/`.vtt` transcript export (subtitle formats are widely consumable and easy to derive from the segment JSON).

### 4.7 Speaker management — P3
Transcripts label speakers "Speaker 1/2/…" with distinct colors (`web/src/routes/RecordingDetail.tsx:63-79`). Letting users rename speakers per recording (persisted to DB, applied to transcript.txt regeneration and webhook payloads) would make transcripts far more useful.

### 4.8 Two-way trash sync (opt-in) — P3
Deleting in Applaud never touches Plaud (by design), but some users will want "delete everywhere". An explicit, clearly-labeled opt-in action ("Also delete from Plaud") would round out lifecycle management. Requires the undocumented delete endpoint — mark experimental.

### 4.9 Recording notes/tags — P3
Local-only tags or a freeform note per recording (searchable) would help triage large libraries without depending on Plaud metadata.

### 4.10 Health endpoint & metrics — P3
A `/api/health` (or `/healthz`) endpoint returning sync status, DB availability, and version would help Docker healthchecks and uptime monitors; the Dockerfile currently has no `HEALTHCHECK`.

---

## 5. Performance & scalability

### 5.1 Full-text search via SQLite FTS5 — P2
Search does `LIKE '%q%'` over the full transcript text of every row (`server/src/sync/state.ts:217-241`) — an O(library size) scan per keystroke (see 2.5). SQLite ships FTS5; better-sqlite3 supports it out of the box.
**Fix:** add an FTS5 virtual table over `filename + transcript_text` maintained by triggers; enables ranked results and cheap snippet extraction (2.6).

### 5.2 Sequential asset downloads — P3
Phase 2 processes recordings strictly one at a time (`server/src/sync/poller.ts:203-211`). First-time syncs of large libraries are slow.
**Fix:** small concurrency pool (e.g. 3) with care for webhook ordering guarantees.

### 5.3 `SELECT *` for pending work — P3
`findRecordingsNeedingAssets` loads every needy row including full `transcript_text` into memory (`server/src/sync/state.ts:401-407`). Select only needed columns, or exclude `transcript_text` from `RecordingDbRow` mapping for list contexts.

### 5.4 Recording list payload includes heavyweight fields — P3
`rowToRecording` is shared between list and detail; check whether list responses ship fields the dashboard never uses. A slimmer list DTO reduces payload for large pages (relevant once 2.4 lands).

---

## 6. Security & hardening

### 6.1 No authentication on the web UI / API — P2
When bound to `0.0.0.0` (Docker default, `server/src/index.ts:123`), anyone on the network can browse recordings, read transcripts, change the webhook URL (exfiltrating all future transcripts), or purge data. Default `127.0.0.1` binding is safe, but the Docker path isn't.
**Fix:** optional access token / basic auth (config + `Authorization` middleware), strongly recommended-on when bind host ≠ loopback. At minimum, document the exposure in the README Docker section.

### 6.2 Webhook URL SSRF is unbounded — P3
The webhook/test endpoints will POST full transcript content to any URL including link-local/metadata addresses. For a self-hosted tool this is mostly the owner's choice, but combined with 6.1 (unauthenticated config API) it becomes an exfiltration primitive.
**Fix:** 6.1 addresses the main risk; optionally warn when the webhook host is not private/localhost and the UI is network-exposed.

### 6.3 Media routes serve any file under recordings dir — P3 (informational)
Path traversal is handled well (`resolveSafe`, realpath containment). Remaining nit: symlinks *inside* the recordings dir pointing outside are resolved and rejected — good. Keep the regression tests around this.

### 6.4 Token at rest — P3 (documented)
Bearer token is plaintext in `settings.json` with `0600`, README discloses it, keychain integration listed as future work. Keep on the backlog: OS keychain via `keytar`-alternative, or at least optional encryption with a user-supplied passphrase.

### 6.5 `APPLAUD_CONFIG_DIR` doubles as "Docker mode" — P3
Setting the env var also disables the PID lock and forces `0.0.0.0` binding (`server/src/index.ts:82`, `:123`) — surprising for anyone using it just to relocate config on a host install.
**Fix:** separate `APPLAUD_DOCKER=1` (or explicit `APPLAUD_BIND_HOST`) from the config-dir override.

---

## 7. Code quality & developer experience

### 7.1 Test coverage gaps — P2
Good unit tests exist for jwt, transcript parsing, layout, state, poller, webhook signing/posting, and config helpers. Untested: all Express routes (recordings CRUD/restore/purge/resync status codes, media range handling — see 1.8), `plaudFetch` retry/region fallback, and the entire web UI (zero component tests).
**Fix:** supertest-based route tests first (they encode the contract the UI depends on), then a couple of Playwright smoke tests (setup wizard happy path, dashboard renders).

### 7.2 Extract shared helpers in the web app — P3
`formatDuration`, `formatDate`, `formatBytes`, `formatRelative` are duplicated across Dashboard, RecordingDetail, Trash, Settings, and SyncStatusBadge with slightly different behavior. Move to `web/src/lib/format.ts`.

### 7.3 Duplicated folder-walk logic — P3
`listAttachments` (`server/src/routes/recordings.ts:25-47`) and `discoverAssets` (`server/src/webhook/post.ts:37-64`) implement the same recursive walk with the same `CORE_FILENAMES` set defined twice. Extract one helper in `sync/layout.ts`.

### 7.4 README drift — P3
- "guided 5-step onboarding (auth, folder, webhook, review)" lists four steps for a five-step wizard (Welcome missing).
- Webhook UA documented as `applaud/0.1.0` (see 1.10).
- Install URLs pin `v0.5.10` and reference `rsteckler/applaud`; verify these stay correct for this fork or make them tag-agnostic.

### 7.5 Both `package-lock.json` and `pnpm-lock.yaml` are committed — P3
The project is pnpm-based (`packageManager: pnpm@9.12.0`); the npm lockfile invites accidental `npm install` and drift. Remove `package-lock.json` (or document why it exists, e.g. for a Docker stage).

### 7.6 Config file writes aren't atomic — P3
`saveConfig` does a direct `writeFileSync` (`server/src/config.ts:31`); a crash mid-write corrupts `settings.json` (which then silently resets to defaults, dropping the token). Write to a temp file and rename; same for any future state files.

### 7.7 Version the DB schema — P3
Migrations are "try ALTER and swallow the error" plus unconditional backfills that run on every boot (`server/src/db.ts:44-180`) — including a full-table `UPDATE ... WHERE summary_downloaded_at IS NOT NULL` and disk stats per row. Adopt `PRAGMA user_version` so each migration and backfill runs exactly once.

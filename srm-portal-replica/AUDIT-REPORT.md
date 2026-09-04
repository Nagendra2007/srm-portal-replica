# srm-portal-replica — Security & Performance Audit

**Reviewed:** 4 September 2026
**Scope:** all 12 files, 5,802 lines — every backend module, `frontend/login.html` in full, `nginx.conf`, and both `package.json` files.
**Focus, as requested:** performance / load speed, and security / best practices.

---

## How to read this

Every finding below is something I actually located in your code, with the file and line it lived on. Fixed files are in `srm-portal-fixed/`, laid out identically to your repo so you can diff directory against directory. Each fix carries a `FIX:` comment at the point of change explaining what was wrong, so the reasoning survives in the code rather than only in this document.

Two things I want to flag before the findings, because they affect how much weight to give the rest:

**I ran the server, but never against SRM.** After the first crash report I was able to boot `backend/server.js` and confirm end-to-end: it starts and answers `/healthz` with 200, all five security headers are present, `x-powered-by` is gone, gzip is active on the wire, and `SIGTERM` exits cleanly. All 7 backend modules pass `node --check`, all 25 cross-module imports resolve, both inline `<script>` blocks in the patched HTML parse, and the escaping helper is unit-tested against eight payloads. What is still **not** verified is anything requiring the real SRM portal — login, scraping, attendance — and anything requiring the OCR model, since the sandbox has no route to the tesseract CDN. Test those flows yourself.

**I could not verify dependency versions.** The registry is unreachable from here, so the version note in finding 20 is reasoning, not a lookup. Confirm it locally.

---

## Findings by severity

| # | Severity | Finding | Location |
|---|---|---|---|
| 1 | Critical | Passwords written to stdout in cleartext | `backend/routes/auth.js:59-60` |
| 2 | Critical | Passwords stored in `localStorage` in cleartext | `frontend/login.html:4174, 4038` |
| 3 | Critical | SSRF — server fetches any URL a caller supplies | `backend/routes/portal.js:267, 282` |
| 4 | Critical | Credentials cross the network over plain HTTP | `nginx.conf:56` |
| 5 | Critical | Login check fails **open** on an empty response | `backend/services/srmPortalService.js:431-433` |
| 6 | High | DOM XSS — 40 unescaped `innerHTML` writes | `frontend/login.html`, throughout |
| 7 | High | Session token embedded in an `<img>` URL | `backend/routes/portal.js:112` |
| 8 | High | No rate limit on `/api/login` | `backend/routes/auth.js:37` |
| 9 | High | CORS wide open to every origin | `backend/server.js:15-17` |
| 10 | High | OCR worker race creates duplicate Tesseract workers | `backend/services/srmPortalService.js:228-250` |
| 11 | High | Session store unbounded — memory-exhaustion DoS | `backend/services/clientSessionStore.js:6` |
| 12 | High | nginx will not start: `log_format main` undefined | `nginx.conf:19` |
| 13 | High | No compression — 150 KB shell sent uncompressed | `backend/server.js` |
| 14 | High | Internal error text returned to the browser | `backend/routes/auth.js:115` |
| 15 | Medium | `/courses` null dereference → 500 | `backend/routes/portal.js:170` |
| 16 | Medium | Captcha failure falls back to the literal `'SRM'` | `backend/routes/auth.js:84` |
| 17 | Medium | No request timeouts — serialized queue can stall forever | `backend/services/clientSessionStore.js:16-21` |
| 18 | **High** | Missing OCR model **crashes the process**; `langPath` depended on cwd | `backend/services/srmPortalService.js:233` |
| 19 | Medium | Dead duplicate `/api/session` route | `backend/server.js:32-44` |
| 20 | Medium | `cors: ^2.8.6` — version probably does not exist | `package.json:15` |
| 21 | Medium | Two dependency lists, no lockfile | `package.json` + `backend/package.json` |
| 22 | Medium | `photoCache` and `reportCache` unbounded | `portal.js:244`, `reportCache.js:1` |
| 23 | Medium | Only one redirect hop followed after login | `srmPortalService.js:473-484` |
| 24 | Medium | nginx: forced `Connection: upgrade`, no upstream keepalive | `nginx.conf:64` |
| 25 | Medium | No security headers anywhere | `server.js`, `nginx.conf` |
| 26 | Medium | Render-blocking font CSS, 10 weights | `frontend/login.html:15` |
| 27 | Medium | `user-scalable=no` blocks pinch-zoom | `frontend/login.html:5` |
| 28 | Low | Dark-mode flash before theme resolves | `frontend/login.html:2616` |
| 29 | Low | `'incorrect'` substring match is too broad | `srmPortalService.js:454` |
| 30 | Low | Landing-page marker list duplicated verbatim | `srmPortalService.js:24-31, 441-448` |
| 31 | Low | `/att` re-scrapes the dashboard on every poll | `portal.js:235` |
| 32 | Low | `immutable` cache on non-hashed filenames | `nginx.conf:78` |
| 33 | Low | `metadata.json` describes a different app | `metadata.json` |
| 34 | Low | No favicon → a 404 on every load | `frontend/login.html` |
| 35 | Low | No graceful shutdown; timers keep process alive | `server.js`, various |
| 36 | Low | `.env` never loaded despite `dotenv` dependency | `backend/server.js` |
| 37 | Low | Student photo served with `Cache-Control: public` | `portal.js:277` |

---

## Critical

### 1. Passwords written to stdout in cleartext

`backend/routes/auth.js:59-60` ran two `console.log` calls on every login attempt — one printing the username, one printing the password. Real SRM passwords landed in the process log, in journald, and in anything shipping logs off the host, where they persist long after the request and are readable by anyone with log access. If this has ever run anywhere real, treat those logs as compromised: rotate them, and tell affected users to change their SRM password.

Both calls are deleted. Nothing on an auth path should log `req.body`; if you need tracing there, log the username alone.

### 2. Passwords stored in `localStorage` in cleartext

"Remember me" called `localStorage.setItem('password', password)`, and every saved profile kept its own password inside the `savedAccounts` array. `localStorage` has no expiry, is plainly readable by any script on the origin, and sits on disk — so on a shared or lab machine the next person has them, and combined with finding 6 a single XSS exfiltrates *every* saved password at once.

Passwords now live in `sessionStorage`, scoped to the tab and cleared when it closes. Session restore and profile switching still work while the tab is open. `savedAccounts` keeps only username and display name.

Two things to know: this is a **deliberate behaviour change** — after closing the browser, the password is re-entered rather than prefilled. The username still prefills and the input keeps `autocomplete="current-password"`, so the browser's own password manager (which is encrypted, unlike `localStorage`) handles the rest. A flag at the top of the script, `PERSIST_PASSWORD_ON_DISK`, restores the old behaviour if you disagree; it defaults to `false`. There is also a one-time migration that purges cleartext passwords your current build already wrote to users' disks — without it, those values would just sit there.

The genuinely correct fix, beyond what I changed, is not to hold the password client-side at all: keep the SRM session server-side and give the browser an opaque `httpOnly` refresh cookie. That is a redesign, not a patch, so I have not attempted it — but it is the right destination.

### 3. SSRF — the server fetches any URL a caller supplies

`/api/photo` read `req.query.src` and passed it straight into axios. Any caller with a session could make your server issue requests to arbitrary URLs and read the bytes back: cloud metadata endpoints like `169.254.169.254`, admin interfaces on `localhost`, anything inside your network perimeter. The server was an open proxy positioned behind your firewall.

Fixed in two layers. `fetchBinaryResource` now runs every URL through `resolveSrmUrl`, which rejects anything that is not `https://student.srmap.edu.in`. And the route no longer accepts a URL at all — see finding 7.

### 4. Credentials cross the network over plain HTTP

`nginx.conf` listened on port 80 with no TLS. This application collects real university passwords; on plain HTTP they are readable by anyone on the path — the campus network, the coffee-shop AP, any transparent proxy. No amount of application-level hardening compensates for this.

I have added a documented TLS block and a redirect pattern to `nginx.conf`, but I deliberately left it commented: it needs your domain and a certificate. `certbot --nginx` will do it in about a minute, and it is the single most important item in this report to action before any real student uses this.

### 5. Login check fails open on an empty response

```js
const isLoginSuccessful = (html) => {
  if (!html || typeof html !== 'string') {
    return true          // <-- empty body counted as a successful login
  }
```

An auth predicate must fail closed. Any condition producing a non-string or empty body — a dropped connection, a timeout, SRM returning 204, a binary response — was reported to the caller as a *successful* login, creating an authenticated session with no authentication behind it. Now returns `false`.

---

## High

### 6. DOM XSS — 40 unescaped `innerHTML` writes

Every render function built markup with template strings and assigned it via `innerHTML`, and not one interpolated value was escaped. There is no escaping helper and no DOMPurify anywhere in the file. Values arrived from three untrusted-ish places: scraped SRM HTML, `localStorage`, and direct user input.

The course search box was directly exploitable. `frontend/login.html:3325` rendered `No courses matching "${filterText}"` — typing `<img src=x onerror=alert(1)>` executed it. Attribute contexts were injectable too: `data-username="${account.username}"` had no quote escaping.

The chain that made this matter: XSS on this origin → read `localStorage` → every saved SRM password (finding 2). Fixing 2 removes the prize; fixing this removes the vector.

I added an `esc()` helper and applied it at 26 call sites across 25 lines, covering course cards, the search query, attendance subject names, timetable slots and day pills, and saved-account rows. Verified inert against eight payloads including tag breakout, attribute breakout in both quote styles, and `</span><script>`, while leaving legitimate text like `Data Structures & Algorithms` and `Dr. A. B. Sharma` rendering correctly.

One deliberate exception: `/api/profile` returns raw scraped SRM HTML that the frontend injects wholesale. Escaping it would render the markup as visible text and break the profile view. It is upstream-trusted content, so I left it — but it is the remaining injection surface, and the CSP I added is what constrains it. Parsing that report into JSON and rendering it yourself is the durable fix.

### 7. Session token embedded in an `<img>` URL

`portal.js:112` built `<img src="/api/photo?src=...&session=${sessionId}">`. Session identifiers in URLs leak into browser history, `Referer` headers on outbound requests, and nginx access logs — the same access log that finding 12's `buffer=16k` line writes to disk.

Replaced with an opaque single-purpose ticket: the server mints a random 24-byte token bound to `{sessionId, photoUrl}` with a 10-minute expiry, and the browser only ever sees the ticket. This also closes finding 3 structurally, since the URL is fixed server-side at mint time and there is nothing left for a caller to tamper with.

### 8. No rate limit on `/api/login`

Nothing throttled login. Because this server relays credentials to the real SRM portal, an unthrottled endpoint makes your deployment a convenient credential-stuffing relay *against your own university* — with your server's IP on the requests.

Added `backend/middleware/rateLimit.js`, a small fixed-window limiter with no new dependency, so the fixes stay drop-in: 8 login attempts and 30 session creations per minute per IP, plus `limit_req` zones at the nginx edge so a flood never reaches the event loop. For more than one instance, swap in `express-rate-limit` with a shared Redis store — a per-process `Map` neither survives a restart nor coordinates across workers, and I have noted that in the file.

### 9. CORS wide open to every origin

`cors()` with no options reflects any origin, and `exposedHeaders: ['X-Client-Session']` deliberately published the session header to it. Any website a logged-in student visited could drive these endpoints and read the session id. Since the frontend is served from the same origin as its API, no cross-origin access is needed at all: the default is now `origin: false`, with an opt-in `CORS_ORIGINS` env var.

### 10. OCR worker race creates duplicate Tesseract workers

`getWorker()` cached the worker *instance*, not the promise:

```js
let workerInstance = null
export const getWorker = async () => {
  if (!workerInstance) {                    // two concurrent callers both see null
    const worker = await createWorker(...)  // ...so both build a worker
```

Two logins arriving together each built a Tesseract worker, each loading its own language model, and the loser of the assignment race was never terminated — leaked for the process lifetime. On a 768 MB heap that is a real ceiling, and your `--max-old-space-size=768` flag suggests you have already felt it. Also worth noting: `/api/session` calls `getWorker()` on *every* session creation, so the race was easy to hit.

Now caches the promise, so concurrent callers await one construction. A rejected promise is explicitly un-cached, so one cold-start failure doesn't permanently disable captcha solving. Added `terminateWorker()` and wired it into shutdown.

### 11. Session store unbounded — memory-exhaustion DoS

`sessions` was a plain `Map` with no cap. Each entry holds an axios client and a cookie jar, and `GET /api/session` creates one with no authentication required. A trivial loop exhausts the heap; the 30-minute sweep runs only every 5 minutes, far too slow to matter. Added a 500-session cap with oldest-by-`lastUsed` eviction, on top of the rate limit from finding 8.

### 12. nginx will not start — `log_format main` is undefined

`access_log /var/log/nginx/access.log main buffer=16k flush=2m` references a format named `main`, but this file defines `user`/`worker_processes` and its own `http` block, so it *replaces* the top-level config rather than being included by it. There is no inherited `main`. nginx exits with:

```
[emerg] unknown log format "main"
```

I have added the `log_format main` definition. Worth knowing what this implies: if the app is currently running, it is not running through this config file.

### 13. No compression — the 150 KB shell sent uncompressed

`frontend/login.html` is 150,223 bytes: roughly 50 KB of inline CSS, 84 KB of inline JS, 15 KB of markup. Express had no `compression` middleware, so all 150 KB went over the wire verbatim on every cold load. This is the single biggest performance item in the project — and combined with finding 12, the nginx `gzip on` you wrote was probably never active either.

Measured against the running server, not estimated: the same request returns **156,372 B with no `Accept-Encoding` and 30,887 B with gzip**. Against your original uncompressed 150,223 B shell that is a **79.4% reduction, about 117 KB saved per cold load.**

What that is worth depends entirely on the link, and it is worth being precise rather than quoting one flattering number: roughly 2.4 s on slow 3G, 0.64 s on congested campus wifi at ~1.5 Mbps, 0.19 s on a decent 5 Mbps connection, and 0.10 s on 4G. On localhost it is actually marginally *slower* — 23 ms TTFB compressed versus 15 ms uncompressed, because you pay CPU to compress and save no transfer time. Don't be alarmed if local development feels a touch heavier; the win is real over any actual network.

Repeat visits are better than I first described. The shell is served `no-cache`, which sounds expensive but only means "revalidate", and revalidation works: a conditional request returns **HTTP 304 with a 0-byte body**. So a returning student pays one round trip and downloads nothing, rather than re-fetching 150 KB.

`compression` is optional-imported so the server still boots without it; `npm install compression` activates it.

### 14. Internal error text returned to the browser

`auth.js:115` returned `error.message` to the client, handing out axios internals, DNS failures and upstream detail — useful reconnaissance. Now logged server-side, generic message returned. `portal.js` already did this correctly via `handleRouteError`.

---

## Medium

**15. `/courses` null dereference.** `portal.js:170` returned `timetableData.subjects || []`. `parseTimetableData` can return null on a parse failure, so `.subjects` threw a `TypeError` and the route 500'd. `/bootstrap` guarded this correctly with a ternary; `/courses` did not. Both now go through one shared helper with `?? []`.

**16. Captcha failure falls back to `'SRM'`.** On an OCR error, `auth.js:84` set `captchaCode = 'SRM'` and submitted anyway. That can never be the right answer, so the student saw "invalid credentials" for what was actually a server-side OCR outage — and a guaranteed-failed request went to SRM regardless. Now returns `503` with an honest "try again in a moment".

**17. No request timeouts.** The axios client set none. Because every request on a session is deliberately serialized to avoid SRM's JSP session collisions, *one* hung request blocks that student's entire queue indefinitely. Added a 15 s default timeout plus response size caps.

**18. Missing OCR model crashes the whole server.** *(Upgraded from Medium to High after this was reproduced in practice — my first pass under-diagnosed it as a caught error. It is a hard process crash.)*

Three separate defects stack here.

First, `langPath: process.cwd()` resolved differently depending on whether you ran `npm start` from the repo root or from `backend/` — and the two `package.json` scripts did exactly that. Pinned to the repo root, overridable via `TESSDATA_PATH`.

Second, `eng.traineddata` is not in the repo and `gzip: false` says a local uncompressed file is expected, so the load always failed.

Third — and this is the part I initially missed — tesseract.js v7 does `throw Error(data)` from inside a `MessagePort` event handler when a worker job rejects and no `errorHandler` was supplied (`node_modules/tesseract.js/src/createWorker.js:217`). That throw escapes every `try`/`catch` in this codebase, so a missing model was never a recoverable 503; it killed the process with `ENOENT` and left nodemon waiting for a file change. The original code had no `errorHandler` either, so this crash pre-existed my changes — pinning `langPath` only made it fire at a consistent path instead of a cwd-dependent one.

Fixed by supplying `errorHandler`, so a load failure rejects the promise and `/api/login` returns 503 while the server keeps serving. Verified: with the CDN unreachable, `/api/session` still returned 200 and the process stayed up, logging `[ocr] tesseract worker error: TypeError: fetch failed` instead of dying.

Two more things surfaced while testing that fix. `langPath` is now only set when a local model actually exists, because tesseract.js falls back to its jsdelivr CDN **only when `langPath` is unset** — so the model self-downloads on first use, and `cachePath` persists it so no later run touches the network. And with no model *and* no route to the CDN, `createWorker()` never settles at all: it sat past 120 s with no error, which would hang the login request behind it. There is now a 60 s cap (`OCR_INIT_TIMEOUT_MS`) that surfaces a 503, plus a 60 s failure cooldown (`OCR_FAIL_COOLDOWN_MS`) — because when `createWorker` fails, tesseract.js hands back no worker handle, so the thread it already spawned cannot be terminated and retrying on every login would accumulate dead threads.

**You still need the model, one of two ways.** Either let it self-download on first login (needs outbound access to `cdn.jsdelivr.net`), or drop `eng.traineddata` in the repo root yourself for an offline, faster cold start — `https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata` is the right file, since the code requests OEM 1 (LSTM only) and the `_fast` variant is the smallest that satisfies it. I could not download it for you: this sandbox only permits egress to one host.

**19. Dead duplicate `/api/session`.** `server.js:32-44` defined a second copy of the endpoint, but `app.use('/api', authRoutes)` on line 28 registered first, so Express always matched the router. The dead copy lacked the OCR warm-up and the timeout — two subtly different versions of one endpoint, and the wrong one is the one you'd read. Removed, with a comment recording why.

**20. `cors: ^2.8.6` probably does not exist.** `cors` has published `2.8.5` since 2018 and I am not aware of a `2.8.6`, which would make `npm install` fail outright. I could not confirm this — the registry is blocked here. Set to `^2.8.5`; please run `npm view cors versions` and `npm outdated` to check this and the other pinned versions, several of which are also ahead of what I know.

**21. Two dependency lists, no lockfile.** Root and `backend/package.json` each declared the same nine dependencies independently, with no `package-lock.json` committed anywhere. The lists can drift silently, and "works on my machine" becomes a function of which directory you installed from. I emptied the backend copy (file deletion is blocked in this sandbox — delete it outright, it is safe to remove) and pointed it at the root. **Commit your lockfile.**

**22. Unbounded caches.** `photoCache` held image buffers keyed by username with a 12-hour TTL and no size limit; `reportCache` held whole scraped HTML reports. Both now capped (200 photos / 300 reports) with LRU-ish eviction. Separately, `photoCache`'s key fell back to the literal `'default'` when `session.username` was null, so two different sessions requesting the same URL could share an entry — the new ticket flow keys by session id instead.

**23. Only one redirect hop.** `submitLogin` handled exactly one `Location` header. If SRM ever chains redirects, the result is a spurious "invalid credentials". Now follows up to five hops.

**24. nginx proxy inefficiencies.** `Connection: upgrade` was hardcoded on every request, which defeats upstream keep-alive — and this app has no WebSocket endpoints at all. There was also no `upstream` block, so every proxied request opened a fresh TCP connection to Node. Added an upstream with `keepalive 32`, a `map` so the upgrade header is only sent when a client asks for it, and explicit proxy timeouts. `proxy_cache_bypass $http_upgrade` was a no-op with no cache defined.

**25. No security headers.** Nothing set `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` or a CSP. All added in `server.js` without a new dependency, and repeated at the nginx edge. The CSP needs `'unsafe-inline'` because the app is a single file with inline `<style>` and `<script>` — but it still blocks external script origins, which is what stops an injected payload from calling home. Extracting the CSS and JS into separate files would let you drop `'unsafe-inline'` and would also make them independently cacheable.

**26. Render-blocking font CSS.** The Google Fonts stylesheet blocked first paint on a round trip to `fonts.googleapis.com`. Now loaded with `media="print"` flipped to `all` on load, so it is non-blocking; `display=swap` was already set, so text shows in a fallback face meanwhile. **Render-blocking external requests before first paint: 1 → 0.**

I did *not* trim the font weights. You request 10 (four each for Plus Jakarta Sans and IBM Plex Mono, two for Zilla Slab) and all four weight values do appear in the CSS, so trimming needs a per-family check I could not make safely without changing your design. I also could not measure the payoff — no route to `fonts.gstatic.com` from here — and browsers only fetch the weights actually applied to rendered text, so the saving is smaller than "10 weights" suggests. Worth auditing, but I am not going to put a number on it.

**27. `user-scalable=no` blocks pinch-zoom.** The viewport meta had `maximum-scale=1, minimum-scale=1, user-scalable=no`, which prevents zooming — a WCAG 1.4.4 failure and a real problem for anyone who needs to enlarge a timetable cell. Removed; `width=device-width, initial-scale=1, viewport-fit=cover` retains the layout behaviour you wanted.

---

## Low

**28.** Theme was read from `localStorage` by the script at the *bottom* of `<body>`, while `<html>` hardcoded `data-theme="dark"` — so light-mode users saw a dark flash on every load. Moved to a tiny blocking script in `<head>`, which also now honours `prefers-color-scheme` on first visit.

**29.** `lower.includes('incorrect')` matched the bare word anywhere on the page, risking false login failures. Narrowed to `'incorrect username'` / `'incorrect password'`. The `'freshers'` and `'senior students'` markers are similarly broad; I kept them since I cannot see SRM's real HTML, but they are worth revisiting.

**30.** The seven-condition landing-page marker list appeared verbatim in both `checkSessionExpiry` and `isLoginSuccessful` — two copies that will drift. Now one shared constant.

**31.** `/att` called `fetchId` (a full dashboard page scrape) then `fetchAtt` on every single poll, two round-trips to read one hidden input. `fetchId` now memoizes `studentId` on the session: **2 SRM round-trips per poll → 1 after the first call.**

**32.** The static-asset block set `immutable` with a 30-day max-age on plain filenames like `app.js`. `immutable` tells the browser never to revalidate, so a returning visitor can be pinned to a stale file for a month. Only safe with content-hashed filenames — removed, with a comment explaining when to put it back.

**33.** `metadata.json` described "Student Register — Roll Call & Attendance Portal" and declared `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API` — leftover scaffolding from a different project, and a misleading capability claim. Rewritten to describe this app.

**34.** No favicon meant an automatic `/favicon.ico` request 404ing on every load. Added an inline SVG data-URI — zero extra requests.

**35.** No `SIGTERM`/`SIGINT` handling, and the Tesseract worker holds a native handle, so the process needed a `SIGKILL` to exit. Added graceful shutdown that closes the server and terminates the worker; all `setInterval` timers are now `unref()`'d so they cannot hold the process open.

**36.** `dotenv` was a declared dependency that nothing ever imported, so `.env` was silently ignored and every `process.env` lookup fell through to its default — while `.gitignore` carefully excluded `.env`, implying it was expected to work. Now loaded, with a `.env.example` documenting every variable.

**37.** The student photo was served `Cache-Control: public`, which permits shared-proxy caching of one student's face. Changed to `private`. API responses now send `no-store, private`.

---

## Performance summary

| Metric | Before | After |
|---|---|---|
| App shell transferred (cold load) | 150,223 B | 30,887 B (**−79.4%**) |
| Repeat visit (conditional request) | 150,223 B | 304, **0 B** |
| Render-blocking external requests | 1 (+ favicon 404) | 0 |
| TCP connections to Node per request | new each time | pooled (`keepalive 32`) |
| SRM round-trips per `/att` poll | 2 | 1 (after first) |
| Static asset cache headers | none | 30 days, shell `no-cache` + ETag |
| Tesseract workers under concurrent login | 1 per race loser, leaked | exactly 1 |
| OCR model load paid per login | up to ~1.9 s when the race hit | once per process |
| Session store bound | unbounded | 500, LRU eviction |

The ordering matters: compression is worth more than everything else combined, and it needs finding 12 fixed for the nginx half to work at all. Do those two first.

### Where the remaining time actually goes

Worth saying plainly, because it redirects effort: after these fixes the frontend is no longer the bottleneck, and OCR never was. Measured with the real worker and the real parameters this code sets, captcha recognition takes **11–40 ms** per image (three synthetic 6-character captchas, all read correctly). Model load is **~1.9 s**, but that is once per process and your `/api/session` warm-up already backgrounds it while the student is still typing.

That warm-up was previously being wasted, which is the hidden performance half of finding 10. Because `getWorker()` cached the worker instance rather than the promise, a login arriving inside the ~1.9 s warm-up window saw `null` and built a second worker from scratch — paying the full model load again, on the request the student is actually waiting on, and leaking the loser. Caching the promise means the warm-up is now genuinely reused.

So what is left is the SRM round-trips themselves: every endpoint scrapes a JSP page, and requests on one session are deliberately serialized. That is where the perceptible latency lives now, and the levers on it are the ones already in the code — the `Promise.all` in `/profile`, the memoized `studentId`, the `reportCache`, and the frontend's stale-while-revalidate localStorage layer. Further gains mean caching more aggressively or scraping less, not shaving bytes.

One caveat on the font suggestion in finding 26: I could not measure it, since this sandbox has no route to `fonts.gstatic.com`. Treat that item as worth auditing, not as a quantified win.

The structural change I would still make is splitting the inline CSS and JS out of `login.html` — but for correctness and cacheability, not for bytes. It buys a CSP without `'unsafe-inline'`, lets those files be hashed and cached `immutable` so repeat visits skip even the revalidation round trip, and turns a 4,528-line file into something reviewable. The byte saving on repeat visits is already near zero thanks to the 304, so don't do it expecting a speed jump.

Your SWR caching on the frontend — `localStorage` with a 30-minute TTL, cache rendered first and network refreshed behind it — is genuinely good and I left it alone. The `/profile` route's `Promise.all` for the two independent SRM pages is the right call too. The per-session request serialization looks like a bottleneck but is load-bearing given SRM's JSP session behaviour, so I kept it and documented why.

---

## One thing that is not a bug

`markAttendance` sends fixed campus coordinates — `16.464478869582308, 80.50074625327288` — regardless of where the student actually is, and a comment in `portal.js` records that the geolocation requirement was removed on purpose.

That is not a defect, so I have not "fixed" it: the code works as intended. But it defeats a geofence the university put on that endpoint deliberately, and the intent of the check is to confirm physical presence. Marking attendance for a class you are not at is likely an academic-integrity violation at most institutions, and the liability sits with the account owner — your account, on your server, with your IP in the logs.

I have moved the coordinates out of the route into `ATTENDANCE_LATITUDE` / `ATTENDANCE_LONGITUDE` env vars, defaulting to the existing values so nothing changes unless you decide it should. The behaviour is now a deployment choice you make explicitly rather than a constant buried in a handler. What you do with it is your call — I just don't want it to be an accident.

---

## Suggested order of work

Before anyone real uses this: terminate TLS (4), and rotate any logs that captured passwords (1). Both are about credentials already at risk rather than code quality.

Then the correctness blockers: the nginx `log_format` (12), the fail-open login check (5), and the OCR model (18) — that last one was crashing the server outright, not merely failing captcha solving.

Then performance: `npm install compression` (13), and consider auditing the font weights (26).

Then, when you have time: extract the inline CSS and JS from `login.html` into separate files. It buys you a stricter CSP without `'unsafe-inline'`, independent caching, and a 4,528-line file that stops being 4,528 lines. Move the SRM session server-side behind an `httpOnly` cookie (2) and the client never holds a password again. Add a lockfile (21) and a smoke test that exercises login against a stub.

---

*All fixed files are in `srm-portal-fixed/`, mirroring your repo layout. `FIX:` comments mark each change in place. Nothing here has been run against a live SRM portal — please test the login and attendance flows before deploying.*

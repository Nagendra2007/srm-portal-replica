# srm-portal-replica — audited & fixed build

This is your repo with 37 security and performance findings addressed. Every
change is marked with a `FIX:` comment at the point of the edit, so the
reasoning lives in the code. `AUDIT-REPORT.md` has the full findings list with
severity, `file:line`, and what was done about each one.

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

Node 20 or newer. `npm start` must be run from the repo root, not from
`backend/` — `backend/package.json` is a neutered duplicate and is safe to
delete (see finding 21).

Optional configuration lives in `.env.example`; copy it to `.env` and edit.
Nothing in it is required to boot.

## What is in this bundle

`eng.traineddata` (5 MB) is the OCR model. It is **not** part of your source —
it is gitignored, and it is included here only so captcha solving works
immediately without a first-run download. Delete it if you prefer; the code
will fetch and cache it from the tesseract.js CDN on first use.

`package-lock.json` is included deliberately. Committing it was finding 21 —
without one, "works on my machine" depends on when you last installed.

`node_modules` is excluded. Run `npm install`.

## Before you deploy this anywhere real

Three things, in order:

1. **Terminate TLS.** `nginx.conf` has a commented TLS block; `certbot --nginx`
   fills it in. This app collects real SRM passwords, and on plain HTTP they are
   readable by anyone on the network path. Nothing else in this report matters
   as much.

2. **Rotate any logs from the old build.** The previous `backend/routes/auth.js`
   printed every password to stdout in cleartext (finding 1). If it ever ran
   anywhere real, treat those logs as compromised.

3. **Check `nginx.conf` actually loads.** The original referenced an undefined
   `log_format main`, which prevents nginx from starting at all (finding 12).
   That is fixed here, but it means if your app is currently running, it is not
   running through this config. Verify with `nginx -t` — I could not, as nginx
   was not available in the environment I audited from.

## What was verified, and what was not

Verified: the server boots and answers `/healthz`; security headers and CSP are
present; `x-powered-by` is gone; gzip is active (150,223 B → 30,887 B, −79.4%);
repeat visits return `304` with an empty body; `SIGTERM` exits cleanly; OCR
reads captchas in 11–40 ms; all backend modules parse; every import resolves;
the XSS escaping helper is inert against eight payloads.

Not verified: anything that requires the live SRM portal — login, scraping,
attendance marking. Test those yourself. `nginx -t` was also never run.

## One deliberate behaviour change

Passwords are no longer written to `localStorage` in cleartext. They live in
`sessionStorage` instead, so **the password no longer prefills after you close
the browser** — the username still does, and `autocomplete="current-password"`
lets the browser's own encrypted password manager handle the rest. There is a
one-time purge that clears cleartext passwords the previous build already wrote
to users' disks.

If you disagree, `PERSIST_PASSWORD_ON_DISK` near the top of the script in
`frontend/login.html` restores the old behaviour.

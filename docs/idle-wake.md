# Idle stop and wake on request (T1.4)

Apps that nobody uses stop, and the next request starts them again.

## Idle stop

- The control plane runs `MachineController.stopIdle()` every minute
  (`startIdleStopper` in `apps/control-plane/src/server.ts`).
- An app is stopped when its machine is `running`, the app is `running`,
  `pinned = false`, and the later of `machines.last_request_at` and
  `machines.last_started_at` is more than **10 minutes** ago (AGENTS §14).
- Stopping sets `machines.state = 'stopped'` and `apps.status = 'stopped'`.
  `/data` is kept (see `docs/data-volume.md`).
- `pinned` apps are never idle-stopped.

## Traffic (touch)

- The gateway calls `POST /internal/touch {appId, userId}` at most once per app
  every 30 s while it proxies traffic (HTTP and WebSocket).
- Touch sets `machines.last_request_at` and `apps.last_viewed_at`. Expiry
  renewal and usage counters arrive with lifecycle jobs (T2.5).

## Wake

`POST /internal/wake {appId}` (internal secret) starts a stopped machine and
returns `{state: "running"}` once the runtime reports it started.

- **Single-flight.** Concurrent wakes for one app share one `RuntimeProvider.start`
  call, in the control plane (for any number of gateways) and in the gateway (so
  a storm of requests sends one wake). Tested: 50 concurrent requests → 1 start.
- A wake waits for an in-flight idle stop of the same app, then starts it.
- Errors use the §8 envelope: `APP_SUSPENDED` (403), `APP_EXPIRED` (410),
  `NOT_FOUND` (no deployed release, or container missing: republish),
  `LIMIT_EXCEEDED` (`/data` over its size limit).

## Gateway behaviour (§9 step 6)

After sign-in and the ACL check, if the resolved app is `stopped`:

1. The gateway calls wake, then waits until the app's port accepts TCP
   connections (it is the only thing that can reach the app network).
2. **Non-HTML requests** are held up to **15 s** (AGENTS §14). If the app is not
   up by then: `503` with `Retry-After: 2` and a §8 envelope.
3. **HTML navigations** (`GET`/`HEAD` with `Accept: text/html` or
   `Sec-Fetch-Mode: navigate`) are held up to 3 s, then get a `503` "Starting…"
   page with `<meta http-equiv="refresh" content="2">` that reloads the same URL.
   The wake keeps going in the background.
4. WebSocket upgrades are held up to 15 s, then dropped if the app is not up.

The resolve cache (30 s) can still say `running` just after the idle stopper
stopped an app. Then the proxy's connection fails (`ENOTFOUND`/`ECONNREFUSED`),
and the gateway starts a wake and answers with the wait page / `503`. The
request body is not replayed; the client retries.

## Latency

Measured on Docker Desktop 29.9 (macOS): a stopped `http-echo` container answers
HTTP from inside its app network about 2.7 s after `start`
(`packages/runtime-docker/src/wake-latency.test.ts`, limit 10 s).

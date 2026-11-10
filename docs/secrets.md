# Env vars and secrets (T1.6, INV7, INV12)

```bash
scad env set my-app DB_URL=postgres://db/app LOG_LEVEL=info
scad env set my-app API_TOKEN=sk-... --secret
scad env ls my-app          # API_TOKEN=<secret>
scad env unset my-app LOG_LEVEL
```

- Only the app's owner can read or change its env (`404` for everyone else,
  including people the app is shared with; INV10).
- `--secret` values are **write-only**: no API returns them, `scad env ls`
  shows `<secret>`. A key that is secret stays secret; to make it plain again,
  unset it and set it again.
- Changing env **restarts the app** with the new values (the control plane
  redeploys the current release). The response says `applied: "redeployed"`, or
  `"next_publish"` if the app has no running release yet.
- Stored env vars override `env` in `scad.json` key by key. Put secrets here,
  never in `scad.json`: `scad.json` travels in the tarball and is stored on the
  release.

API (§8): `PUT /v1/apps/:id/env` with `{"KEY": "value", "OLD": null, "secret": ["KEY"]}`
(`null` deletes; `secret` is a reserved field), and `GET /v1/apps/:id/env`
(an addition to the §8 list, like T1.2's share listing).

## How values are stored

Every value, secret or not, is envelope-encrypted
(`apps/control-plane/src/secrets/crypto.ts`):

- Each record gets a fresh random 256-bit data key and 96-bit nonce; the value
  is encrypted with AES-256-GCM.
- The data key is encrypted ("wrapped") with `MASTER_KEY`, AES-256-GCM with its
  own nonce.
- Both bind `scad-env:v1:{appId}:{key}` as additional data, so a ciphertext
  copied to another app or key fails to decrypt.
- The record stores an 8-byte fingerprint of the master key that wrapped it.

`env_vars.value_ciphertext` never contains plaintext. Audit rows
(`app.env.set`) list key names only.

## When values are decrypted

Only at container start:

- **Publish:** after `docker build` and before the smoke check, the builder
  fetches `POST /internal/builds/:id/runtime-env` (internal token; only while
  that release is `building`). Values never reach `docker build`, build args,
  or the build log (INV8).
- **Env change:** the control plane decrypts and redeploys.

The builder still holds no `MASTER_KEY` (it scrubs platform secrets at startup).
Nothing logs env values; `env.integration.test.ts` captures all process output
and checks that it contains no secret.

## `MASTER_KEY`

32 random bytes, base64: `openssl rand -base64 32`. If it is unset, the control
plane starts but `scad env` returns `503` with a hint. A malformed key stops
startup. **Back it up**: without it, stored env vars cannot be recovered.

## Rotating `MASTER_KEY`

Rotation rewraps each record's data key. Values are not re-encrypted, and apps
keep running.

1. Generate a new key: `openssl rand -base64 32`.
2. Restart the control plane with `MASTER_KEY=<new>` and
   `MASTER_KEY_PREVIOUS=<old>`. New writes use the new key, and old records
   still decrypt.
3. Rewrap every record under the new key:

   ```bash
   MASTER_KEY=<new> MASTER_KEY_PREVIOUS=<old> DATABASE_URL=... \
     pnpm --filter @scad/control-plane rotate-master-key
   ```

   It runs in one transaction and prints how many records it rewrapped.
4. Remove `MASTER_KEY_PREVIOUS` and restart. Destroy the old key once backups
   that need it have expired.

`MASTER_KEY_PREVIOUS` accepts a comma-separated list if a rotation was
interrupted. Tested in `env.integration.test.ts` ("MASTER_KEY rotation rewraps
every record").

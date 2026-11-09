# Publishing without a Dockerfile (T2.4)

If the upload has no `Dockerfile`, the builder writes one from a built-in
template (`apps/builder/src/autodetect.ts`). Railpack, Nixpacks, and
Buildpacks are not used. Like every SCAD build, template builds run with
`--network=none` (see [`build-isolation.md`](build-isolation.md)), so nothing
is downloaded during the build. Base images are still pulled by the Docker
daemon.

The first match wins:

| Layout | Template | Runs as | Start command |
|---|---|---|---|
| `Dockerfile` | yours, unchanged | your `USER` (must be non-root) | yours |
| `package.json` | `node:22-alpine` | `node` | `npm start` if `scripts.start`, else `node <main>`, else `node server.js` / `node index.js` |
| `requirements.txt` | `python:3.12-alpine` | `65534` (nobody) | `python app.py` (or `main.py`, `server.py`) |
| `index.html` | `busybox:1.36` `httpd` | `65534` (nobody) | serves the folder (minus `scad.json`) |

Every template sets `PORT` to the manifest port (default 8080), so the app
should listen on `process.env.PORT` / `os.environ["PORT"]`. `scad.json` `start`
still overrides the start command.

## Dependencies (builds are offline)

- **Node.** A `package.json` with an empty or missing `dependencies` works
  directly. With dependencies, the build is refused with `BUILD_FAILED` and a
  hint. `scad publish` never uploads `node_modules/`, and `npm install` cannot
  reach the registry. Bundle the app into one file instead (for example
  `esbuild server.js --bundle --platform=node --outfile=dist/server.js`, then
  point `main` or `scripts.start` at it and drop `dependencies`), or write a
  Dockerfile that copies vendored packages.
- **Python.** A `requirements.txt` with no packages (comments only) works
  directly. With packages, vendor them as wheels in `wheels/`:

  ```bash
  pip download -r requirements.txt -d wheels --only-binary=:all: --platform musllinux_1_2_aarch64 --python-version 3.12
  ```

  (use `x86_64` on Intel). The template then runs
  `pip install --no-index --find-links /app/wheels` offline. Without
  `wheels/`, the build is refused with a hint.
- **Static.** No dependencies.

Installing straight from npm or PyPI during the build would need network
access for builds. That widens what a build may reach, which is a human
decision (AGENTS §15); see "Blocked: needs human" in `build-schedule.md`.

## Errors

Every refusal is `BUILD_FAILED` with a hint: no recognised layout (the hint
lists them), invalid `package.json`, `main` outside the app, a missing entry
file, or undeclared dependencies. Symlinked `Dockerfile` / `package.json` /
`requirements.txt` are never followed.

## Tests

- `apps/builder/src/autodetect.test.ts`: detection and generated Dockerfiles.
- `apps/builder/src/autodetect.docker.test.ts`: a vendored wheel installs and
  imports with `--network=none` (skipped offline).
- `apps/control-plane/src/publish.integration.test.ts`: a directory with only
  `package.json`, `examples/hello-python`, and `examples/hello-static` each
  publish without a Dockerfile and run.

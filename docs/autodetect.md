# Publishing without a Dockerfile (T2.4, T3.2)

If the upload has no `Dockerfile`, the builder writes one from a built-in
template (`apps/builder/src/autodetect.ts`). Railpack, Nixpacks, and
Buildpacks are not used. Like every SCAD build, template builds run with
`--network=none` (see [`build-isolation.md`](build-isolation.md)), so nothing
is downloaded during the build. Base images are still pulled by the Docker
daemon. Website projects get their packages from a separate **trusted fetch
step** that runs before the build (below).

The first match wins:

| Layout | Template | Runs as | Start command |
|---|---|---|---|
| `Dockerfile` | yours, unchanged | your `USER` (must be non-root) | yours |
| `hugo.toml` / `hugo.yaml` / `hugo.json` (or `config.toml` + `content/`, no package.json) | Hugo site (T3.2) | `node` | SCAD's static server |
| `Gemfile` + `_config.yml` | Jekyll site (T3.2) | `node` | SCAD's static server |
| `package.json` naming a site framework, or with a `build` script and no `start` | site build (T3.2, table below) | `node` | SCAD's static server |
| `package.json` (anything else) | `node:22-alpine` | `node` | `npm start` if `scripts.start`, else `node <main>`, else `node server.js` / `node index.js` |
| `requirements.txt` | `python:3.12-alpine` | `65534` (nobody) | `python app.py` (or `main.py`, `server.py`) |
| `index.html` | `busybox:1.36` `httpd` | `65534` (nobody) | serves the folder (minus `scad.json`) |

Every template sets `PORT` to the manifest port (default 8080), so the app
should listen on `process.env.PORT` / `os.environ["PORT"]`. `scad.json` `start`
still overrides the start command.

## Website projects (T3.2)

Site builds are two stages: `node:22-alpine` runs the site's build offline,
then the image keeps only the output folder, served by SCAD's static server
(`apps/builder/assets/static-server.mjs`, no dependencies) as `node`.

| Framework (detected from package.json, config read as text) | Build | Output folder tried |
|---|---|---|
| Vite (React, Vue, Svelte, Solid, Preact, Lit) | `npm run build` | `dist` |
| Create React App (`react-scripts`) | `npm run build` | `build` |
| Angular | `npm run build` | `dist/*/browser`, `dist/*`, `dist` |
| Astro (static: no server adapter, no `output: "server"`) | `npm run build` | `dist` |
| Gatsby | `npm run build` | `public` |
| Docusaurus | `npm run build` | `build` |
| VitePress | `npm run build` | `docs/.vitepress/dist`, `.vitepress/dist`, ... |
| Eleventy | `npm run build` | `_site` |
| Next.js with `output: "export"` | `npm run build` | `out` |
| Nuxt with `nuxt generate` (or `ssr: false`) | `npm run build` | `.output/public`, `dist` |
| SvelteKit with `@sveltejs/adapter-static` | `npm run build` | `build` |
| React Router with `ssr: false` | `npm run build` | `build/client` |
| Hugo | pinned Hugo `0.169.0` (`--minify --baseURL /`) | `public` equivalent |
| Jekyll | `bundle install --local`, `jekyll build` | `_site` equivalent |
| Anything else with a `build` script | `npm run build` | first of `dist`, `build`, `out`, `public`, `_site` |

Without a `build` script, the framework's own command runs
(`node_modules/.bin/vite build`, ...). The first listed folder with an
`index.html` wins (else the first that exists). None found is `BUILD_FAILED`
with a hint naming the folders.

**Routing.** `/a` serves `a`, `a.html`, or `a/index.html` (a folder redirects
to `/a/`). A miss serves the site's own `404.html` with 404 when it has one
(multi-page sites like Docusaurus, Hugo, Astro); otherwise a page navigation
gets `index.html` with 200, so client-side routes of single-page apps reload
without a 404. Missing assets (`/x.js`) stay 404.

Server-rendered sites (Next.js without `output: "export"`, Nuxt, SvelteKit
with a node adapter, Remix / React Router, Astro with a server adapter) are
T3.3; until then they get a hint naming the static option.

### The trusted fetch step

`apps/builder/src/fetch-deps.ts`, Blocked option (c) in
`build-schedule.md`. Before the offline build, the builder:

1. copies **only** `package.json` and `package-lock.json` (or
   `npm-shrinkwrap.json`) into an empty directory. The app's source, its
   `.npmrc` (except `legacy-peer-deps`, `strict-peer-deps`, `engine-strict`),
   and every platform secret stay out;
2. refuses, with a hint, dependencies that are not registry versions (git,
   URLs, `file:`) and lockfile entries `resolved` anywhere but
   `https://registry.npmjs.org/`; workspaces (monorepos) are refused too;
3. creates a private `internal` Docker network, attaches the egress proxy, and
   writes a proxy policy that allows `registry.npmjs.org` and nothing else.
   The proxy resolves DNS itself and refuses private and metadata addresses
   (INV2). The fetch container has no other route and no DNS;
4. runs `node:22-alpine` there, non-root, read-only root, all capabilities
   dropped, `no-new-privileges`, 2 GB memory, 512 pids, killed after
   `SCAD_FETCH_TIMEOUT_MS` (5 min):
   `npm install --package-lock-only --ignore-scripts` when there is no npm
   lockfile, then `npm ci --include=dev --ignore-scripts`. **No package code
   runs** while the network is reachable;
5. caps the result at `SCAD_FETCH_MAX_MB` (1.5 GB), moves `node_modules/` into
   the build context, and removes the network and policy.

`pnpm-lock.yaml`, `yarn.lock`, and `bun.lock(b)` are not read yet: npm
resolves versions from package.json ranges (the log says so). Commit a
`package-lock.json` to pin exact versions.

Packages that need their install scripts (native addons built with
`node-gyp`, downloaded binaries) are not built. The fetch log lists every
installed package that has an install script; if the build then fails, the
`BUILD_FAILED` hint names them and suggests a version with prebuilt binaries
or a pure-JavaScript alternative. Most common packages ship prebuilt Linux
binaries as optional dependencies (esbuild, Rollup, Rolldown, SWC, Lightning
CSS, sharp, lmdb) and work, on arm64 and amd64.

Jekyll: the fetch container is `ruby:3.3`, allowed only `rubygems.org` and
`index.rubygems.org`, sees only `Gemfile` and `Gemfile.lock`, and runs
`bundle lock --add-platform <linux platform>` then
`bundle cache --no-install` (downloads `.gem` files into `vendor/cache`,
builds nothing). Git and path gems are refused. The offline build then runs
`bundle install --local`, which compiles native extensions with no network.
Note: bundler evaluates the `Gemfile` (Ruby) during the fetch, so the
founder's Gemfile code runs with registry-only egress and no secrets.

Hugo: no fetch. The builder downloads the pinned Hugo release once from
GitHub, checks its SHA-256 (`apps/builder/src/hugo.ts`), caches it under
`$SCAD_DATA_DIR/cache`, and copies it into the build context. Hugo Modules
(themes fetched with Go) cannot download; keep themes in `themes/`.

Next.js `next/font/google` downloads fonts during `next build`, which has no
network: the build fails with a hint to use `next/font/local` (or the `geist`
package).

## Dependencies for Node and Python apps (builds are offline)

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

Node *server* apps with dependencies and Python packages from PyPI are
backend apps (M4); website projects use the fetch step above.

## Errors

Every refusal is `BUILD_FAILED` with a hint: no recognised layout (the hint
lists them), invalid `package.json`, `main` outside the app, a missing entry
file, or undeclared dependencies. Symlinked `Dockerfile` / `package.json` /
`requirements.txt` are never followed.

## Tests

- `apps/builder/src/autodetect.test.ts`, `frameworks.test.ts`: detection and generated Dockerfiles.
- `apps/builder/src/fetch-deps.test.ts`: fetch argv/env (no secrets, hardened, registry only, cleanup), refusal of non-registry sources.
- `apps/builder/src/fetch-deps.docker.test.ts` (real Docker + egress proxy + registry): `postinstall`/`install`/`preinstall`/`prepare` never run (with a scripts-on positive control); the fetch container reaches `registry.npmjs.org` through the proxy and nothing else (other hosts and metadata get 403, no direct route, no DNS).
- `apps/builder/src/static-server.test.ts`: SPA fallback, `404.html`, traversal.
- `apps/control-plane/src/publish.integration.test.ts`: every T3.2 example publishes with no Dockerfile or scad.json, and a client-side or nested route loads from inside the app network.
- `apps/builder/src/autodetect.docker.test.ts`: a vendored wheel installs and
  imports with `--network=none` (skipped offline).
- `apps/control-plane/src/publish.integration.test.ts`: a directory with only
  `package.json`, `examples/hello-python`, and `examples/hello-static` each
  publish without a Dockerfile and run.

import { readFile } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../errors.js";

export type InstallRoutesOpts = {
  /** This instance's public API URL; baked into the script. */
  publicBaseUrl: string;
  /** The one-file client built by `pnpm build:install`. */
  bundlePath: string;
};

/** Only plain http(s) origins go into the shell script (no quotes, spaces, or `$`). */
const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * The script behind the one pasted command (T3.4):
 *   curl -fsSL https://api.<instance>/install.sh | sh
 * Installs the SCAD client to ~/.scad/bin, then runs `scad setup`, which logs
 * in (approval by email) and adds SCAD to Claude Code and Cursor.
 */
export function installScript(apiUrl: string): string {
  return `#!/bin/sh
# SCAD installer for ${apiUrl}
# Installs the SCAD client to ~/.scad/bin and connects it to Claude Code and Cursor.
set -eu
API='${apiUrl}'

if ! command -v node >/dev/null 2>&1; then
  echo "SCAD needs Node.js 22 or newer, and it isn't installed."
  echo "Install it from https://nodejs.org (the big LTS button), then paste the same command again."
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "SCAD needs Node.js 22 or newer; this computer has Node.js $major."
  echo "Install the current LTS from https://nodejs.org, then paste the same command again."
  exit 1
fi

dir="$HOME/.scad/bin"
mkdir -p "$dir"
echo "Downloading SCAD from $API ..."
curl -fsSL "$API/install/scad.mjs" -o "$dir/scad.mjs.download"
mv "$dir/scad.mjs.download" "$dir/scad.mjs"
cat > "$dir/scad" <<EOS
#!/bin/sh
exec node "$dir/scad.mjs" "\\$@"
EOS
chmod +x "$dir/scad"

node "$dir/scad.mjs" setup --api-url "$API" "$@"
echo ""
echo "(Optional) To type scad commands yourself, add this line to your shell profile:"
echo "  export PATH=\\"$dir:\\$PATH\\""
`;
}

export const installRoutes: FastifyPluginAsync<InstallRoutesOpts> = async (app, opts) => {
  const apiUrl = opts.publicBaseUrl.replace(/\/$/, "");

  app.get("/install.sh", { config: { public: true } }, async (_request, reply) => {
    if (!SAFE_ORIGIN.test(apiUrl)) {
      throw new ApiError(
        500,
        "INTERNAL",
        "This instance's PUBLIC_BASE_URL is not a plain https origin",
        "Operator: set PUBLIC_BASE_URL to e.g. https://api.myscad.duckdns.org and restart the control plane.",
      );
    }
    return reply.header("cache-control", "no-store").type("text/x-shellscript; charset=utf-8").send(installScript(apiUrl));
  });

  app.get("/install/scad.mjs", { config: { public: true } }, async (_request, reply) => {
    const bundle = await readFile(opts.bundlePath).catch(() => null);
    if (!bundle) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        "The SCAD client has not been built on this instance yet",
        "Operator: run `pnpm build:install` in the SCAD folder on the server (docs/deploy.md), then try again.",
      );
    }
    return reply.header("cache-control", "no-cache").type("text/javascript; charset=utf-8").send(bundle);
  });
};

/**
 * Signs that a RUN step tried to reach the network. Builds run with
 * `docker build --network=none` (T0.9, INV8), so any download fails.
 */
const NETWORK_FAILURE = [
  /bad address/i,
  /EAI_AGAIN/,
  /ENOTFOUND/,
  /ENETUNREACH/,
  /ECONNREFUSED/,
  /getaddrinfo/i,
  /could not resolve/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /network (is )?unreachable/i,
  /from versions: none/i, // pip: index unreachable
  /failed to fetch/i,
  /unable to (connect|resolve)/i,
];

/** The `hint` for a failed `docker build`, chosen from what the log shows. */
export function buildFailedHint(logLines: string[]): string {
  const noOutput = logLines.find((line) => line.includes("scad: the build finished but no output folder was found"));
  if (noOutput) {
    const looked = /looked for: ([^)]*)\)/.exec(noOutput)?.[1] ?? "dist, build, out, public, _site";
    return (
      `The site built, but SCAD could not find its output folder (it looked for: ${looked}). ` +
      "Make the build write the finished site (with an index.html) to dist/, then republish."
    );
  }
  if (logLines.some((line) => /Failed to fetch( font)? [`'"]?[\w ]+[`'"]? from Google Fonts|fonts\.googleapis\.com/i.test(line))) {
    return (
      "The build tried to download Google Fonts, but builds run with no network. Use self-hosted fonts instead " +
      '(for Next.js: `next/font/local`, or the `geist` npm package for Geist), then republish.'
    );
  }
  if (logLines.some((line) => NETWORK_FAILURE.some((re) => re.test(line)))) {
    return (
      "Builds run with no network access (docker build --network=none), and a RUN step tried to download " +
      "something (see the failing RUN step in details.log_tail). Remove that download: vendor dependencies " +
      "into the upload (e.g. include node_modules, or a pip wheelhouse installed with --no-index), or use a " +
      "base image that already has them, then republish. See docs/build-isolation.md."
    );
  }
  return "The Docker build failed. Read details.log_tail for the failing step, fix the Dockerfile or build context, and republish.";
}

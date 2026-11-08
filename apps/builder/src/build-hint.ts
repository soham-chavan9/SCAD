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

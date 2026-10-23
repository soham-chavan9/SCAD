/**
 * Convert scad.json `start` (a shell-like string) into a Docker Cmd argv array.
 * The array is passed to the Docker API as `Cmd` — never interpolated into a host shell.
 */
export function manifestStartToArgv(start: string): string[] {
  const trimmed = start.trim();
  if (!trimmed) {
    throw new Error("manifest.start must be non-empty");
  }
  // Run via container /bin/sh -c so spaces/quotes match Dockerfile shell form,
  // but the host never sees a shell string — only this argv array.
  return ["/bin/sh", "-c", trimmed];
}

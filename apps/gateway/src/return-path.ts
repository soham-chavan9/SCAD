/**
 * Same-origin path for post-login redirects.
 * Rejects protocol-relative URLs (`//host`), backslashes, and `%2f%2f` tricks.
 */
export function safeLocalReturnPath(value: string | undefined): string | null {
  if (value === undefined || value === "") return "/";
  const hash = value.indexOf("#");
  const withoutHash = hash === -1 ? value : value.slice(0, hash);
  const queryAt = withoutHash.indexOf("?");
  const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const search = queryAt === -1 ? "" : withoutHash.slice(queryAt);
  if (!isSafeAbsolutePath(path)) return null;
  if (!isSafeSearch(search)) return null;
  return path + search;
}

function isSafeAbsolutePath(path: string): boolean {
  if (path.includes("\\") || path.includes("\0") || path.includes("//")) return false;
  if (!path.startsWith("/")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.includes("//")) return false;
  return decoded.startsWith("/") && !decoded.startsWith("//");
}

function isSafeSearch(search: string): boolean {
  if (search.includes("\\") || search.includes("\0") || search.includes("//")) return false;
  try {
    const decoded = decodeURIComponent(search);
    return !decoded.includes("\\") && !decoded.includes("//");
  } catch {
    return false;
  }
}

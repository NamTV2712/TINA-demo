/** Optional URL for a separately deployed TINA account portal. */
export function getWebappUrl(): string {
  return process.env.NEXT_PUBLIC_WEBAPP_URL || "";
}

/** TINA docs use same-origin paths until a public docs host is configured. */
export function getDocsUrl(path: string): string {
  const docsUrl = process.env.NEXT_PUBLIC_DOCS_URL || "";
  // Remove leading slash if present to avoid double slashes
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${docsUrl}${cleanPath}`;
}

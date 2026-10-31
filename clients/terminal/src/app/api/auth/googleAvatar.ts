/** Accept only HTTPS profile images served from Google's user-content domain. */
export function googleAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;

  try {
    const url = new URL(value);
    const isGoogleUserContent = url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com");
    return url.protocol === "https:" && isGoogleUserContent ? url.toString() : null;
  } catch {
    return null;
  }
}

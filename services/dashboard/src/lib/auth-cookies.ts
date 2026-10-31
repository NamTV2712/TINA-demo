export function getAuthCookieName(): string {
  return process.env.TINA_AUTH_COOKIE_NAME || "tina-token";
}

export function getUserInfoCookieName(): string {
  return process.env.TINA_USER_INFO_COOKIE_NAME || "tina-user-info";
}

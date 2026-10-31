# ChatGPT connection status

GET reports whether the current TINA subject has a usable ChatGPT connection. It is `connected` only
when a stored profile carries both tokens and the expected scopes; email and expiry are returned for
display, never the tokens themselves.

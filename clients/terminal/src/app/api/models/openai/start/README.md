# Start ChatGPT sign-in

POST begins the ChatGPT plan OAuth flow. It is accepted only from the loopback Terminal origin
(`127.0.0.1:${TINA_TERMINAL_PUBLIC_PORT}`) so the TINA cookie rides the redirect, binds the attempt to
the current TINA subject, and returns the authorize URL the browser should open.

# Disconnect ChatGPT

Same-origin authenticated POST removes only the signed-in TINA user's ChatGPT
connection through the internal Agent API broker. Pending OAuth states are cancelled.
No TINA session, ASR setting, workspace or other user's credential is removed.
The broker shares its file lock with refresh and rotates a connection generation,
so callbacks begun before logout cannot save a profile afterward. Already running
workers may retain short-lived tokens; disconnect is local unlink, not provider
revocation or a global ChatGPT browser logout.

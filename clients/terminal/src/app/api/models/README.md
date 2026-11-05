# /api/models

Next.js route group serving the model picker: the ChatGPT (OpenAI) connect flow and its catalogue,
plus `catalog/` (the live list for an API-key provider, including a draft key the user is still typing).
Routes proxy the gateway with the caller's own credential; none of them return a provider token to the
browser, and none store the draft key.

# Provider model catalogue

POST proxies `/agent/models/catalog` on the gateway with the caller's API key, so Settings → Models
can list the models the entered credential really has. The request body is `{mode, api_key?}`: the
optional key is a draft the user is still typing (shown before Save) and is used once, never stored
or echoed. Omitting it makes agent-api resolve the saved effective key for that provider.

Upstream errors pass through with their status so the picker can say WHY it fell back to the built-in
suggestions; **Custom model…** remains available for any ID the provider does not list.

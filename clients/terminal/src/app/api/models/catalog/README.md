# Provider model catalogue

POST proxies `/agent/models/catalog` on the gateway with the caller's API key, so Settings → Models
can list the models the entered credential really has. The request body is `{mode, api_key?}`: the
optional key is a draft the user is still typing (shown before Save) and is used once, never stored
or echoed. Omitting it makes agent-api resolve the saved effective key for that provider.
Bedrock also accepts `region` for regional discovery. The response is
`{mode, models: [{id, name, supports_tools?}]}`. Optional `supports_tools: false` marks a known
text-only model: Chat model disables it with an explanation, while Meeting model allows it.
An omitted capability is unknown; the credential test verifies the real chat tool round trip.

Upstream errors pass through with their status so the picker can say WHY it fell back to the built-in
suggestions; **Custom model…** remains available for any ID the provider does not list.

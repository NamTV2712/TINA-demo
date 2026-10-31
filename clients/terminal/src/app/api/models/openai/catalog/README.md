# ChatGPT model catalogue

GET proxies `GET /agent/models/openai/catalog` on the gateway with the caller's API key, so Settings
can offer real model ids without exposing the gateway. Upstream errors pass through with their status;
the client can still type a model id by hand.

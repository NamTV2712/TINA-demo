# ChatGPT OAuth callback

GET target of the ChatGPT sign-in redirect. It verifies the OIDC response and the pending state for
the TINA subject, stores the profile, and renders a self-contained success page (no script, no
credential in the URL). When the state does not belong to this browser — the cross-browser case — it
renders the callback URL for the user to paste back into the original Settings tab instead of failing.

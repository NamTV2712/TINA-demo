# Speakly postprocess evidence

`evidence-summary.json` preserves the installed ASAR identity, selected source hashes, REA Evidence
IDs, bounded coverage and successful probe output. It is an analyst summary of the canonical REA
bundle whose path/digest it records, not a replacement Evidence record.

`probe.cjs` is the exact analyst harness used for the successful controlled replay. It loads the
hash-verified extracted `first-party/dist/src` tree beside the script and stubs native/network/storage
dependencies. The captured run used `/tmp/tina-speakly-postprocess-20261028/probe.cjs`; to rerun this
copy, provide the same extracted tree beside it. Source code from the app is not vendored here.
The run is not evidence of full-application or cloud behavior, audio quality or latency.

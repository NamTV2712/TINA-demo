# GitHub Actions workflows

`gates.yml` runs static, Node and Python checks in parallel, followed by the
aggregate `gates` check. Pushes to `main`, `Feat/LivetranslationVi2En` and
`feat/asr-quality-refinement`, release tags, pull requests and merge groups
trigger the workflow. Other feature branches run when a pull request is opened.

The ASR-quality branch is based on the latest main and keeps push validation
enabled while the recording-refinement work moves off the live-translation branch.

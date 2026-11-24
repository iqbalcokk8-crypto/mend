# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/iqbalcokk8-crypto/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/iqbalcokk8-crypto/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text files, all or nothing. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — `--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `PATCH` is the patch file, or `-` / absent for standard input. `--check` reports what would change without writing anything; `--strict` matches lines exactly. Node 22 and its standard library only; no install step.

The full contract is SPEC.md in the kit's starter: exit codes, output lines, three-tier line matching, and the all-or-nothing write. Practice score: 1000/1000 on the kit's 100 public practice checks.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mbc233fv&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

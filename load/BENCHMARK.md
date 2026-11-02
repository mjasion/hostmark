# The benchmark in GitHub Actions

`.github/workflows/benchmark.yml` runs the load scenarios against the deployed platforms from one runner per region,
merges the results, and publishes a report. Decisions: D170 to D179 in `docs/decisions.md`.

**It does nothing until you enable a platform.** The first job reads `platforms.json` and lets a platform through only
when `enabled` is `true` and `status` is `deployed`. While none qualifies, the workflow ends green after the first job
and no later job runs: no secret, no environment, no target. The scheduled run (the 1st of every month) behaves the
same way.

## What you supply

1. **Runners, one per region** (for `runner_mode: regional`). Three machines with Docker and Node 22, registered to
   this repository as self-hosted runners with these labels (`load/regions.json`):

   | Region         | Labels                                                   | Where               |
   | -------------- | -------------------------------------------------------- | ------------------- |
   | `eu`           | `self-hosted`, `hostmark-bench`, `hostmark-eu`           | Frankfurt or Warsaw |
   | `us-east`      | `self-hosted`, `hostmark-bench`, `hostmark-us-east`      | Virginia            |
   | `ap-southeast` | `self-hosted`, `hostmark-bench`, `hostmark-ap-southeast` | Singapore           |

   `eu` is the primary region and runs S1 to S9. The runners need outbound HTTPS, Docker and Node 22. The workflow installs the repository dependencies with pnpm and
   generates the fixtures itself, in steps that have no platform credential; browser scenarios S10 and S13 need those
   installed packages.
   Use machines that do not sleep (a result recorded during a host pause is `invalid`, D98). GitHub-hosted runners
   cannot be placed in a region, so without these, use `runner_mode: github-hosted`: everything runs once from one
   place GitHub chooses, and the report says there is no regional comparison.
   A self-hosted runner on a public repository is a risk: it runs whatever a workflow run contains, and the runner keeps
   its workspace and any credential between runs. This workflow does not run on pull requests, but another workflow in
   the repository could. Under Settings, Actions, General, require approval for all outside contributors, or use
   ephemeral runners (one job, then a fresh machine). Keep the runners to this repository and put nothing else on them.
2. **An Environment per platform**, named `bench-<platform>` (for example `bench-fly`), under Settings, Environments:
   - variable `HOSTMARK_BASE_URL`: the deployed app, `https://...`, no path secrets, not a loopback name
   - secret `HOSTMARK_API_KEY`: a user API key (seed or created in the app)
   - secret `HOSTMARK_ADMIN_API_KEY`: for S8 only
   - optional `HOSTMARK_VARIANT` (`portable` or `idiomatic`, default `portable`), and for S12 and S15 the variables
     `HOSTMARK_PURGE_URL`, `HOSTMARK_PURGE_METHOD` and the secret `HOSTMARK_PURGE_TOKEN`. Without a purge URL S15 is
     recorded as skipped.
     Restrict each environment to the `main` branch (deployment branches), so no other branch can read its secrets; the
     workflow also does nothing outside `main`. Add **required reviewers** if you want to approve each platform's first
     load by hand.
3. **Budgets and billing alerts** at each platform, set by you. Then list the platform in `confirm_budgets` when you
   dispatch the workflow, or in the repository variable `BENCH_BUDGETS_CONFIRMED` for the schedule. A platform that is
   not listed gets no S5 and S6. Nothing checks that the budget exists.
4. **Repository variables** for scheduled runs only (a dispatch uses its inputs alone: an empty input means nothing,
   never the variable): `BENCH_RUNNER_MODE` (`regional` or `github-hosted`, no default; a scheduled run with something to run and no
   value fails in the first job), `BENCH_BUDGETS_CONFIRMED`, and optionally `BENCH_SCENARIOS`.
5. **Enable the platform** in `platforms.json` (`enabled: true`, `status: "deployed"` once it really is). That commit is
   what turns the benchmark on for it.
6. Allow the workflow to push `benchmark-results`: the branch must not be protected against `github-actions[bot]`.

## Running it

Actions, benchmark, Run workflow. Inputs:

| Input             | Meaning                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platforms`       | `all` (every enabled and deployed platform) or names such as `fly,cloudflare`. A named platform that may not receive load is an error.                                                  |
| `scenarios`       | Empty for the standard set (S1 to S6, S8 to S13, S15), or a list such as `S1,S2`. S7 (13 hours) and S14 (needs a deploy during the run) run only when named; S7 needs regional runners. |
| `confirm_budgets` | Platforms whose budgets you set. Empty means nobody.                                                                                                                                    |
| `runner_mode`     | `regional` or `github-hosted`. Required.                                                                                                                                                |

For a first check, dispatch `github-hosted` with `scenarios: S1` against one deployed platform.

S1 to S9 run from `eu`, one platform at a time. S10 to S15 run from all three regions, after that. The last job merges
every result with the plan, writes `report.md`, and pushes `runs/<id>/` and a `README.md` of all runs to the branch
`benchmark-results`. The report is also in the job summary.

## Reading the report

PASSED, FAILED, SKIPPED, INVALID and NOT RUN are different things; skipped and invalid results are never counted as
passed. Results are combined (median and range) only when platform, scenario, region, variant, tree and load mode are equal.
A different tree is its own row and the report starts with a warning. `load/tools/report.mjs <files or dirs>` makes the
same report from result files on a disk.

## Checking the workflow offline

```
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12 .github/workflows/benchmark.yml
node --test load/test/*.test.mjs   # a glob: Node 22 reads a directory argument as a module path
node load/tools/bench-plan.mjs --out "$TMPDIR/plan.json"   # with nothing enabled: count=0, exit 0
```

## Not proven

Nothing here has run on GitHub. In particular unproven: the self-hosted labels and matrix on real runners, the layout
of downloaded artifacts, the push to `benchmark-results` under your repository settings, and the browser scenarios
(S10, S13) on a runner.

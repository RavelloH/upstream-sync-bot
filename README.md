# upstream-sync-bot

Template GitHub repository for running a **"sync from upstream → fan out to every downstream fork"** bot driven by a GitHub App.

Downstream users install the App once. After that they receive automated pull requests with upstream changes — no PAT, no `.github/workflows/`, no settings toggles, no scripts to run.

---

## How it works

```
┌────────────────────────────────────────────────────┐
│  Your bot instance repo (cloned from the template) │
│                                                    │
│  .github/workflows/sync-fanout.yml                 │
│  ┌──────────────────────────────────────────────┐  │
│  │ enumerate job                                │  │
│  │   App JWT → GET /app/installations           │  │
│  │   → GET /installation/repositories           │  │
│  │   → JSON matrix of targets                   │  │
│  └────────────────┬─────────────────────────────┘  │
│                   │ fan out                        │
│  ┌────────────────▼─────────────────────────────┐  │
│  │ sync matrix job (parallel, fail-fast: false) │  │
│  │   create-github-app-token@v1                 │  │
│  │     scoped to ONE target repo                │  │
│  │   uses: ./.github/actions/sync-one           │  │
│  │     - git clone target                       │  │
│  │     - detect mode (merge / squash)           │  │
│  │     - apply changes                          │  │
│  │     - open or update PR                      │  │
│  │     - move `upstream-sync-base` tag          │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
                  │ App installation token (1h, scoped)
                  ▼
        ┌─────────────────────┐
        │ downstream fork #1  │
        │ downstream fork #2  │
        │ downstream fork #N  │
        └─────────────────────┘
```

The bot stores **no state**. Every run re-queries GitHub for the live installation list, and each target repo carries its own `upstream-sync-base` tag and `chore/sync-upstream` branch as the cursor.

---

## Setup (for upstream maintainers)

You only do this once for your project.

### 1. Create the GitHub App

Go to <https://github.com/settings/apps/new> (or your org's `/organizations/<org>/settings/apps/new`).

| Field | Value |
| --- | --- |
| GitHub App name | `<YourProject> Sync` (e.g., `InsightFlare Sync`) |
| Homepage URL | Your project's homepage / repo |
| Webhook → Active | **Unchecked** (we don't need webhooks; cron + dispatch is enough) |
| Repository permissions → Contents | **Read and write** |
| Repository permissions → Pull requests | **Read and write** |
| Repository permissions → Metadata | **Read-only** (auto-included) |
| Where can this app be installed | **Any account** (so downstream users can install it) |

Click **Create GitHub App**. On the resulting page:

1. Note the **App ID** (numeric, near the top).
2. Scroll down to **Private keys** → **Generate a private key**. A `.pem` file downloads — keep it safe, you'll paste it as a secret in a moment.

### 2. Create your bot repo from this template

Click **Use this template** → **Create a new repository** at the top of this repo's GitHub page. Name it something like `<YourProject>-Bot` (e.g., `InsightFlare-Bot`).

### 3. Set the App credentials as repo secrets

In your new bot repo, go to **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
| --- | --- |
| `SYNC_APP_ID` | The numeric App ID from step 1. |
| `SYNC_APP_PRIVATE_KEY` | The entire contents of the `.pem` file from step 1 (including the `-----BEGIN…` / `-----END…` lines). |

### 4. Point `sync-bot.config.json` at your upstream

Edit [`sync-bot.config.json`](./sync-bot.config.json):

```json
{
  "upstream": {
    "owner": "YourOrg",
    "repo": "YourProject",
    "branch": "main"
  },
  "downstream": {
    "syncBranch": "chore/sync-upstream",
    "baseTag": "upstream-sync-base",
    "prTitle": "chore: sync upstream YourOrg/YourProject",
    "treeScanExclude": ["wrangler.toml"]
  }
}
```

`treeScanExclude` lists files to ignore when matching a snapshot-clone's tree against upstream history (typically per-deployment config that diverges immediately — e.g., `wrangler.toml`, `.env.example`).

### 5. Adjust the cron schedule (optional)

The fan-out runs every 6 hours by default. Edit [`.github/workflows/sync-fanout.yml`](./.github/workflows/sync-fanout.yml) and change the `cron:` line if you want it more or less often.

### 6. Wire up instant-trigger from your upstream repo (optional, recommended)

Without this, downstream users wait up to 6 hours after you push for the bot to notice. To trigger immediately on every upstream push, drop this workflow into your **upstream** repo at `.github/workflows/notify-sync-bot.yml`:

```yaml
name: Notify sync bot
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ secrets.SYNC_BOT_DISPATCH_TOKEN }}
        run: |
          gh api \
            -X POST \
            /repos/<your-bot-owner>/<your-bot-repo>/dispatches \
            -f event_type=upstream-pushed
```

`SYNC_BOT_DISPATCH_TOKEN` is a fine-grained PAT with `Contents: Read` on your bot repo. (We can't use `GITHUB_TOKEN` here because it's scoped to the upstream repo, not the bot repo.)

### 7. Publish the install link to downstream users

In your upstream project's README, add a section pointing at the App install URL:

```markdown
## Keep your fork in sync

[**Install <YourProject> Sync**](https://github.com/apps/<your-app-slug>/installations/new)

After installing, you'll automatically receive pull requests with upstream
changes — no further setup required.
```

The slug is whatever you typed as "GitHub App name" in step 1, lowercased with spaces replaced by `-`. You can confirm it at <https://github.com/settings/apps>.

### 8. Test it

In your bot repo, go to **Actions → Sync upstream fanout → Run workflow**. Watch the run:

- The **enumerate** job should print every installation it found
- The **sync** matrix should fan out one job per target repo
- Each matrix job should either open a PR, update an existing PR, or report "nothing to do"

If `enumerate` fails with `Bad credentials`, double-check `SYNC_APP_PRIVATE_KEY` — GitHub UI sometimes mangles newlines on paste. Re-paste from the original `.pem` if needed.

---

## For downstream users

If you forked or cloned a project that ships with this bot, all you do is click the install link in that project's README, choose your fork, and click **Install**.

You can review what the App can do, restrict it to specific repos, or uninstall at any time under your account's **Settings → Integrations → Applications**.

The bot does **not** push directly to your default branch — every change comes through a pull request you review and merge.

---

## How `chore/sync-upstream` PRs work

When the bot runs against your repo, it:

1. Decides on a **sync mode** based on whether your repo shares git history with upstream:
   - **`merge` mode** — fork or clean clone. The bot opens a PR with a real merge commit, preserving upstream commit history.
   - **`squash` mode** — snapshot clone (no shared history, e.g., Cloudflare "Deploy to" button output). The bot squashes the upstream diff into one commit applied via `git apply --3way`.
2. Force-pushes the result to `chore/sync-upstream`.
3. Creates the PR or, if `chore/sync-upstream` already has a PR (open or closed), updates that PR's title and body in place.
4. Tags the upstream commit it synced against as `upstream-sync-base` in your repo, so the next run knows where to pick up.

Conflicts: if `git apply --3way` or `git merge` produce conflict markers, the bot still pushes the branch and opens the PR, but the body lists which files need manual resolution. Resolve them on `chore/sync-upstream` and the workflow will pick up the resolved tree on the next run.

---

## Files in this template

| Path | Purpose |
| --- | --- |
| `sync-bot.config.json` | Per-instance config: upstream coordinates + downstream branch / tag names. **Edit this.** |
| `.github/workflows/sync-fanout.yml` | The schedule + dispatch trigger, enumerate job, and matrix fan-out. |
| `.github/actions/sync-one/action.yml` | Composite action with all per-target sync logic (mode detection, patch application, PR body). |
| `scripts/enumerate-installations.mjs` | Lists installations + repos via `@octokit/auth-app`, filters self/upstream, emits matrix JSON. |
| `package.json` | Just two deps: `@octokit/auth-app`, `@octokit/request`. |

---

## Security model

- **Per-target token scoping**: each matrix job mints an installation token via `actions/create-github-app-token@v1` with `repositories:` set to one repo. A leaked token compromises at most one user's repo, not the fleet.
- **No webhooks**: the App has webhook disabled. We pull from GitHub on a schedule; we never accept inbound events to a maintained server.
- **No stored state**: there's no database of "who installed". GitHub is the source of truth; we re-read it every run. Users uninstalling are picked up automatically.
- **The `SYNC_APP_PRIVATE_KEY` secret** is the entire trust anchor. Treat it like a root credential — anyone with the private key can act as the App against every installation. Use repo secrets, not organization-wide, unless you have a reason to broaden.

---

## License

This template ships without a license. Decide one for your bot instance based on your project's needs (most users will want MIT or Apache-2.0).

#!/usr/bin/env node
// Enumerates every repository this GitHub App is currently installed on,
// emits a JSON matrix list, and writes it to $GITHUB_OUTPUT.
//
// Input env:
//   SYNC_APP_ID            — numeric App ID
//   SYNC_APP_PRIVATE_KEY   — PEM private key (newlines preserved)
//   UPSTREAM_OWNER         — upstream repo owner (used to skip self-sync)
//   UPSTREAM_REPO          — upstream repo name  (used to skip self-sync)
//   GITHUB_REPOSITORY      — auto, set by Actions ("<owner>/<bot-repo>")
//   GITHUB_OUTPUT          — auto, set by Actions
//
// Output (to $GITHUB_OUTPUT):
//   targets=<single-line JSON array>
//   count=<integer>
//
// Each target object:
//   { installation_id, owner, repo, full_name, default_branch }
//
// Filtering:
//   - Skips the upstream repo itself (would be a no-op self-sync)
//   - Skips the bot repo itself (the App should not be installed there,
//     but defend against it just in case)
//   - Skips archived repos
//   - Skips repos the installation does not actually grant access to
//     (selected_repositories mode with empty list)

import { appendFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { request as octokitRequest } from "@octokit/request";

const APP_ID = process.env.SYNC_APP_ID;
const PRIVATE_KEY_RAW = process.env.SYNC_APP_PRIVATE_KEY;
const UPSTREAM_OWNER = (process.env.UPSTREAM_OWNER || "").toLowerCase();
const UPSTREAM_REPO = (process.env.UPSTREAM_REPO || "").toLowerCase();
const SELF_FULL_NAME = (process.env.GITHUB_REPOSITORY || "").toLowerCase();
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

function die(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

if (!APP_ID) die("SYNC_APP_ID is not set.");
if (!PRIVATE_KEY_RAW) die("SYNC_APP_PRIVATE_KEY is not set.");
if (!UPSTREAM_OWNER || !UPSTREAM_REPO) {
  die("UPSTREAM_OWNER and UPSTREAM_REPO must be set (from sync-bot.config.json).");
}
if (!GITHUB_OUTPUT) die("GITHUB_OUTPUT is not set. This script must run inside GitHub Actions.");

// Some secret stores escape newlines as literal \n. Accept either form.
const privateKey = PRIVATE_KEY_RAW.includes("\\n")
  ? PRIVATE_KEY_RAW.replace(/\\n/g, "\n")
  : PRIVATE_KEY_RAW;

const auth = createAppAuth({ appId: APP_ID, privateKey });

async function appRequest(route, params = {}) {
  const { token } = await auth({ type: "app" });
  return octokitRequest(route, {
    ...params,
    headers: { authorization: `Bearer ${token}`, ...(params.headers || {}) },
  });
}

async function installationRequest(installationId, route, params = {}) {
  const { token } = await auth({ type: "installation", installationId });
  return octokitRequest(route, {
    ...params,
    headers: { authorization: `token ${token}`, ...(params.headers || {}) },
  });
}

async function paginate(fetchPage) {
  const all = [];
  let page = 1;
  while (true) {
    const res = await fetchPage(page);
    const items = Array.isArray(res.data) ? res.data : res.data.repositories;
    all.push(...items);
    if (items.length < 100) break;
    page += 1;
  }
  return all;
}

async function listInstallations() {
  return paginate((page) => appRequest("GET /app/installations", { per_page: 100, page }));
}

async function listRepositoriesForInstallation(installationId) {
  return paginate((page) =>
    installationRequest(installationId, "GET /installation/repositories", {
      per_page: 100,
      page,
    }),
  );
}

function shouldSkip(repo) {
  const fullLower = repo.full_name.toLowerCase();
  if (fullLower === `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`) {
    return "is the upstream repo itself";
  }
  if (fullLower === SELF_FULL_NAME) {
    return "is the bot repo itself";
  }
  if (repo.archived) {
    return "is archived";
  }
  return null;
}

async function main() {
  console.log(`App ID: ${APP_ID}`);
  console.log(`Upstream: ${UPSTREAM_OWNER}/${UPSTREAM_REPO}`);
  console.log(`Self: ${SELF_FULL_NAME || "(unknown)"}`);
  console.log("");

  const installations = await listInstallations();
  console.log(`Found ${installations.length} installation(s).`);

  const targets = [];
  for (const inst of installations) {
    const account = inst.account?.login || `(installation #${inst.id})`;
    let repos;
    try {
      repos = await listRepositoriesForInstallation(inst.id);
    } catch (err) {
      console.warn(
        `::warning::Could not list repos for installation #${inst.id} (@${account}): ${err.message}`,
      );
      continue;
    }
    if (repos.length === 0) {
      console.log(`  @${account}: installation has zero accessible repos. Skipping.`);
      continue;
    }
    for (const repo of repos) {
      const reason = shouldSkip(repo);
      if (reason) {
        console.log(`  @${account}: skip ${repo.full_name} (${reason})`);
        continue;
      }
      targets.push({
        installation_id: inst.id,
        owner: repo.owner.login,
        repo: repo.name,
        full_name: repo.full_name,
        default_branch: repo.default_branch,
      });
      console.log(`  @${account}: include ${repo.full_name} (default branch: ${repo.default_branch})`);
    }
  }

  console.log("");
  console.log(`Total targets: ${targets.length}`);

  const json = JSON.stringify(targets);
  appendFileSync(GITHUB_OUTPUT, `targets=${json}\n`);
  appendFileSync(GITHUB_OUTPUT, `count=${targets.length}\n`);

  // Also emit a step summary so a human poking at the workflow run sees it.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const lines = [
      `### Fan-out enumeration`,
      ``,
      `Found **${targets.length}** target repo(s) across **${installations.length}** installation(s).`,
      ``,
    ];
    if (targets.length > 0) {
      lines.push(`| Repo | Default branch | Installation ID |`);
      lines.push(`| --- | --- | --- |`);
      for (const t of targets) {
        lines.push(`| \`${t.full_name}\` | \`${t.default_branch}\` | \`${t.installation_id}\` |`);
      }
    }
    appendFileSync(summaryPath, lines.join("\n") + "\n");
  }
}

main().catch((err) => {
  console.error(`::error::Enumeration failed: ${err.message}`);
  if (err.response?.data) {
    console.error(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});

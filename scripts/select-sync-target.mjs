#!/usr/bin/env node
// Selects the upstream commit to sync to.
//
// Inputs:
//   argv[2] TARGET_TYPE: branch | latestTag | latestMajorTag
//   argv[3] MAJOR: required for latestMajorTag
//   argv[4] BRANCH_REF: local git ref used for branch mode
//
// Outputs shell assignments to stdout:
//   TARGET_SHA
//   TARGET_REF
//   TARGET_KIND
//   TARGET_TAG

import { execFileSync } from "node:child_process";

const targetType = process.argv[2] || "branch";
const majorRaw = process.argv[3] || "";
const branchRef = process.argv[4] || "";

function die(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function emit(fields) {
  for (const [key, value] of Object.entries(fields)) {
    console.log(`${key}=${shellQuote(value)}`);
  }
}

function parseSemverTag(tag) {
  const match = tag.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;

  const prereleaseIndex = tag.indexOf("-");
  const buildIndex = tag.indexOf("+");
  const suffixIndex =
    prereleaseIndex === -1
      ? buildIndex
      : buildIndex === -1
        ? prereleaseIndex
        : Math.min(prereleaseIndex, buildIndex);

  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: suffixIndex !== -1 && tag[suffixIndex] === "-",
  };
}

function compareSemver(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  return a.tag.localeCompare(b.tag);
}

function resolveCommit(ref) {
  return git(["rev-parse", `${ref}^{commit}`]);
}

if (targetType === "branch") {
  if (!branchRef) die("branch sync target requires a branch ref.");
  emit({
    TARGET_SHA: resolveCommit(branchRef),
    TARGET_REF: branchRef,
    TARGET_KIND: "branch",
    TARGET_TAG: "",
  });
  process.exit(0);
}

if (targetType !== "latestTag" && targetType !== "latestMajorTag") {
  die(`Unsupported upstream.syncTarget.type: ${targetType}`);
}

const tags = git(["tag", "--list"])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map(parseSemverTag)
  .filter(Boolean)
  .filter((tag) => !tag.prerelease);

let candidates = tags;
if (targetType === "latestMajorTag") {
  if (!/^\d+$/.test(majorRaw)) {
    die("upstream.syncTarget.major must be a non-negative integer for latestMajorTag.");
  }
  const major = Number(majorRaw);
  candidates = candidates.filter((tag) => tag.major === major);
}

if (candidates.length === 0) {
  const detail =
    targetType === "latestMajorTag"
      ? ` for major ${majorRaw}`
      : "";
  die(`No stable SemVer tags found${detail}. Expected tags like v1.2.3 or 1.2.3.`);
}

candidates.sort(compareSemver);
const selected = candidates[candidates.length - 1];
const targetRef = `refs/tags/${selected.tag}`;

emit({
  TARGET_SHA: resolveCommit(targetRef),
  TARGET_REF: targetRef,
  TARGET_KIND: targetType,
  TARGET_TAG: selected.tag,
});

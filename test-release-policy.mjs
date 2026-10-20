#!/usr/bin/env node

import { readFileSync } from "node:fs";

const releaseWorkflow = readFileSync(new URL("./.github/workflows/release.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("./.github/workflows/ci.yml", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url), "utf8"));
const publishJobStart = releaseWorkflow.indexOf("\n  publish-npm:");
const verifyPublicStart = releaseWorkflow.indexOf("\n  verify-public:");
const createReleaseStart = releaseWorkflow.indexOf("\n  create-github-release:");
const publishJob = releaseWorkflow.slice(publishJobStart, verifyPublicStart);
const createReleaseJob = releaseWorkflow.slice(createReleaseStart);

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`✓ ${message}`);
}

assert(pkg.version === pkg.dependencies?.["@smartergpt/lex"], "wrapper and Lex dependency versions match");
assert(lock.packages?.["node_modules/@smartergpt/lex"]?.version === pkg.version, "lockfile resolves matching Lex");
assert(releaseWorkflow.includes("workflow_dispatch:"), "release supports reviewed build-only dispatches");
assert(releaseWorkflow.includes("publish:"), "publication requires an explicit boolean input");
assert(!releaseWorkflow.includes("git fetch --no-tags origin main"), "private-repository identity does not depend on an unauthenticated fetch");
assert(releaseWorkflow.includes('Authorization: Bearer $GH_TOKEN'), "private-repository identity uses authenticated read-only API authority");
assert(releaseWorkflow.includes("environment: npm-release"), "npm publication uses the main-restricted environment");
assert(releaseWorkflow.includes("id-token: write"), "npm publication receives OIDC authority");
assert(releaseWorkflow.includes('npm publish "$TARBALL" --access public --provenance'), "workflow publishes the retained tarball with provenance");
assert(publishJobStart > 0 && verifyPublicStart > publishJobStart, "release policy locates the npm publication job");
assert(publishJob.includes('TARBALL=$(realpath "$(find candidate'), "npm publication canonicalizes the retained tarball path");
assert(publishJob.includes('RECEIPT=$(realpath "$(find candidate'), "npm publication canonicalizes the retained receipt path");
assert(releaseWorkflow.includes('MAIN_NOW=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main"'), "publication rechecks the live main tip");
assert(releaseWorkflow.includes('if [ -z "$OBSERVED" ]'), "publication is recovery-safe when the version is initially absent");
assert(releaseWorkflow.includes('elif [ "$OBSERVED" = "$EXPECTED" ]'), "publication accepts only an already-published exact candidate");
assert(releaseWorkflow.includes("git verify-tag"), "tag releases verify the annotated tag signature");
assert(releaseWorkflow.includes("TRUSTED_RELEASE_FINGERPRINTS"), "tag authority is constrained to trusted fingerprints");
assert(releaseWorkflow.includes("artifact_digest:"), "private-repository evidence exposes the immutable artifact digest");
assert(releaseWorkflow.includes('actions/artifacts/$ARTIFACT_ID'), "release consumers bind the candidate to its artifact service record");
assert(!releaseWorkflow.includes("actions/attest@"), "private-repository lane does not call unavailable GitHub artifact attestations");
assert(releaseWorkflow.includes("verify-npm-provenance.mjs"), "public verification checks the complete npm provenance statement");
assert(releaseWorkflow.includes("gh attestation verify"), "public verification checks the provenance certificate identity");
assert(releaseWorkflow.includes("Re-verify immutable remote release identity"), "GitHub release creation rechecks remote tag and main identity");
assert(createReleaseStart > verifyPublicStart, "release policy locates the GitHub release job");
assert(createReleaseJob.includes("always() &&"), "tag release overrides skipped transitive publication state");
for (const prerequisite of ["validate-identity", "build-candidate", "verify-public"]) {
  assert(createReleaseJob.includes(`needs.${prerequisite}.result == 'success'`), `tag release requires successful ${prerequisite}`);
}
assert(!/^\s*NODE_AUTH_TOKEN:/m.test(releaseWorkflow), "workflow does not inject a long-lived npm token");

// Native publication must work from packaged prebuilds in both installation modes.
assert(pkg.scripts?.["test:native"] === "node scripts/check-bundled-sqlite.mjs", "native gate uses the packaged SQLite probe");
for (const [name, workflow] of [["CI", ciWorkflow], ["release", releaseWorkflow]]) {
  assert(!workflow.includes("npm rebuild"), `${name} does not repair missing packaged native binaries`);
  assert(workflow.includes("npm ci --ignore-scripts"), `${name} starts from a disabled-lifecycle dependency install`);
  assert(workflow.includes("npm run test:pack -- --ignore-scripts"), `${name} tests a packed disabled-lifecycle consumer`);
}
const windowsJobStart = releaseWorkflow.indexOf("\n  smoke-windows:");
assert(windowsJobStart > 0 && windowsJobStart < publishJobStart, "release policy locates the Windows candidate smoke job");
const windowsJob = releaseWorkflow.slice(windowsJobStart, publishJobStart);
const windowsLines = windowsJob.split(/\r?\n/);
assert(windowsLines.some((line) => line.trim() === "npm install $tarball"), "Windows tests the normal consumer install");
assert(windowsLines.some((line) => line.trim() === "npm install $tarball --ignore-scripts"), "Windows tests the disabled-lifecycle consumer install");
const nativeCommands = windowsLines.flatMap((line, index) => /^\s*(?:node|npm)\s/.test(line) ? [index] : []);
assert(nativeCommands.length >= 8, "Windows candidate smoke retains all native command gates");
for (const index of nativeCommands) {
  assert(windowsLines[index + 1]?.trim() === 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    `Windows preserves failure from: ${windowsLines[index].trim().split(/\s+/).slice(0, 3).join(" ")}`);
}

const actionRefs = [...`${releaseWorkflow}\n${ciWorkflow}`.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)].map((match) => match[1]);
assert(actionRefs.length > 0, "release and CI workflows declare actions");
for (const ref of actionRefs) {
  const separator = ref.lastIndexOf("@");
  assert(separator > 0 && /^[0-9a-f]{40}$/.test(ref.slice(separator + 1)), `action is pinned by commit: ${ref}`);
}

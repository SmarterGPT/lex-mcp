#!/usr/bin/env node
/**
 * lex-mcp Pack Smoke Test
 *
 * Verifies the published artifact works in a clean install:
 *   1. Pack @smartergpt/lex locally, or consume LEX_MCP_LEX_TARBALL
 *   2. Pack @smartergpt/lex-mcp (local)
 *   3. Install both tarballs in a clean temp directory
 *   4. Spawn the installed entry point
 *   5. Verify initialize, tools/list, and system_introspect work
 *
 * Usage:
 *   node test-pack-smoke.mjs
 *   node test-pack-smoke.mjs --verbose
 *   node test-pack-smoke.mjs --keep   # keep temp dir for inspection
 */

import { execFileSync, spawn } from "child_process";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, readFileSync, realpathSync } from "fs";
import { basename, delimiter, dirname, join, resolve, sep } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";

const verbose = process.argv.includes("--verbose");
const keep = process.argv.includes("--keep");
const ignoreScripts = process.argv.includes("--ignore-scripts");
const installFlags = ignoreScripts ? ["--ignore-scripts"] : [];

const LEX_ROOT = process.env.LEX_MCP_LEX_ROOT || join(import.meta.dirname, "..", "lex");
const STAGED_LEX_TARBALL = process.env.LEX_MCP_LEX_TARBALL;
const USE_PUBLIC_LEX = process.env.LEX_MCP_USE_PUBLIC_LEX === "1";
const LEX_MCP_ROOT = import.meta.dirname;

// Invoke npm's JavaScript entry with argv on Windows too; never interpolate paths
// into a shell command. Direct `node test-pack-smoke.mjs` remains supported.
function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const pathDir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const npmPath = join(pathDir, process.platform === "win32" ? "npm.cmd" : "npm");
    if (!existsSync(npmPath)) continue;
    const npmRealPath = realpathSync(npmPath);
    candidates.push(npmRealPath, join(dirname(npmRealPath), "node_modules", "npm", "bin", "npm-cli.js"));
  }
  const cli = candidates.find((candidate) => candidate && basename(candidate) === "npm-cli.js" && existsSync(candidate));
  if (!cli) throw new Error("Cannot locate npm-cli.js; run this test through npm run test:pack");
  return realpathSync(cli);
}
const NPM_CLI = findNpmCli();
function runNpm(args, options) {
  return execFileSync(process.execPath, [NPM_CLI, ...args], options);
}

let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}: ${detail}`);
    failed++;
  }
}

function log(msg) {
  if (verbose) console.log(`  [info] ${msg}`);
}

/**
 * Send JSON-RPC messages to a server process and collect responses.
 */
async function sendMessages(proc, messages) {
  const responses = [];
  let buffer = "";

  const closePromise = new Promise((resolve) => {
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          responses.push(JSON.parse(line));
        } catch { /* ignore non-JSON lines */ }
      }
    });
    proc.on("close", (code) => {
      if (buffer.trim()) {
        try { responses.push(JSON.parse(buffer)); } catch { /* ignore */ }
      }
      resolve(code);
    });
  });

  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
    if (verbose) process.stderr.write(`    [stderr] ${d}`);
  });

  // Wait for server startup
  const earlyExit = await Promise.race([
    new Promise((resolve) => proc.on("close", (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);

  if (earlyExit !== null) {
    throw new Error(`Server exited immediately with code ${earlyExit}: ${stderr}`);
  }

  // Send messages
  for (const msg of messages) {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    await new Promise((r) => setTimeout(r, 400));
  }

  // Allow processing
  await new Promise((r) => setTimeout(r, 600));

  proc.kill("SIGTERM");
  await closePromise;
  return responses;
}

async function main() {
  console.log("📦 lex-mcp Pack Smoke Test\n");

  // ── Step 1: Pack both packages ──────────────────────────────────────────

  console.log("📋 Step 1: Staging @smartergpt/lex and packing @smartergpt/lex-mcp");

  const packDir = mkdtempSync(join(tmpdir(), "lex-pack-smoke-"));
  log(`Temp dir: ${packDir}`);

  let lexTarball, lexMcpTarball, expectedLexIntegrity;
  try {
    if (USE_PUBLIC_LEX) {
      lexTarball = null;
      log("Using the wrapper's exact public Lex dependency");
    } else if (STAGED_LEX_TARBALL) {
      lexTarball = resolve(STAGED_LEX_TARBALL);
      assert(existsSync(lexTarball), "staged lex tarball exists", `Expected: ${lexTarball}`);
      log(`staged lex tarball: ${lexTarball}`);
    } else {
      // Pack lex
      log("Packing @smartergpt/lex...");
      const lexPackOut = runNpm(["pack", "--pack-destination", packDir], {
        cwd: LEX_ROOT,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      lexTarball = join(packDir, lexPackOut.split("\n").pop().trim());
      assert(existsSync(lexTarball), "lex tarball created", `Expected: ${lexTarball}`);
      log(`lex tarball: ${lexTarball}`);
    }

    if (lexTarball) {
      expectedLexIntegrity = `sha512-${createHash("sha512").update(readFileSync(lexTarball)).digest("base64")}`;
      if (!STAGED_LEX_TARBALL) {
        const releaseLock = JSON.parse(readFileSync(join(LEX_MCP_ROOT, "package-lock.json"), "utf-8"));
        const lockedIntegrity = releaseLock.packages?.["node_modules/@smartergpt/lex"]?.integrity;
        assert(lockedIntegrity === expectedLexIntegrity, "release lock integrity binds the packed Lex candidate", `lock: ${lockedIntegrity}, candidate: ${expectedLexIntegrity}`);
      }
    }

    // Pack lex-mcp
    log("Packing @smartergpt/lex-mcp...");
    const mcpPackOut = runNpm(["pack", "--pack-destination", packDir], {
      cwd: LEX_MCP_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    lexMcpTarball = join(packDir, mcpPackOut.split("\n").pop().trim());
    assert(existsSync(lexMcpTarball), "lex-mcp tarball created", `Expected: ${lexMcpTarball}`);
    log(`lex-mcp tarball: ${lexMcpTarball}`);
  } catch (err) {
    console.error(`\n💥 Pack failed: ${err.message}`);
    if (!keep) rmSync(packDir, { recursive: true, force: true });
    process.exit(1);
  }

  // ── Step 2: Clean install ───────────────────────────────────────────────

  console.log("\n📋 Step 2: Clean install from tarballs");

  const installDir = join(packDir, "install");
  try {
    mkdirSync(installDir, { recursive: true });
    runNpm(["init", "-y"], {
      cwd: installDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (lexTarball) {
      log("Installing lex tarball...");
      runNpm(["install", lexTarball, ...installFlags], {
        cwd: installDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 180000,
      });
    }

    log("Installing lex-mcp tarball...");
    runNpm(["install", lexMcpTarball, ...installFlags], {
      cwd: installDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 180000,
    });

    const nativeProof = execFileSync(process.execPath,
      [join(LEX_MCP_ROOT, "scripts", "check-bundled-sqlite.mjs"), installDir],
      { encoding: "utf8", timeout: 30000 });
    const nativeResult = JSON.parse(nativeProof.trim());
    assert(nativeResult.fts5 === true && nativeResult.noSQLiteInstallHooks === true,
      `bundled SQLite works after ${ignoreScripts ? "ignore-scripts" : "normal"} installation`);

    // Verify node_modules layout
    const mcpBin = join(installDir, "node_modules", ".bin", "lex-mcp");
    const mcpIndex = join(installDir, "node_modules", "@smartergpt", "lex-mcp", "index.mjs");
    const mcpStdio = join(installDir, "node_modules", "@smartergpt", "lex-mcp", "stdio.mjs");
    const mcpStdioTypes = join(installDir, "node_modules", "@smartergpt", "lex-mcp", "stdio.d.ts");
    const lexPkg = join(installDir, "node_modules", "@smartergpt", "lex", "package.json");
    const lexMcpPkg = join(installDir, "node_modules", "@smartergpt", "lex-mcp", "package.json");

    assert(existsSync(mcpIndex), "lex-mcp index.mjs installed", `${mcpIndex} not found`);
    assert(existsSync(mcpBin), "lex-mcp executable installed", `${mcpBin} not found`);
    assert(existsSync(mcpStdio), "lex-mcp public stdio host installed", `${mcpStdio} not found`);
    assert(existsSync(mcpStdioTypes), "lex-mcp stdio declarations installed", `${mcpStdioTypes} not found`);
    assert(existsSync(lexPkg), "@smartergpt/lex installed as dependency", `${lexPkg} not found`);
    assert(existsSync(lexMcpPkg), "@smartergpt/lex-mcp package metadata installed", `${lexMcpPkg} not found`);

    // Verify the installed artifacts retain the coordinated release contract.
    const lexPkgJson = JSON.parse(readFileSync(lexPkg, "utf-8"));
    const lexMcpPkgJson = JSON.parse(readFileSync(lexMcpPkg, "utf-8"));
    const installLock = JSON.parse(readFileSync(join(installDir, "package-lock.json"), "utf-8"));
    assert(lexPkgJson.exports?.["./mcp-server"] != null, "lex exports ./mcp-server subpath", `exports: ${JSON.stringify(Object.keys(lexPkgJson.exports || {}))}`);
    assert(lexMcpPkgJson.mcpName === "dev.smartergpt/lex", "packed wrapper mcpName matches the registry namespace", `Got: ${lexMcpPkgJson.mcpName}`);
    assert(lexMcpPkgJson.dependencies?.["@smartergpt/lex"] === lexMcpPkgJson.version, "packed wrapper pins the matching Lex release", `dependency: ${lexMcpPkgJson.dependencies?.["@smartergpt/lex"]}, wrapper: ${lexMcpPkgJson.version}`);
    assert(lexMcpPkgJson.exports?.["."]?.import === "./stdio.mjs", "packed wrapper exports the stdio host", `exports: ${JSON.stringify(lexMcpPkgJson.exports)}`);
    assert(lexMcpPkgJson.exports?.["."]?.types === "./stdio.d.ts", "packed wrapper exports stdio declarations", `exports: ${JSON.stringify(lexMcpPkgJson.exports)}`);
    assert(lexPkgJson.version === lexMcpPkgJson.version, "packed Lex core matches wrapper version", `core: ${lexPkgJson.version}, wrapper: ${lexMcpPkgJson.version}`);
    assert(lexPkgJson.engines?.node === lexMcpPkgJson.engines?.node, "packed wrapper Node engine matches Lex core", `wrapper: ${lexMcpPkgJson.engines?.node}, core: ${lexPkgJson.engines?.node}`);
    if (lexTarball) {
      const installedLex = installLock.packages?.["node_modules/@smartergpt/lex"];
      const installedLexSource = installedLex?.resolved;
      assert(installedLexSource?.startsWith("file:"), "clean install retains the packed Lex candidate", `resolved: ${installedLexSource}`);
      assert(installedLex?.integrity === expectedLexIntegrity, "clean install retains the candidate bytes", `installed: ${installedLex?.integrity}, candidate: ${expectedLexIntegrity}`);
      if (installedLexSource?.startsWith("file:")) {
        const installedLexPath = fileURLToPath(new URL(installedLexSource, pathToFileURL(installDir + sep)));
        assert(realpathSync(installedLexPath) === realpathSync(lexTarball), "clean install retains the exact candidate source", `installed: ${installedLexPath}, candidate: ${lexTarball}`);
      }
    } else {
      const releaseLock = JSON.parse(readFileSync(join(LEX_MCP_ROOT, "package-lock.json"), "utf8"));
      const lockedLex = releaseLock.packages?.["node_modules/@smartergpt/lex"];
      const installedLex = installLock.packages?.["node_modules/@smartergpt/lex"];
      assert(installedLex?.resolved === lockedLex?.resolved,
        "clean public install retains the release-locked Lex source", `installed: ${installedLex?.resolved}, locked: ${lockedLex?.resolved}`);
      assert(installedLex?.integrity === lockedLex?.integrity,
        "clean public install retains the release-locked Lex bytes", `installed: ${installedLex?.integrity}, locked: ${lockedLex?.integrity}`);
    }
  } catch (err) {
    console.error(`\n💥 Install failed: ${err.message}`);
    if (err.stderr) console.error(err.stderr.toString());
    if (!keep) rmSync(packDir, { recursive: true, force: true });
    process.exit(1);
  }

  // ── Step 3: Spawn and test the installed server ─────────────────────────

  console.log("\n📋 Step 3: Verify installed server responds correctly");

  const entryPoint = join(installDir, "node_modules", "@smartergpt", "lex-mcp", "index.mjs");
  const workDir = join(packDir, "workspace");
  mkdirSync(workDir, { recursive: true });

  try {
    const proc = spawn(process.execPath, [entryPoint], {
      cwd: workDir,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LEX_"))),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LEX_WORKSPACE_ROOT: workDir,
        NODE_PATH: join(installDir, "node_modules"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = await sendMessages(proc, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pack-test", version: "1.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "system_introspect", arguments: { format: "compact" } } },
    ]);

    // Verify initialize
    const init = responses.find((r) => r.id === 1);
    assert(init != null, "Got initialize response", "No response");
    assert(init?.result?.serverInfo?.name === "lex-mcp", "serverInfo.name is lex-mcp", `Got: ${init?.result?.serverInfo?.name}`);
    const installedWrapper = JSON.parse(readFileSync(join(installDir, "node_modules", "@smartergpt", "lex-mcp", "package.json"), "utf-8"));
    assert(init?.result?.serverInfo?.version === installedWrapper.version, "serverInfo.version matches packed wrapper", `server: ${init?.result?.serverInfo?.version}, wrapper: ${installedWrapper.version}`);

    // Verify tools/list
    const tools = responses.find((r) => r.id === 2);
    const toolNames = (tools?.result?.tools || []).map((t) => t.name).sort();
    assert(toolNames.length === 15, "15 tools from packed artifact", `Got: ${toolNames.length}`);

    assert(toolNames.includes("destination_inspect"), "Destination preflight is delivered by the packed artifact");

    // Verify system_introspect
    const introspect = responses.find((r) => r.id === 3);
    assert(introspect?.result != null, "system_introspect returned result", "No result");
    assert(!("diagnostics" in (introspect?.result || {})), "diagnostics are absent unless requested", `Got: ${JSON.stringify(introspect?.result?.diagnostics)}`);

    // Parse the introspect text content to check version
    const content = introspect?.result?.content?.[0]?.text;
    if (content) {
      try {
        const data = JSON.parse(content);
        const introVersion = data.version ?? data.v;
        assert(introVersion != null && introVersion !== "0.1.0", "introspect version is not stale", `Got: ${introVersion}`);
        assert(introVersion === init?.result?.serverInfo?.version, "introspect version matches serverInfo", `introspect: ${introVersion}, serverInfo: ${init?.result?.serverInfo?.version}`);
      } catch {
        // Human-readable format - extract version with emoji prefix
        const match = content.match(/📦\s*Version:\s*(\d+\.\d+\.\d+\S*)/i);
        if (match) {
          const introVersion = match[1];
          assert(introVersion !== "0.1.0", "introspect version is not stale", `Got: ${introVersion}`);
          assert(introVersion === init?.result?.serverInfo?.version, "introspect version matches serverInfo", `introspect: ${introVersion}, serverInfo: ${init?.result?.serverInfo?.version}`);
        } else {
          log("introspect returned non-JSON content without parseable version, skipping version check");
        }
      }
    }

    // Verify DB was created at the canonical path
    const dbPath = join(workDir, ".smartergpt", "lex", "memory.db");
    // DB may not be created until a write operation, so this is optional
    log(`DB path check: ${dbPath} exists=${existsSync(dbPath)}`);

  } catch (err) {
    failed++;
    console.error(`\n💥 Server test failed: ${err.message}`);
    if (err.stack) log(err.stack);
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(50)}`);

  if (keep) {
    console.log(`\n📁 Temp dir preserved: ${packDir}`);
  } else {
    rmSync(packDir, { recursive: true, force: true });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n💥 Fatal error: ${err.message}`);
  process.exit(1);
});

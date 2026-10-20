#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// Resolve through the installed core, including clean packed-consumer layouts.
const consumer = resolve(process.argv[2] ?? process.cwd());
const corePackagePath = join(consumer, "node_modules", "@smartergpt", "lex", "package.json");
const core = JSON.parse(readFileSync(corePackagePath, "utf8"));
assert.equal(core.name, "@smartergpt/lex");
for (const hook of ["preinstall", "install", "postinstall"]) {
  assert.equal(core.scripts?.[hook], undefined, `Lex has no ${hook} hook`);
}
const fromCore = createRequire(corePackagePath);
const sqlitePackage = fromCore("better-sqlite3-multiple-ciphers/package.json");
assert.equal(sqlitePackage.version, "13.0.3", "Use the approved bundled-native release");
assert.equal(sqlitePackage.gypfile, false, "npm must not synthesize a native build hook");
for (const hook of ["preinstall", "install", "postinstall"]) {
  assert.equal(sqlitePackage.scripts?.[hook], undefined, `SQLite has no ${hook} hook`);
}
const Database = fromCore("better-sqlite3-multiple-ciphers");
const db = new Database(":memory:");
let sqliteVersion;
let bundledNative;
try {
  const sqliteRoot = dirname(realpathSync(fromCore.resolve("better-sqlite3-multiple-ciphers/package.json")));
  const targetPlatform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime
    ? "linuxmusl"
    : process.platform;
  const target = `${targetPlatform}-${process.arch}.node`;
  const expectedNative = realpathSync(join(sqliteRoot, "prebuilds", target));
  const loadedNative = Object.keys(fromCore.cache).filter((path) => path.endsWith(".node"));
  assert.ok(loadedNative.some((path) => realpathSync(path) === expectedNative), "SQLite loaded the platform binary from its published prebuilds");
  bundledNative = `prebuilds/${target}`;
  db.exec("CREATE VIRTUAL TABLE bundled_probe USING fts5(body)");
  db.prepare("INSERT INTO bundled_probe(body) VALUES (?)").run("bundled native proof");
  assert.equal(db.prepare("SELECT count(*) AS n FROM bundled_probe WHERE bundled_probe MATCH ?").get("proof").n, 1);
  sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
} finally {
  db.close();
}
console.log(JSON.stringify({ bundledSQLite: sqlitePackage.version, bundledNative, sqliteVersion, fts5: true, noSQLiteInstallHooks: true }));

<div align="center">

# @smartergpt/lex-mcp

## Give an MCP client a stdio doorway into Lex.

[Lex](https://github.com/Guffawaffle/lex) remembers decisions, blockers, next steps, and repository
boundaries across agent sessions. Lex-MCP does one narrower job: it delivers Lex's tools to an MCP
client through a standalone newline-delimited JSON-RPC process.

**Use it when your agent host needs an MCP command. Skip it when you already invoke or compose Lex
directly.**

</div>

[Do I need Lex-MCP?](#do-i-need-lex-mcp) · [Read-only smoke test](#smallest-reversible-smoke-test) · [Client setup](#connect-an-mcp-client) · [Trusted hosts](#trusted-lex-4-hosts) · [Release contract](#release-contract)

## Do I need Lex-MCP?

Use Lex-MCP when all of these are true:

- your agent host supports MCP over stdio;
- it expects a standalone command such as `npx @smartergpt/lex-mcp`;
- you want that client to call Lex's Frame, policy, Atlas, introspection, and maintenance tools.

You probably do **not** need this package when:

- the Lex CLI already gives your workflow the continuity it needs;
- your application embeds `@smartergpt/lex/mcp-server` and already owns transport;
- AXF or another trusted host already composes the relevant Lex capability;
- you expect an MCP wrapper to provide authentication, tenant authority, orchestration, or cloud
  storage. It does not.

Lex owns the capabilities, storage contracts, policy behavior, and authorization decisions. The
agent host owns what it authenticates and which workspace it selects. Lex-MCP owns only stdio
delivery and process lifecycle.

### Two launch modes

| Mode | Use it for | What establishes scope |
|---|---|---|
| Local compatibility launcher | One operator-controlled workspace and an MCP client that needs a command | Current directory, `LEX_WORKSPACE_ROOT`, and Lex's local compatibility configuration |
| Trusted Lex 4 host | A host that already authenticates principals and binds tenant/workspace-scoped authority | Explicit host inputs and Lex's trusted runtime-scope composition |

The local launcher is convenient, but its environment values are configuration—not proof of
identity, grants, or tenant authority. A multi-tenant deployment must use trusted-host composition;
setting PostgreSQL environment variables on the compatibility launcher does not make it trusted.

Not sure which path applies? Give an agent the bounded, read-only
[fit evaluation](./docs/agent-evaluation.md). It returns one recommendation: `adopt`, `pilot`,
`defer`, or `not a fit`.

## Smallest reversible smoke test

This POSIX-shell test launches version `4.4.1`, performs only the MCP handshake and `tools/list`,
and confines the package cache and any Lex compatibility state to one temporary directory. It does
not call a write tool or modify the repository.

`npx` may contact the npm registry and execute package installation code. Run this only after that
network and code-execution boundary is approved.

```bash
smoke_dir="$(mktemp -d)"

(
  cd "$smoke_dir"
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"lex-mcp-smoke","version":"1.0.0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    | LEX_WORKSPACE_ROOT="$smoke_dir" \
      LEX_DB_PATH="$smoke_dir/memory.db" \
      npm_config_cache="$smoke_dir/npm-cache" \
      npx --yes @smartergpt/lex-mcp@4.4.1
)

find "$smoke_dir" -maxdepth 4 -print
```

A successful response identifies `lex-mcp` version `4.4.1` and returns Lex's tool list. Review the
printed temporary path, then remove only that directory:

```bash
test -n "$smoke_dir" && test -d "$smoke_dir" && rm -rf -- "$smoke_dir"
unset smoke_dir
```

This is read-only at the MCP tool surface. Compatibility startup may initialize SQLite state, which
is why the test redirects both the database and npm cache into the disposable directory.

## Connect an MCP client

Lex-MCP requires Node.js 24 or newer (`>=24`). Pinning the wrapper version makes the launched
artifact reproducible; that wrapper in turn pins the exact matching Lex release.

### VS Code / Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "lex": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@smartergpt/lex-mcp@4.4.1"],
      "env": {
        "LEX_WORKSPACE_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`, using the absolute project path the server should treat as its
local workspace:

```json
{
  "mcpServers": {
    "lex": {
      "command": "npx",
      "args": ["--yes", "@smartergpt/lex-mcp@4.4.1"],
      "env": {
        "LEX_WORKSPACE_ROOT": "/absolute/path/to/project"
      }
    }
  }
}
```

These examples use the local compatibility launcher. In controlled or offline environments,
install the reviewed package through your normal dependency process and configure the client to use
that installed executable instead of allowing `npx` to fetch it.

To remove a pilot, delete the MCP client entry. Remove a package dependency only if the pilot added
one. Do not delete an existing Lex database, configuration, or Frame history as part of wrapper
cleanup.

## What crosses the boundary

| Concern | Owner |
|---|---|
| MCP line parsing, response serialization, ordered dispatch, EOF, and shutdown | Lex-MCP |
| Tool registry, Frames, policy, Atlas, store contracts, validation, and authorization outcomes | Lex |
| Authenticated principal, tenant/workspace selection, process evidence, pools, and runtime IDs | Trusted host |
| MCP client configuration and the project data submitted to tools | Operator and agent host |

Lex-MCP does not mint authority, infer a trusted tenant from environment variables, or broaden a
caller's grants. Stored Frame bodies are historical project data; clients should not treat recalled
text as executable instructions.

## Local compatibility configuration

The executable uses the current directory or `LEX_WORKSPACE_ROOT` as the project root and delegates
store and policy resolution to Lex.

| Variable | Description | Default |
|---|---|---|
| `LEX_WORKSPACE_ROOT` | Local project root | Current directory |
| `LEX_STORE` | Compatibility Frame backend (`sqlite` or `postgres`) | `sqlite` |
| `LEX_DATABASE_URL` | Compatibility PostgreSQL connection URL | — |
| `LEX_POSTGRES_PASSWORD` | Password for a credential-free compatibility URL | — |
| `LEX_POSTGRES_POOL_MAX` | Compatibility PostgreSQL pool size | `10` |
| `LEX_DB_PATH` | SQLite database path; ignored by PostgreSQL | `.smartergpt/lex/memory.db` |
| `LEX_MEMORY_DB` | Compatibility alias for `LEX_DB_PATH` | — |
| `LEX_DEBUG` | Enable diagnostic logging to stderr | Off |

When both SQLite path variables are set, `LEX_DB_PATH` wins. For a multi-root local setup, use the
same absolute `LEX_DB_PATH` for direct Lex, Lex-MCP, and any routed Lex process. Keep database
credentials in the host environment or a secret manager, not in checked-in MCP configuration.

## Trusted Lex 4 hosts

Use the public transport export when a trusted host needs Lex-MCP's ordered stdio delivery. The host
must construct canonical authority and pass Lex's `host.mcp` options through unchanged:

```js
import { startLexMcpStdio } from "@smartergpt/lex-mcp";
import { createPostgresTrustedRuntimeHost } from "@smartergpt/lex/runtime-scope";

const host = createPostgresTrustedRuntimeHost({
  authorityPool, // read-only runtime authority connection, never the admin pool
  authoritySchema, // explicit PostgreSQL schema containing canonical authority
  selection, // authenticated tenant/workspace selection owned by this host
  frameStoreBinder, // scope-bound PostgreSQL FrameStore binder
  process: capturedProcessEvidence,
  runtimeId,
  traceId,
  emitDiagnostics,
});

const transport = startLexMcpStdio({ serverOptions: host.mcp });
```

The host supplies its pools, authority schema, authenticated selection, captured process evidence,
and IDs. Lex resolves and enforces the resulting authorized scope. Neither Lex nor this wrapper
reconstructs trusted authority from ambient environment variables. See Lex's
[runtime-scope contract](https://github.com/Guffawaffle/lex/blob/main/docs/RUNTIME_SCOPE_CONTRACT.md)
and [PostgreSQL scope security](https://github.com/Guffawaffle/lex/blob/main/docs/POSTGRES_SCOPE_SECURITY.md)
for the complete host contract.

## Agent and automation output

Agents can request `format: "compact"` on supported Frame and introspection tools to reduce
presentation metadata. Runtime-scope diagnostics are absent by default. They appear only when a
caller explicitly requests `diagnostics: "summary"` or `"full"` and has the required authority.
Formatting and diagnostics never change scope or authorization outcomes.

## Tools delivered from Lex

The current coordinated release exposes 14 tools:

- `frame_create`, `frame_validate`, `frame_search`, `frame_get`, and `frame_list`;
- `policy_check`, `timeline_show`, and `atlas_analyze`;
- `system_introspect`, `help`, and `hints_get`;
- `contradictions_scan`, `db_stats`, and `turncost_calculate`.

Lex defines these tools and their behavior. Lex-MCP transports their requests and responses.

## Release contract

`@smartergpt/lex-mcp` is a coordinated Lex release, not a floating compatibility layer. Each
wrapper release:

- pins `@smartergpt/lex` to the same exact version;
- reports that version through MCP `serverInfo` and Lex introspection;
- supports the exact same Node.js range as Lex.

For this release, the wrapper, dependency pin, installed Lex core, and server-reported version are
all `4.4.1`; the Node range is `>=24`.

Publish the matching Lex release before publishing this wrapper. Candidate CI installs the exact
public dependency graph from the committed lockfile, rebuilds native dependencies, runs the delivery
gate, and packs one retained wrapper artifact. It must not use or persist a `file:` dependency.

After Lex is public:

1. run `npm install --package-lock-only --ignore-scripts` in this repository;
2. verify the lock resolves the exact registry tarball and includes `sha512-` integrity;
3. verify no `file:` dependency was introduced;
4. commit the resulting lockfile before creating the signed release tag or publishing Lex-MCP.

An explicit `workflow_dispatch` from the exact current `main` commit with `publish=true` builds and
tests the retained candidate on Linux and Windows, rechecks live `main`, and publishes those exact
bytes through npm Trusted Publishing with provenance. The `npm-release` environment restricts that
OIDC authority to `main`; npm holds no long-lived automation token for this repository. The workflow
then verifies public integrity and binds npm's signed provenance to this repository, workflow, ref,
and source commit.

After public verification, create and push the signed annotated release tag at that same commit. The
tag lane re-verifies the immutable tag, public package, retained artifact, and live `main` identity
before creating the GitHub release.

## Develop and verify

```bash
npm ci --ignore-scripts
npm rebuild better-sqlite3-multiple-ciphers
npm test
npm run test:pack
```

`npm test` covers the public TypeScript surface, stdio lifecycle and error behavior, exact release
contract, local compatibility resolution, MCP handshake, introspection, and the 14-tool inventory.
`npm run test:pack` installs locally packed Lex and Lex-MCP artifacts into a clean temporary project
and repeats the public launch checks.

Before the matching Lex version is public, validate an externally reviewed packed Lex candidate
without changing this repository's registry-shaped release lock:

```bash
LEX_MCP_LEX_TARBALL=/absolute/path/to/smartergpt-lex-4.4.1.tgz npm run test:pack
```

The smoke's temporary install lock must retain that supplied tarball as the installed Lex source;
the release lock in this repository must still resolve the eventual public registry artifact.

## Learn more

- [Agent fit evaluation](./docs/agent-evaluation.md)
- [Lex](https://github.com/Guffawaffle/lex): durable agent work context, policy, Atlas, storage, and
  trusted runtime scope
- [Model Context Protocol](https://modelcontextprotocol.io/)

Lex-MCP is available under the MIT License.

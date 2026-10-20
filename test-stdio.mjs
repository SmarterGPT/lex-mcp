#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { startLexMcpStdio } from "./stdio.mjs";

const runtimeScope = Object.freeze({ authorize: async () => ({}) });
const frameStoreBinder = Object.freeze({ bind: async () => ({}) });
const serverOptions = Object.freeze({ runtimeScope, frameStoreBinder });
const originalWorkspaceRoot = process.env.LEX_WORKSPACE_ROOT;
const transportSource = readFileSync(
  new URL("./stdio.mjs", import.meta.url),
  "utf8",
);
assert.doesNotMatch(transportSource, /process\.(?:env|cwd)/);

const input = new PassThrough();
const output = new PassThrough();
const errorOutput = new PassThrough();
let stdout = "";
let stderr = "";
output.on("data", (chunk) => {
  stdout += chunk.toString();
});
errorOutput.on("data", (chunk) => {
  stderr += chunk.toString();
});

let receivedOptions;
let closed = 0;
const handled = [];
const transport = startLexMcpStdio({
  serverOptions,
  input,
  output,
  errorOutput,
  debug: true,
  serverFactory(options) {
    receivedOptions = options;
    return {
      async handleRequest(request) {
        handled.push(request);
        if (request.id === 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (request.method === "fail") {
          const error = new Error("deliberate failure");
          error.code = "TEST_FAILURE";
          throw error;
        }
        if (request.method === "notifications/fail") {
          throw new Error("deliberate notification failure");
        }
        if (request.method === "returned-error") {
          return {
            error: {
              code: "LEX_RETURNED_FAILURE",
              message: "returned failure",
              data: { retryable: false },
              context: { requestedTool: "missing" },
              nextActions: ["inspect tools/list"],
              metadata: { category: "validation" },
            },
          };
        }
        return { content: [{ type: "text", text: "compact result" }] };
      },
      async close() {
        closed += 1;
      },
    };
  },
});

assert.strictEqual(receivedOptions, serverOptions);
assert.strictEqual(receivedOptions.runtimeScope, runtimeScope);
assert.strictEqual(receivedOptions.frameStoreBinder, frameStoreBinder);
assert.equal(process.env.LEX_WORKSPACE_ROOT, originalWorkspaceRoot);

const inputEnded = once(input, "end");
input.write(
  [
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/fail" }),
    JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/call" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    JSON.stringify({ jsonrpc: "2.0", id: 0, method: "fail" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "returned-error",
    }),
    "{malformed",
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "trailing" }),
  ].join("\n"),
);
input.end();
await inputEnded;
await transport.idle();

const responses = stdout
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

assert.deepEqual(
  handled.map(({ id }) => id),
  [undefined, undefined, 1, 0, 4, 2],
  "notifications are dispatched without ids and all messages preserve wire order",
);
assert.deepEqual(
  handled.map(({ method }) => method),
  [
    "notifications/initialized",
    "notifications/fail",
    "tools/call",
    "fail",
    "returned-error",
    "trailing",
  ],
  "initialized and failing notifications both reach the server",
);
assert.deepEqual(responses[0], {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32600, message: "Invalid Request" },
});
assert.deepEqual(responses[1], {
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: "compact result" }] },
});
assert.equal(responses[2].id, 0, "request id 0 is preserved on errors");
assert.equal(responses[2].error.code, -32000);
assert.equal(responses[2].error.data.lexCode, "TEST_FAILURE");
assert.deepEqual(responses[3].error, {
  code: -32000,
  message: "returned failure",
  data: {
    retryable: false,
    lexCode: "LEX_RETURNED_FAILURE",
    context: { requestedTool: "missing" },
    nextActions: ["inspect tools/list"],
    metadata: { category: "validation" },
  },
});
assert.equal(responses[4].id, null);
assert.equal(responses[4].error.code, -32700);
assert.equal(
  responses[5].id,
  2,
  "EOF flushes a final record without a newline",
);
for (const response of responses.filter(({ error }) => error)) {
  assert.equal(
    Number.isInteger(response.error.code),
    true,
    "every JSON-RPC error code is numeric",
  );
}
assert.match(stderr, /Notification: notifications\/initialized/);
assert.match(
  stderr,
  /Notification failed \(notifications\/fail\): deliberate notification failure/,
);
assert.doesNotMatch(stdout, /tenantId|workspaceId|authorizedScope|diagnostics/);
assert.equal(
  responses.length,
  6,
  "dispatched notifications never produce JSON-RPC responses",
);

await transport.idle();
assert.equal(closed, 1, "EOF drains and closes the server");
await transport.close();
assert.equal(closed, 1, "close remains idempotent after EOF");

const closeInput = new PassThrough();
const closeOutput = new PassThrough();
const closeOrder = [];
const closeTransport = startLexMcpStdio({
  serverOptions: {},
  input: closeInput,
  output: closeOutput,
  serverFactory() {
    return {
      async handleRequest(request) {
        closeOrder.push(`handle:${request.id}`);
        return { ok: true };
      },
      async close() {
        closeOrder.push("close");
      },
    };
  },
});
closeInput.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "final" }));
await closeTransport.close();
assert.deepEqual(
  closeOrder,
  ["handle:3", "close"],
  "close flushes a trailing record before closing Lex",
);

const destinationInput = new PassThrough();
const destinationOutput = new PassThrough();
let destinationWire = "";
const destinationRequests = [];
const destination = Object.freeze({
  identity: `lex-destination-v1:sha256:${"a".repeat(64)}`,
  backend: { identity: { verification: "trusted-host", identity: "fixture-backend" } },
  workspaceId: "fixture-workspace",
});
const receipt = { frame_id: "fixture-frame", destination };
destinationOutput.on("data", (chunk) => { destinationWire += chunk.toString(); });
const destinationTransport = startLexMcpStdio({
  serverOptions,
  input: destinationInput,
  output: destinationOutput,
  serverFactory() {
    return {
      async handleRequest(request) {
        destinationRequests.push(request);
        return request.params.name === "destination_inspect"
          ? { data: { destination } }
          : { data: receipt };
      },
      async close() {},
    };
  },
});
const destinationEnded = once(destinationInput, "end");
destinationInput.end([
  { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "destination_inspect", arguments: {} } },
  { jsonrpc: "2.0", id: 11, method: "tools/call", params: {
    name: "frame_create", arguments: { expected_destination: destination.identity },
  } },
].map((request) => JSON.stringify(request)).join("\n"));
await destinationEnded;
await destinationTransport.idle();
const destinationResponses = destinationWire.trim().split("\n").map((line) => JSON.parse(line));
assert.deepEqual(destinationResponses[0].result.data, { destination });
assert.deepEqual(destinationResponses[1].result.data, receipt);
assert.deepEqual(destinationRequests[0].params.arguments, {});
assert.equal(destinationRequests[1].params.arguments.expected_destination, destination.identity);
await destinationTransport.close();

console.log(
  "✅ stdio transport preserves explicit Lex 4 scope, compact responses and destination receipts",
);

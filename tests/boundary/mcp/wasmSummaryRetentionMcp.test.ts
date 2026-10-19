import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished, vi } from "vitest";

import type { ExecutionOptions } from "../../../src/application/AnalysisProvider.js";
import type { WasmArtifactPort } from "../../../src/application/wasm/WasmArtifactPort.js";
import type { WasmArtifactExecution } from "../../../src/application/wasm/WasmArtifactPort.js";
import { WasmArtifactService } from "../../../src/application/wasm/WasmArtifactService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  wasmArtifactExecution,
  wasmArtifactFixture,
} from "../../fixtures/wasm/artifact.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

const contract = toolContract("inspect_wasm_artifact");

it("refuses WASM summary delivery before provider entry without Evidence retention", async () => {
  const value = wasmArtifactFixture();
  const inspect = vi.fn(
    (
      _input: unknown,
      _options?: ExecutionOptions,
    ): Promise<Result<WasmArtifactExecution, AnalysisError>> =>
      Promise.resolve(ok(wasmArtifactExecution(value))),
  );
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect,
  } satisfies WasmArtifactPort);
  const session = createTestBinarySession(() => {
    throw new Error("No native provider expected");
  });
  const server = createServer(
    { kind: "fixed", analysis: session },
    { wasmArtifact: service, environment: {} },
  );
  const client = new Client({ name: "wasm-summary-retention", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const summary = await client.callTool({
    name: contract.name,
    arguments: { path: value.artifact.path, detail: "summary" },
  });
  const summaryError = parseMcpToolError(summary).error;
  expect(summaryError.code).toBe("capability_unavailable");
  expect(summaryError.message).toContain("does not retain Evidence");
  expect(inspect).toHaveBeenCalledTimes(0);

  const complete = await client.callTool({
    name: contract.name,
    arguments: { path: value.artifact.path, detail: "complete" },
  });
  expect(complete.isError).not.toBe(true);
  expect(inspect).toHaveBeenCalledTimes(1);

  inspect.mockImplementationOnce(() =>
    Promise.resolve(
      err(new AnalysisInputError(contract.name, { cause: undefined })),
    ),
  );
  const refusedSummary = await client.callTool({
    name: contract.name,
    arguments: { path: value.artifact.path, detail: "summary" },
  });
  expect(parseMcpToolError(refusedSummary).error.code).toBe(
    "capability_unavailable",
  );
  expect(inspect).toHaveBeenCalledTimes(1);

  const failed = await client.callTool({
    name: contract.name,
    arguments: { path: value.artifact.path, detail: "complete" },
  });
  expect(parseMcpToolError(failed).error.code).toBe("invalid_request");
  expect(inspect).toHaveBeenCalledTimes(2);
});

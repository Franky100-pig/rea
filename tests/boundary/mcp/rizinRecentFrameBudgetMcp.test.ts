import { isUtf8 } from "node:buffer";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { registerRizinDebugTools } from "../../../src/server/registerRizinDebugTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { silentLogger } from "../../../src/logger.js";
import { createInjectedProcess } from "../providers/RizinDebugSessionCoverage.fixtures.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "../providers/RizinTestInferiorTty.js";

const RECENT_FRAME_BUDGET_BYTES = 16 * 1024;
const TRUNCATION_LABEL = "[recent frame truncated]";

const test = it.skipIf(process.platform === "win32");

test.each([
  {
    label: "ascii",
    payload: "a".repeat(20_000),
    // 16,384 ASCII bytes fit exactly, then the 24-byte label.
    retainedBytes: RECENT_FRAME_BUDGET_BYTES + TRUNCATION_LABEL.length,
  },
  {
    label: "cjk",
    payload: "雪".repeat(20_000),
    // 5,461 three-byte code points fill 16,383 of the 16,384 budget bytes.
    retainedBytes:
      Math.floor(RECENT_FRAME_BUDGET_BYTES / 3) * 3 + TRUNCATION_LABEL.length,
  },
  {
    label: "astral",
    payload: `${"a".repeat(16_380)}😀${"b".repeat(200)}`,
    // The four-byte code point lands on the budget edge and is kept whole.
    retainedBytes: RECENT_FRAME_BUDGET_BYTES + TRUNCATION_LABEL.length,
  },
])(
  "retains $label recent frames within the UTF-8 byte budget on a code point boundary",
  async ({ payload, retainedBytes }) => {
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        const marker = /!echo (.+)\n/u.exec(text)?.[1];
        if (marker === undefined) return;
        setImmediate(() => control.output(`${payload}\0${marker}\n\0`));
      },
    });
    const manager = createRizinTestManager(
      {},
      { spawnProcess: injected.spawnProcess, frameTimeoutMs: 1000 },
    );
    const server = new McpServer({
      name: "rizin-recent-budget-test",
      version: "1",
    });
    registerRizinDebugTools(
      server,
      manager,
      silentLogger,
      createToolResultDelivery(undefined),
    );
    const client = new Client({
      name: "rizin-recent-budget-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const startReply = await client.callTool({
        name: "start_rizin_debug_session",
        arguments: {
          path: "fixture.bin",
          inferior_tty: await rizinTestInferiorTty(),
        },
      });
      expect(startReply.isError).not.toBe(true);
      const started = toolContract(
        "start_rizin_debug_session",
      ).outputSchema.parse(startReply.structuredContent);
      const commandReply = await client.callTool({
        name: "rizin_debug_command",
        arguments: { session_id: started.session_id, command: "dr" },
      });
      expect(commandReply.isError).not.toBe(true);
      const evidence = toolContract("rizin_debug_command").outputSchema.parse(
        commandReply.structuredContent,
      );
      // The full command result path stays exact regardless of history retention.
      expect(evidence.normalized_result.output).toBe(payload);
      expect(evidence.normalized_result.output_truncated).toBe(false);
      const statusReply = await client.callTool({
        name: "rizin_debug_session_status",
        arguments: { session_id: started.session_id },
      });
      expect(statusReply.isError).not.toBe(true);
      const status = toolContract(
        "rizin_debug_session_status",
      ).outputSchema.parse(statusReply.structuredContent);
      const retained = status.recent_output.find((entry) =>
        entry.endsWith(TRUNCATION_LABEL),
      );
      expect(retained).toBeDefined();
      const prefix = (retained ?? "").slice(0, -TRUNCATION_LABEL.length);
      expect(Buffer.byteLength(prefix, "utf8")).toBeLessThanOrEqual(
        RECENT_FRAME_BUDGET_BYTES,
      );
      // The prefix must not stop mid code point.
      expect(isUtf8(Buffer.from(prefix, "utf8"))).toBe(true);
      expect(Buffer.byteLength(retained ?? "", "utf8")).toBe(retainedBytes);
      expect(status.recent_output_truncated).toBe(true);
      expect(status.output_invalid_utf8).toBe(false);
    } finally {
      injected.control.exit();
      await client.close();
      await server.close();
      await manager.closeAll();
    }
  },
);

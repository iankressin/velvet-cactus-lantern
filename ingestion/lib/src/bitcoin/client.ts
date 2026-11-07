import * as z from "zod";

// A scan took 43s to 96s when measured, so this leaves room for a slow node.
const SCAN_TIMEOUT_MS = 5 * 60_000;

// A reply holds an error or a result. Bitcoin Core may also send the one it does not use as null.
const scanReply = z.union([
  z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
  z.object({
    result: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(true),
        height: z.number().int(),
        unspents: z.array(z.object({ scriptPubKey: z.string(), amount: z.number() })),
      }),
      // An aborted scan.
      z.object({ success: z.literal(false) }),
    ]),
  }),
]);

export type BitcoinClient = ReturnType<typeof createBitcoinClient>;

/** Sends JSON-RPC requests to the Bitcoin node at `url`. */
export function createBitcoinClient(url: string) {
  return {
    /**
     * The unspents in the current UTXO set that pay any of `descriptors`, each with its script
     * as hex and its amount in BTC, and the height the scan read. The node scans the whole set
     * once, however many descriptors it gets.
     */
    async scanTxOutSet(descriptors: readonly string[]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "scantxoutset",
          params: ["start", descriptors],
        }),
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`scantxoutset: HTTP ${response.status}`);
      const reply = scanReply.parse(await response.json());
      if ("error" in reply) throw new Error(`scantxoutset: ${reply.error.message} (code ${reply.error.code})`);
      if (!reply.result.success) throw new Error("scantxoutset: the scan was aborted");
      return { height: reply.result.height, unspents: reply.result.unspents };
    },
  };
}

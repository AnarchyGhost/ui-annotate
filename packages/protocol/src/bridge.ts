import { z } from "zod";
import { SourceInfo } from "./schema.js";

export { BRIDGE } from "./constants.js";

export const BridgeRequest = z.object({
  requestId: z.string().max(64),
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;

export const BridgeResponse = z.object({
  requestId: z.string().max(64),
  source: SourceInfo,
});
export type BridgeResponse = z.infer<typeof BridgeResponse>;

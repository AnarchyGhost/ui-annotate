import { browser } from "wxt/browser";
import type { BackgroundRequest, BackgroundResponse, ResponseMap } from "./messages";

export class BackgroundError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BackgroundError";
  }
}

/** Typed request to the background; rejects with the server error message. */
export async function send<R extends BackgroundRequest>(request: R): Promise<ResponseMap[R["type"]]> {
  const response = (await browser.runtime.sendMessage(request)) as BackgroundResponse<R["type"]> | undefined;
  if (!response) throw new BackgroundError("extension background did not answer");
  if (!response.ok) throw new BackgroundError(response.error, response.status);
  return response.data;
}

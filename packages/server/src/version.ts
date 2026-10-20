export const VERSION = "0.1.0";

/**
 * HTTP API level of the daemon. Raised when routes change; a client that finds an older running
 * daemon (left over from before an update) replaces it. 2: POST /pair. 3: POST /sessions/link
 * and automatic project roots. 4: `dispatch` of an annotation (automatic mode).
 */
export const API_LEVEL = 4;

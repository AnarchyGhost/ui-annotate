/**
 * MAIN ↔ ISOLATED bridge. ISOLATED marks the element with a one-off attribute and
 * dispatches a request; MAIN reads framework internals and answers with a SourceInfo DTO.
 * Both worlds share the DOM, so the element itself never crosses the boundary.
 * Kept free of zod: the MAIN-world bundle imports only this module.
 */
export const BRIDGE = {
  requestEvent: "ui-annotate:resolve-request",
  responseEvent: "ui-annotate:resolve-response",
  readyEvent: "ui-annotate:resolver-ready",
  pingEvent: "ui-annotate:resolver-ping",
  targetAttribute: "data-ui-annotate-target",
} as const;

import { installResolver } from "@ui-annotate/resolver";
import { defineContentScript } from "wxt/utils/define-content-script";

/** MAIN world; injected by the background (activeTab) or registered at document_start for always-on origins. */
export default defineContentScript({
  matches: ["http://localhost/*", "http://127.0.0.1/*"],
  registration: "runtime",
  world: "MAIN",
  runAt: "document_start",
  main() {
    installResolver();
  },
});

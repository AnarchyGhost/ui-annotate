import { defineConfig } from "wxt";

/**
 * Public half of the signing key; it fixes the unpacked Chrome extension ID to
 * pimhfahcdpnkbmflgggigkfdjolgemom, which the server allowlists in `Origin`.
 */
const CHROME_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArxzux1nmOrvcQuOGIV6seYIr/4s8ZgWmDfhsqxgm0KUeDT9hF0rFrCO4cWCeSLuTTy02wgzC8Y4Y1GkXSehb2JEJx0OMyzgBPjlHyLfzSfM8xilIXJNax0dbXhR3f6hz3iZGwh8WT6kcg90nGJxRf1HsbLnbLzOcMROw1+kCMCUtYfeiVYoel7N9XP9fF6Sa8SqoIYhAWL1n+OhsjqfJ64JgsZzxwl8TMJbXJrvE5A8hEuhucad88nJPQZlq/gpOA0vHmscZU7rbXC1+//G3SUaSgucfMYMzVatJWKD5eTdgWeGozwY1VWlt5cBDV2hqyGshq+2mstpOjE/YlalwrQIDAQAB";

export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifest: ({ browser }) => ({
    name: "ui-annotate",
    description: "Annotate elements of a running web app and hand file:line feedback to your coding agent.",
    permissions: ["activeTab", "scripting", "storage"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    optional_host_permissions: ["<all_urls>"],
    action: { default_title: "ui-annotate" },
    // Users rebind these in the browser's shortcut settings (the popup links there).
    // Ctrl+Shift+letters are almost all taken by Chrome, Firefox and GTK (U: Unicode input,
    // V: paste as plain text); F and the digits are free in all three. Chrome allows at most
    // four suggested keys.
    commands: {
      "toggle-overlay": {
        suggested_key: { default: "Ctrl+Shift+F", mac: "Command+Shift+F" },
        description: "Show or hide ui-annotate on the page",
      },
      "toggle-annotate": {
        suggested_key: { default: "Ctrl+Shift+1", mac: "Command+Shift+1" },
        description: "Annotation mode on/off",
      },
      "toggle-markers": {
        suggested_key: { default: "Ctrl+Shift+2", mac: "Command+Shift+2" },
        description: "Show or hide annotation markers",
      },
      "toggle-resolved": {
        suggested_key: { default: "Ctrl+Shift+3", mac: "Command+Shift+3" },
        description: "Show or hide resolved and dismissed annotations",
      },
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            // Everything stays on the machine: the extension talks only to the loopback server.
            gecko: { id: "ui-annotate@local", strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } },
          },
        }
      : { minimum_chrome_version: "116", key: CHROME_KEY }),
  }),
});

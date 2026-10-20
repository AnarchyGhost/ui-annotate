# Demo: Northwind billing page

A small Vue 3 + Vite app to try ui-annotate on, and the source of the README screenshots.
`vite-plugin-vue-inspector` is enabled so annotations carry template lines.

```sh
pnpm --filter example-demo dev     # http://127.0.0.1:5180
```

Things to annotate: the washed-out *Upgrade plan* button, the *Seats* title, the chart without values.

`pnpm screenshots` from the repository root (after `pnpm build`) replays the scenario in Chrome for
Testing against a test daemon and rewrites `docs/images/*.png`.

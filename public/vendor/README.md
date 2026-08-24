Vendored, not a dependency — the UI is offline-capable, so nothing here loads
from a CDN (same rule as `public/fonts`). Served by name from `server.js`.

- `highlight.min.js`, `hljs-github.css`, `hljs-github-dark.css` —
  highlight.js 11.11.1, the stock "common" bundle (36 languages) and its two
  GitHub themes, taken unmodified from
  https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/

To upgrade: re-download those three files at the new version, bump the version
above, and re-run `npm test`.

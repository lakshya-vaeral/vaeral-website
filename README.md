# Vaeral self-hosted rebuild

This repository contains a dependency-free static rebuild of the Framer-origin Vaeral site.

## Deployable output

Use `dist/` as the deploy root for Vercel, Netlify, Cloudflare Pages, or any static host.

Key files:
- `dist/index.html` - app shell, SEO metadata, Google Analytics, header/footer
- `dist/styles.css` - responsive dark/purple visual system
- `dist/app.js` - client-side routing, page content, carousel, mobile nav, newsletter state
- `dist/assets/` - copied local assets from the Framer export
- `dist/_redirects` and `dist/vercel.json` - SPA fallback rules

Physical route folders are also present in `dist/` so direct URLs work on simple static servers that do not support rewrites.

## Local preview

```bash
npm run preview
```

Then open http://127.0.0.1:4173/.

## Verification

```bash
npm run build
```

This performs a JavaScript syntax check for the static router. Browser checks were run against the local preview for homepage, blog routes, case-study routes, utility routes, and mobile nav.

## Notes

A Vite/React source scaffold is present under `src/`, but the production deliverable is the static `dist/` build. Vite build execution was blocked in this sandbox by `esbuild` spawn permissions, so the final deliverable avoids any runtime or build dependency on Vite, React, Framer, or Framer Motion.

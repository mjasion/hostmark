/**
 * Inlined into every page: no stylesheet request, so the first paint needs one round trip. System fonts, one
 * accent colour, no gradients. The custom properties are shared with the SPA (apps/web) so the pages look alike.
 */
export const CSS = `
:root{--hm-bg:#ffffff;--hm-surface:#f6f7f9;--hm-fg:#1b1f24;--hm-muted:#59636e;--hm-line:#dfe3e8;--hm-accent:#2457d6;--hm-accent-hover:#1c46ae;--hm-accent-fg:#ffffff;--hm-radius:8px;--hm-font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--hm-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--hm-width:64rem}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--hm-bg);color:var(--hm-fg);font:16px/1.55 var(--hm-font)}
a{color:var(--hm-accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:var(--hm-width);margin:0 auto;padding:0 1.25rem}
header.site{border-bottom:1px solid var(--hm-line)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;height:3.5rem}
.brand{font-weight:650;font-size:1.0625rem;color:var(--hm-fg)}
.brand:hover{text-decoration:none}
nav.site{display:flex;align-items:center;gap:1.25rem}
nav.site a.plain{color:var(--hm-muted)}
nav.site a.plain:hover{color:var(--hm-fg);text-decoration:none}
.btn{display:inline-block;padding:.5rem 1rem;border-radius:var(--hm-radius);border:1px solid var(--hm-accent);background:var(--hm-accent);color:var(--hm-accent-fg);font-weight:600;line-height:1.4}
.btn:hover{background:var(--hm-accent-hover);border-color:var(--hm-accent-hover);text-decoration:none}
.btn.secondary{background:transparent;color:var(--hm-accent)}
.btn.secondary:hover{background:var(--hm-surface)}
main{padding:3.5rem 0 4rem}
h1{font-size:clamp(2rem,5vw,2.75rem);line-height:1.15;letter-spacing:-.01em;margin:0 0 1rem}
h2{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0 0 1rem}
.lead{font-size:1.125rem;color:var(--hm-muted);max-width:40rem}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
.grid{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));margin-top:3rem}
.card{border:1px solid var(--hm-line);border-radius:var(--hm-radius);padding:1.25rem;background:var(--hm-bg)}
.card p{color:var(--hm-muted);margin:0}
.card ul{margin:.75rem 0 0;padding-left:1.1rem;color:var(--hm-muted)}
.card .price{font-size:1.75rem;font-weight:650;color:var(--hm-fg);margin:.25rem 0 .75rem}
.card .price small{font-size:.9rem;font-weight:400;color:var(--hm-muted)}
.note{background:var(--hm-surface);border:1px solid var(--hm-line);border-radius:var(--hm-radius);padding:.75rem 1rem;color:var(--hm-muted);margin:1.5rem 0 0}
.shot{margin:0;border:1px solid var(--hm-line);border-radius:var(--hm-radius);background:var(--hm-surface);overflow:hidden}
.shot img{display:block;width:100%;height:auto}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:1.25rem 0 0;color:var(--hm-muted)}
dl.meta dt{color:var(--hm-fg);font-weight:600}
dl.meta dd{margin:0}
footer.site{border-top:1px solid var(--hm-line);padding:1.5rem 0;color:var(--hm-muted);font-size:.9rem}
@media (max-width:30rem){nav.site{gap:.75rem}main{padding:2rem 0 3rem}}
`;

/**
 * CSP hash source of `CSS` as the layout renders it, byte for byte (D310). A constant rather than computed at load, so
 * the package needs no crypto API in any runtime and build scripts can read it; `test/pages.test.ts` hashes `CSS` and
 * every `<style>` of every page and fails with the new value when the CSS changes.
 */
export const CSS_HASH = 'sha256-j32VbnCSOf7Lz2RkhmnZxgGNSuXeXyjyU5hgjrvaRiM=';

/** Hash sources of every inline `<style>` a page of this package contains: the prerendered pages and `/f/*`. */
export const STYLE_HASHES: readonly string[] = [CSS_HASH];

/** The custom properties above, for the SPA to match. */
export const CSS_VARIABLES = [
  '--hm-bg',
  '--hm-surface',
  '--hm-fg',
  '--hm-muted',
  '--hm-line',
  '--hm-accent',
  '--hm-accent-hover',
  '--hm-accent-fg',
  '--hm-radius',
  '--hm-font',
  '--hm-mono',
  '--hm-width',
] as const;

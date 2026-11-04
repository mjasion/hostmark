import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { CSS } from './styles';

/** Attributes of the RUM beacon (D18). The values come from the closed lists in `@hostmark/contract`. */
export interface RumAttributes {
  platform: string;
  variant: string;
  topology: string;
  region: string;
}

export interface PageProps {
  title: string;
  description: string;
  rum: RumAttributes;
  /** Extra `<head>` elements such as Open Graph tags. */
  head?: Child;
  children: Child;
}

/** `/rum.js` is built by apps/web and reports Web Vitals to `/api/rum`. */
function RumScript({ rum }: { rum: RumAttributes }) {
  return (
    <script
      type="module"
      src="/rum.js"
      data-rum=""
      data-platform={rum.platform}
      data-variant={rum.variant}
      data-topology={rum.topology}
      data-region={rum.region}
    />
  );
}

/** Wraps a page in the shared shell. Hono escapes every text node and attribute value. */
export function Layout({ title, description, rum, head, children }: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        {/* Built by apps/web from its public/ directory (D301). */}
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {head}
        <style>{raw(CSS)}</style>
      </head>
      <body>
        <header class="site">
          <div class="wrap">
            <a class="brand" href="/">
              hostmark
            </a>
            <nav class="site">
              <a class="plain" href="/pricing">
                Pricing
              </a>
              <a class="plain" href="/login">
                Log in
              </a>
              <a class="btn" href="/signup">
                Sign up
              </a>
            </nav>
          </div>
        </header>
        <main>
          <div class="wrap">{children}</div>
        </main>
        <footer class="site">
          <div class="wrap">hostmark is a reference application for comparing hosting platforms.</div>
        </footer>
        <RumScript rum={rum} />
      </body>
    </html>
  );
}

/** Serialises a page. All components are synchronous, so this never returns a promise. */
export function toDocument(page: Child): string {
  return `<!doctype html>${String(page)}`;
}

import { Layout, type RumAttributes, toDocument } from './layout';

export { CSS, CSS_HASH, CSS_VARIABLES, STYLE_HASHES } from './styles';
export type { RumAttributes };

export function renderLanding(rum: RumAttributes): string {
  return toDocument(
    <Layout
      title="hostmark: share images with a link"
      description="hostmark stores your images, makes thumbnails and gives you a link to share."
      rum={rum}
    >
      <h1>Share images with a link</h1>
      <p class="lead">
        Upload a picture, wait a moment while hostmark makes thumbnails, and send the link to anyone. Your
        files stay private until you decide to make one public.
      </p>
      <div class="actions">
        <a class="btn" href="/signup">
          Create an account
        </a>
        <a class="btn secondary" href="/login">
          Log in
        </a>
      </div>
      <div class="grid">
        <section class="card">
          <h2>Upload</h2>
          <p>
            Drag JPEG, PNG or WebP images into the panel, up to 10 MB each. You see the progress as it
            happens.
          </p>
        </section>
        <section class="card">
          <h2>Thumbnails</h2>
          <p>Every image gets three sizes, so galleries load quickly and the full picture stays sharp.</p>
        </section>
        <section class="card">
          <h2>Share</h2>
          <p>Make an image public and it gets a page of its own, with a preview for chat and social apps.</p>
        </section>
      </div>
      <p class="note">
        hostmark is also a reference application: it exists to compare how hosting platforms run the same
        small product. Files are deleted after seven days.
      </p>
    </Layout>,
  );
}

export function renderPricing(rum: RumAttributes): string {
  const tiers = [
    { name: 'Free', price: '$0', items: ['Upload images', 'Thumbnails', 'Public share links'] },
    { name: 'Plus', price: '$9', items: ['Everything in Free', 'More storage', 'Priority processing'] },
    { name: 'Team', price: '$29', items: ['Everything in Plus', 'Shared galleries', 'Support by email'] },
  ];
  return toDocument(
    <Layout
      title="Pricing: hostmark"
      description="Example pricing tiers for the hostmark benchmark application."
      rum={rum}
    >
      <h1>Pricing</h1>
      <p class="lead">Simple plans for a simple product.</p>
      <p class="note">
        These are example tiers for a benchmark app. Nothing here can be bought, and every account gets the
        same features.
      </p>
      <div class="grid">
        {tiers.map((tier) => (
          <section class="card">
            <h2>{tier.name}</h2>
            <div class="price">
              {tier.price} <small>per month</small>
            </div>
            <a class="btn secondary" href="/signup">
              Get started
            </a>
            <ul>
              {tier.items.map((item) => (
                <li>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Layout>,
  );
}

export interface PublicFile {
  id: string;
  /** Shown as the page title and alt text. Not a file name: the schema stores none. */
  title: string;
  width: number | null;
  height: number | null;
  contentType: string;
  bytes: number | null;
  createdAt: Date;
}

export interface PublicFileUrls {
  /** Absolute URL of this page, or undefined when the origin is not trusted for a cached page (D82). */
  page?: string;
  /** Absolute URL of the largest variant for `og:image`, when the origin is known. */
  ogImage?: string;
  /** Same-origin paths of the variants as `[size, path]`; the largest is shown. */
  variants: [number, string][];
}

const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;

export function renderPublicFile(file: PublicFile, urls: PublicFileUrls, rum: RumAttributes): string {
  const description = `${file.title}, shared with hostmark.`;
  const sorted = [...urls.variants].sort((a, b) => a[0] - b[0]);
  const largest = sorted.at(-1);
  const size = file.width && file.height ? `${file.width} x ${file.height}` : null;
  return toDocument(
    <Layout
      title={`${file.title} | hostmark`}
      description={description}
      rum={rum}
      head={
        <>
          <meta property="og:title" content={file.title} />
          <meta property="og:description" content={description} />
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content="hostmark" />
          {urls.page ? <meta property="og:url" content={urls.page} /> : null}
          {urls.page ? <link rel="canonical" href={urls.page} /> : null}
          {urls.ogImage ? <meta property="og:image" content={urls.ogImage} /> : null}
          <meta name="twitter:card" content={urls.ogImage ? 'summary_large_image' : 'summary'} />
          <meta name="twitter:title" content={file.title} />
          {urls.ogImage ? <meta name="twitter:image" content={urls.ogImage} /> : null}
        </>
      }
    >
      <h1>{file.title}</h1>
      <figure class="shot">
        {largest ? (
          <img
            src={largest[1]}
            alt={file.title}
            width={file.width ?? undefined}
            height={file.height ?? undefined}
            fetchpriority="high"
          />
        ) : null}
      </figure>
      <dl class="meta">
        {size ? (
          <>
            <dt>Size</dt>
            <dd>{size} px</dd>
          </>
        ) : null}
        <dt>Type</dt>
        <dd>{file.contentType}</dd>
        {file.bytes !== null ? (
          <>
            <dt>File size</dt>
            <dd>{formatBytes(file.bytes)}</dd>
          </>
        ) : null}
        <dt>Shared</dt>
        <dd>{file.createdAt.toISOString().slice(0, 10)}</dd>
      </dl>
    </Layout>,
  );
}

/** A plain page for a file that does not exist or is not public, and for errors. */
export function renderMessage(
  heading: string,
  message: string,
  rum: RumAttributes,
  title = `${heading} | hostmark`,
): string {
  return toDocument(
    <Layout title={title} description={message} rum={rum} head={<meta name="robots" content="noindex" />}>
      <h1>{heading}</h1>
      <p class="lead">{message}</p>
      <div class="actions">
        <a class="btn secondary" href="/">
          Back to hostmark
        </a>
      </div>
    </Layout>,
  );
}

export const renderNotFound = (rum: RumAttributes): string =>
  renderMessage('Page not found', 'This image does not exist, or its owner has not made it public.', rum);

export const renderError = (rum: RumAttributes): string =>
  renderMessage('Something went wrong', 'The page could not be shown. Please try again in a moment.', rum);

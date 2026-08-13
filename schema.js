// schema.js — JSON-LD structured data nodes for the Vaeral site.
//
// Answer engines resolve entities before they recommend them, so every node
// here points back at one organisation @id. That turns the site from a set of
// unrelated pages into a single resolvable "Vaeral" entity.
//
// Callers pass in SITE (https://vaeral.com). build.js rewrites apex -> www when
// it writes each page, so the @ids end up on the canonical host.

export const orgId = (site) => `${site}/#organization`;

export function organization(site) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    '@id': orgId(site),
    name: 'Vaeral',
    legalName: 'House of Swing',
    url: `${site}/`,
    // The real logo asset is an SVG. Google's logo rich result expects a raster
    // image (PNG/JPG) — export one and swap this path if that result is wanted.
    logo: `${site}/assets/vaeral-logo.svg`,
    image: `${site}/assets/og-image.png`,
    description:
      'Vaeral is an online reputation management agency that builds brand credibility through Reddit marketing, Quora marketing, AI search visibility, review management, brand search result management and influencer marketing.',
    email: 'contact@vaeral.com',
    telephone: '+91-9104491177',
    foundingDate: '2022',
    founder: { '@type': 'Person', name: 'Mayank Sureka', jobTitle: 'Founder' },
    areaServed: 'Worldwide',
    // City-level only, by owner's decision. The full registered office address
    // exists but is deliberately not published here: this is a proprietorship,
    // so the registered address is personal, and schema gets scraped into
    // third-party directories permanently.
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Guwahati',
      addressRegion: 'Assam',
      addressCountry: 'IN',
    },
    sameAs: [
      'https://www.linkedin.com/company/vaeral/',
      'https://www.instagram.com/vaeral.media_',
    ],
    // Appended to, never reordered or rewritten: these arrays are how an answer engine
    // establishes what Vaeral does, so a service with a live page but no entry here is a
    // service the model has no evidence for.
    knowsAbout: [
      'Online Reputation Management',
      'Reddit Marketing',
      'Quora Marketing',
      'Answer Engine Optimization',
      'Review Management',
      'Wikipedia Page Creation',
      'Brand Search Result Management',
      'Comment Management',
      'App Store Optimization',
      'Influencer Marketing',
    ],
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: 'ORM Services',
      itemListElement: [
        'Reddit Marketing',
        'Quora Marketing',
        'Wikipedia Page Creation',
        'LinkedIn Personal Branding',
        'Review Management',
        'AI Search Visibility',
        'Brand Search Result and Autocomplete Management',
        'Comment Management',
        'App Download and Product Signup Growth',
        'Influencer Marketing',
      ].map((name) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name } })),
    },
  };
}

export function breadcrumbList(trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };
}

export function blogPosting({ site, url, attrs, image }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': `${url}#article`,
    headline: attrs.title,
    description: attrs.description,
    image,
    datePublished: attrs.datePublished,
    dateModified: attrs.dateModified,
    // Credited to the organisation, which is accurate — Vaeral published these.
    // Owner decided against personal bylines (2026-07-27), so this is the final
    // state, not a placeholder. A named Person would be the stronger E-E-A-T
    // signal, but that is a consent decision and it was declined.
    author: { '@id': orgId(site) },
    publisher: { '@id': orgId(site) },
    mainEntityOfPage: url,
    inLanguage: 'en',
  };
}

// Serialises one or more nodes into a single ld+json block for the page head.
// The JSON is NOT HTML-escaped — escaping & to &amp; would corrupt it — so the
// only transform is on '<', which keeps the JSON valid while ensuring the
// serialised string cannot terminate the surrounding element early.
export function renderJsonLd(nodes) {
  const list = [].concat(nodes).filter(Boolean);
  if (!list.length) return '';
  const payload = list.length === 1 ? list[0] : list;
  const json = JSON.stringify(payload, null, 2).replace(/</g, '\\u003c');
  return '<script type="application/ld+json">\n' + json + '\n</script>';
}

// Case studies are client work write-ups, so Article is the honest type. They
// carry no byline for the same reason as blog posts.
// Only ever call this with Q&A pairs that are also rendered visibly on the page.
// FAQPage schema without matching visible copy breaches Google's structured data
// policy and risks a manual action, so build.js feeds both from one frontmatter
// source rather than letting them drift apart.
export function faqPage(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}

export function caseStudyArticle({ site, url, attrs, image, type }) {
  return {
    '@context': 'https://schema.org',
    '@type': type || 'Article',
    '@id': `${url}#article`,
    headline: attrs.title,
    description: attrs.description,
    image,
    datePublished: attrs.datePublished,
    dateModified: attrs.dateModified,
    author: { '@id': orgId(site) },
    publisher: { '@id': orgId(site) },
    mainEntityOfPage: url,
    inLanguage: 'en',
    about: attrs.category || undefined,
  };
}

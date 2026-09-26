// Éléments communs aux deux sites Docusaurus : « API & données » (racine de GitHub Pages)
// et « boîte à outils » (sous /toolbox/). Chaque site a sa propre config
// (docusaurus.config.api.ts, docusaurus.config.toolbox.ts) ; ce module porte ce qui ne
// doit pas diverger : hôte, dépôt, thème de code, pied de page.

import { themes as prismThemes } from 'prism-react-renderer';
import type * as Preset from '@docusaurus/preset-classic';

/** Origin of the GitHub Pages site. */
export const SITE_URL = 'https://qbolliet.github.io';

/** Base path of the "API & Data" site (root of the project Pages site). */
export const API_BASE_URL = '/dashboard-template-api/';

/** Base path of the "Toolbox" site, published under the API site. */
export const TOOLBOX_BASE_URL = `${API_BASE_URL}toolbox/`;

/**
 * Link to a page of the other site. Docusaurus cannot route between the two builds (and a
 * `pathname://` link would get the baseUrl of the current site prepended): the link is an
 * absolute URL, opened as a full page load, and is exempt from the broken-link check. On a
 * local preview it leads to the published site.
 *
 * @param path - Absolute path on the host, baseUrl included.
 * @returns The absolute URL to use in a navbar or footer.
 */
export const crossSiteHref = (path: string): string => `${SITE_URL}${path}`;

/** GitHub repository of the project. */
export const REPO_URL = 'https://github.com/qbolliet/dashboard-template-api';

/** Edit link prefix shared by the doc pages of both sites. */
export const EDIT_URL = `${REPO_URL}/tree/main/docs-site/`;

/** Fields that are identical in the two site configs. */
export const sharedSiteFields = {
  favicon: 'img/favicon.ico',
  url: SITE_URL,
  organizationName: 'qbolliet',
  projectName: 'dashboard-template-api',
  onBrokenLinks: 'throw',
  markdown: {
    // 'detect': .md files parsed as CommonMark (safe for TypeDoc's {variable} patterns),
    // .mdx files parsed as MDX (required for @graphql-markdown JSX components).
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
} as const;

/** Prism code highlighting, identical on both sites. */
export const sharedPrism: Preset.ThemeConfig['prism'] = {
  theme: prismThemes.github,
  darkTheme: prismThemes.dracula,
  additionalLanguages: ['graphql', 'yaml', 'bash', 'json'],
};

/**
 * Builds the footer of a site.
 *
 * @param docsLinks - Links of the "Documentation" column, specific to the site.
 * @returns Footer config, with the GitHub column and the copyright shared.
 */
export function buildFooter(
  docsLinks: { label: string; to?: string; href?: string }[],
): NonNullable<Preset.ThemeConfig['footer']> {
  return {
    style: 'dark',
    links: [
      { title: 'Documentation', items: docsLinks },
      { title: 'More', items: [{ label: 'GitHub', href: REPO_URL }] },
    ],
    copyright: `Copyright © ${new Date().getFullYear()} GraphQL DuckLake API. Built with Docusaurus.`,
  };
}

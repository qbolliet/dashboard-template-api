import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'GraphQL DuckLake API',
  tagline: 'A public, read-only GraphQL API for dashboard analytics on DuckLake databases',
  favicon: 'img/favicon.ico',

  // Update these to match your GitHub Pages deployment
  url: 'https://qbolliet.github.io',
  baseUrl: '/dashboard-template-api/',

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

  // TypeDoc is run as a separate pre-step (npm run docs:typedoc from repo root)
  // and outputs markdown files into docs/code-reference/ before this build.
  // @graphql-markdown/docusaurus generates docs/graphql-api/* from the SDL produced
  // by scripts/generate-schema.mjs.
  plugins: [
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'codeReference',
        path: 'code-reference',
        routeBasePath: 'code-reference',
        sidebarPath: './sidebars-code-reference.ts',
        // Remove TypeDoc module-summary doc items when a same-named category exists
        // at the same level (prevents duplicates like "cache" doc + "cache" folder).
        // Applied recursively so nested levels (e.g. schema/resolvers + schema/resolvers/)
        // are deduplicated too.
        sidebarItemsGenerator: async ({ defaultSidebarItemsGenerator, ...args }) => {
          const items = await defaultSidebarItemsGenerator({ defaultSidebarItemsGenerator, ...args });
          const dedupe = (level) => {
            const categoryLabels = new Set(
              level
                .filter((item) => item.type === 'category' && item.label)
                .map((item) => item.label.toLowerCase())
            );
            return level
              .filter((item) => {
                if (item.type !== 'doc') return true;
                // TypeDoc files have no frontmatter, so item.label may be undefined.
                // Fall back to item.id (last path segment) for matching.
                const id = (item.id ?? '').split('/').pop()?.toLowerCase() ?? '';
                const label = (item.label ?? '').toLowerCase();
                return !categoryLabels.has(id) && !categoryLabels.has(label);
              })
              .map((item) =>
                item.type === 'category' && Array.isArray(item.items)
                  ? { ...item, items: dedupe(item.items) }
                  : item
              );
          };
          return dedupe(items);
        },
      },
    ],
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'graphqlApi',
        path: 'graphql-api',
        routeBasePath: 'graphql-api',
        sidebarPath: './sidebars-graphql.ts',
      },
    ],
    [
      '@graphql-markdown/docusaurus',
      {
        schema: 'static/schema.graphql',
        rootPath: '.',
        baseURL: 'graphql-api',
        homepage: './graphql-api/index.md',
        loaders: {
          GraphQLFileLoader: '@graphql-tools/graphql-file-loader',
        },
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/qbolliet/dashboard-template-api/tree/main/docs-site/',
          routeBasePath: '/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    navbar: {
      title: 'GraphQL DuckLake API',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'codeReference',
          sidebarId: 'codeReference',
          position: 'left',
          label: 'Code Reference',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'graphqlApi',
          sidebarId: 'graphqlApi',
          position: 'left',
          label: 'GraphQL API',
        },
        {
          to: '/schema',
          label: 'Schema Explorer',
          position: 'left',
        },
        {
          href: 'https://github.com/qbolliet/dashboard-template-api',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            { label: 'Getting Started', to: '/getting-started/installation' },
            { label: 'API Guide', to: '/api-guide/overview' },
            { label: 'Configuration', to: '/configuration/overview' },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/qbolliet/dashboard-template-api',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} GraphQL DuckLake API. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['graphql', 'yaml', 'bash', 'json'],
    },
    algolia: undefined,
  } satisfies Preset.ThemeConfig,
};

export default config;

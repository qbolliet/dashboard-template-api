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
    // 'md': all .md files as CommonMark (no JSX expression evaluation)
    // Required because TypeDoc-generated files contain {variable} patterns
    // that MDX would evaluate as JavaScript expressions.
    format: 'md',
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
  plugins: [],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/qbolliet/dashboard-template-api/tree/main/docs-site/',
          routeBasePath: '/',
          // Remove TypeDoc module-summary doc items when a same-named category exists
          // at the same level (prevents duplicates like "cache" doc + "cache" folder).
          sidebarItemsGenerator: async ({ defaultSidebarItemsGenerator, ...args }) => {
            const items = await defaultSidebarItemsGenerator({ defaultSidebarItemsGenerator, ...args });
            const categoryLabels = new Set(
              items
                .filter((item) => item.type === 'category' && item.label)
                .map((item) => item.label.toLowerCase())
            );
            return items.filter((item) => {
              if (item.type !== 'doc' || !item.label) return true;
              return !categoryLabels.has(item.label.toLowerCase());
            });
          },
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

// Site « API & données » — publié à la racine de GitHub Pages (projet-spécifique) :
// guide de l'API, référence GraphQL (graphql-markdown), explorateur Voyager, export REST
// et dictionnaire des données. Build : `npm run docs:build:api` (racine du dépôt).
//
// Les sections générées (graphql-api/, data-dictionary/) sont produites avant le build
// par `npm run docs:graphql` et `npm run docs:dictionary`.

import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {
  API_BASE_URL,
  EDIT_URL,
  REPO_URL,
  TOOLBOX_BASE_URL,
  buildFooter,
  crossSiteHref,
  sharedPrism,
  sharedSiteFields,
} from './site-shared';

const config: Config = {
  ...sharedSiteFields,
  title: 'GraphQL DuckLake API',
  tagline: 'A public, read-only GraphQL API for dashboard analytics on DuckLake databases',
  baseUrl: API_BASE_URL,

  plugins: [
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'dataDictionary',
        path: 'api/data-dictionary',
        routeBasePath: 'data-dictionary',
        sidebarPath: './api/sidebars-data-dictionary.ts',
      },
    ],
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'graphqlApi',
        path: 'api/graphql-api',
        routeBasePath: 'graphql-api',
        sidebarPath: './api/sidebars-graphql.ts',
      },
    ],
    [
      '@graphql-markdown/docusaurus',
      {
        schema: 'static/schema.graphql',
        rootPath: './api',
        baseURL: 'graphql-api',
        // Les liens entre pages sont des chemins de fichiers .mdx résolus depuis la racine du
        // site (siteDir) : le préfixe api/ suit l'emplacement de sortie (rootPath)
        linkRoot: '/api',
        homepage: './api/graphql-api/index.md',
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
          path: 'api/docs',
          sidebarPath: './api/sidebars.ts',
          editUrl: EDIT_URL,
          routeBasePath: '/',
        },
        pages: { path: 'api/pages' },
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
        { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs' },
        {
          type: 'docSidebar',
          docsPluginId: 'dataDictionary',
          sidebarId: 'dataDictionary',
          position: 'left',
          label: 'Data Dictionary',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'graphqlApi',
          sidebarId: 'graphqlApi',
          position: 'left',
          label: 'GraphQL API',
        },
        { to: '/schema', label: 'Schema Explorer', position: 'left' },
        // Autre site : page complète (pas de navigation SPA entre deux builds)
        {
          href: crossSiteHref(TOOLBOX_BASE_URL),
          label: 'Toolbox',
          position: 'left',
          target: '_self',
        },
        { href: REPO_URL, label: 'GitHub', position: 'right' },
      ],
    },
    footer: buildFooter([
      { label: 'API Guide', to: '/api-guide/overview' },
      { label: 'Bulk export (REST)', to: '/api-guide/export' },
      { label: 'TypeScript client', to: '/typescript-client' },
      {
        label: 'Toolbox (setup, deployment, code reference)',
        href: crossSiteHref(TOOLBOX_BASE_URL),
      },
    ]),
    prism: sharedPrism,
    algolia: undefined,
  } satisfies Preset.ThemeConfig,
};

export default config;

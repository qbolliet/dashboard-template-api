import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'intro',
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: [
        'getting-started/installation',
        'getting-started/configuration',
        'getting-started/testing',
        'getting-started/building-the-docs',
      ],
    },
    {
      type: 'category',
      label: 'Deployment',
      collapsed: false,
      items: [
        'deployment/overview',
        'deployment/docker',
        'deployment/kubernetes-helm',
        'deployment/data-refresh',
      ],
    },
    {
      type: 'category',
      label: 'API Guide',
      collapsed: false,
      items: ['api-guide/overview', 'api-guide/queries', 'api-guide/examples'],
    },
    {
      type: 'category',
      label: 'Configuration Reference',
      items: [
        'configuration/overview',
        'configuration/api',
        'configuration/database',
        'configuration/security',
        'configuration/cache',
        'configuration/logging',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/overview',
        'architecture/security',
        'architecture/caching',
        'architecture/data-loading',
      ],
    },
  ],
};

export default sidebars;

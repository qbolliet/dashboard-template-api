import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'intro',
    {
      type: 'category',
      label: 'API Guide',
      collapsed: false,
      items: [
        'api-guide/overview',
        'api-guide/queries',
        'api-guide/examples',
        'api-guide/export',
        'typescript-client',
      ],
    },
  ],
};

export default sidebars;

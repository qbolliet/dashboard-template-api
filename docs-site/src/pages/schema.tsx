import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// VoyagerLoader is rendered only in the browser (inside BrowserOnly),
// so it is safe to call require() and use browser APIs here.
function VoyagerLoader({ schemaUrl }: { schemaUrl: string }): JSX.Element {
  const [error, setError] = React.useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Voyager } = require('graphql-voyager');

  async function introspectionProvider(_query: string) {
    const res = await fetch(schemaUrl);
    if (!res.ok) {
      const msg = `schema.json not found (HTTP ${res.status}) — run \`npm run build && npm run docs:schema\` from the repo root, then restart the docs server.`;
      setError(msg);
      throw new Error(msg);
    }
    return res.json();
  }

  if (error) {
    return (
      <div style={{ padding: '2rem', color: '#c00', fontFamily: 'monospace', fontSize: '0.9rem' }}>
        ⚠️ {error}
      </div>
    );
  }

  return (
    <Voyager
      introspection={introspectionProvider}
      displayOptions={{ skipRelay: false, skipDeprecated: false }}
    />
  );
}

export default function SchemaPage(): JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  const schemaUrl = `${siteConfig.baseUrl}schema.json`;

  return (
    <Layout
      title="Schema Explorer"
      description="Interactive GraphQL schema explorer powered by GraphQL Voyager"
      noFooter
    >
      <div
        style={{
          height: 'calc(100vh - var(--ifm-navbar-height))',
          overflow: 'hidden',
        }}
      >
        <BrowserOnly
          fallback={
            <div style={{ padding: '2rem', textAlign: 'center' }}>
              <p>Loading Schema Explorer…</p>
            </div>
          }
        >
          {() => {
            // CSS import inside BrowserOnly avoids SSR issues with Voyager styles
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('graphql-voyager/dist/voyager.css');
            return <VoyagerLoader schemaUrl={schemaUrl} />;
          }}
        </BrowserOnly>
      </div>
    </Layout>
  );
}

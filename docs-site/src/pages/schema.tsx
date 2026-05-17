import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// Fetch the introspection JSON once and pass the resulting object to Voyager.
// Passing a fresh provider function on every render makes Voyager v2 re-trigger
// introspection on each cycle and stay stuck on "Transmitting…" under React 18.
function VoyagerLoader({ schemaUrl }: { schemaUrl: string }): JSX.Element {
  const [introspection, setIntrospection] = React.useState<unknown>(null);
  const [error, setError] = React.useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Voyager } = require('graphql-voyager');

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(schemaUrl);
        if (!res.ok) {
          throw new Error(
            `schema.json not found (HTTP ${res.status}) — run \`npm run build && npm run docs:schema\` from the repo root, then restart the docs server.`,
          );
        }
        const data = await res.json();
        if (!cancelled) setIntrospection(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schemaUrl]);

  if (error) {
    return (
      <div style={{ padding: '2rem', color: '#c00', fontFamily: 'monospace', fontSize: '0.9rem' }}>
        ⚠️ {error}
      </div>
    );
  }

  if (!introspection) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p>Chargement du schéma…</p>
      </div>
    );
  }

  return (
    <Voyager
      introspection={introspection}
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

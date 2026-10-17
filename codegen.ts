import type { CodegenConfig } from '@graphql-codegen/cli';

// Génération des types TypeScript des resolvers depuis le SDL versionné (schema.graphql).
// Le fichier produit est suivi par git : le Dockerfile ne copie que src/ et n'a pas d'étape
// codegen. Vérifié à jour par `npm run codegen:check` (CI).
const config: CodegenConfig = {
  schema: 'schema.graphql',
  generates: {
    'src/generated/graphql.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
      config: {
        // Contexte Apollo injecté dans chaque resolver
        contextType: '../schema/resolvers/types.js#GraphQLContext',
        // Le scalaire JSON porte des valeurs sérialisées (nombres, chaînes, objets, tableaux)
        scalars: { JSON: 'unknown' },
        // Le parent d'un Metadata est la ligne camelCase du loader (`stats` est résolu à part)
        mappers: { Metadata: '../utils/metadata-mapping.js#FieldMetadata' },
        enumsAsTypes: true,
        useTypeImports: true,
        maybeValue: 'T | null',
        inputMaybeValue: 'T | null | undefined',
        skipTypename: true,
      },
    },
  },
};

export default config;

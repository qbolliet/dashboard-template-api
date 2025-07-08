# Guide complet pour tester l'API GraphQL DuckDB

## 🚀 Démarrage rapide

### 1. Installation des dépendances
```bash
# Installer les dépendances de l'API
npm install

# Installer les dépendances de test
npm install --save-dev jest @jest/globals graphql-request chalk
```

### 2. Configuration de la base de données de test
```bash
# Créer et remplir la base de données avec des données de test
node tests/setup-test-data.js
```

### 3. Démarrer l'API
```bash
# Dans un terminal
npm start
# L'API sera disponible sur http://localhost:4000/graphql
```

## 🧪 Méthodes de test

### Option 1: Validation automatique complète
```bash
# Dans un autre terminal (l'API doit être démarrée)
node tests/validate-api.js
```
Ce script vérifie automatiquement :
- ✅ La connexion à la base de données
- ✅ Toutes les tables et leurs données
- ✅ Toutes les requêtes GraphQL
- ✅ Les performances
- ✅ La sécurité

### Option 2: Tests unitaires avec Jest
```bash
# Exécuter tous les tests unitaires
npm test

# Ou avec coverage
npm run test:coverage

# Ou en mode watch
npm run test:watch
```

### Option 3: Tests avec Apollo Studio (Interface graphique)

1. Ouvrir [Apollo Studio](https://studio.apollographql.com)
2. Connecter à `http://localhost:4000/graphql`
3. Copier-coller les requêtes depuis `graphql-test-queries.graphql`
4. Exécuter les requêtes une par une

### Option 4: Tests manuels avec script
```bash
# Test manuel basique
node tests/manual-test.js

# Test de charge
node tests/stress-test.js
```

## 📋 Checklist de validation

### Base de données
- [ ] La base de données existe et est accessible
- [ ] Toutes les tables sont créées (metadata, fact_table, dim_*)
- [ ] Les tables contiennent des données

### Métadonnées
- [ ] `getMetaData` retourne les infos pour tous les champs
- [ ] Les champs catégoriels sont correctement marqués
- [ ] Les types SQL correspondent aux types Python

### Dimensions
- [ ] `getDimensionTable` retourne des données pour toutes les dimensions
- [ ] Les dimensions ont des valeurs et des labels
- [ ] Les labels sont différents des valeurs

### Table des faits
- [ ] `getFactTable` retourne des données
- [ ] La pagination fonctionne (limit, offset)
- [ ] Les filtres simples fonctionnent
- [ ] Les filtres structurés fonctionnent
- [ ] Le tri fonctionne
- [ ] `dimensionDetails` résout correctement les labels

### Agrégations
- [ ] Toutes les fonctions d'agrégation fonctionnent (SUM, AVG, MAX, MIN, COUNT)
- [ ] `groupBy` fonctionne sur tous les champs
- [ ] Les filtres s'appliquent aux agrégations
- [ ] `keyLabel` résout les labels pour les clés catégorielles
- [ ] Les métadonnées incluent les statistiques

### Options de sélection
- [ ] `getSelectOptions` retourne les options pour tous les champs
- [ ] La recherche fonctionne avec `searchTerm`
- [ ] Les options groupées fonctionnent

### Sécurité
- [ ] Les limites sont respectées (max 1000)
- [ ] Les offsets sont limités (max 10000)
- [ ] La profondeur des requêtes est limitée
- [ ] Les requêtes malveillantes sont rejetées

### Performance
- [ ] Les requêtes simples s'exécutent en < 100ms
- [ ] Les requêtes complexes s'exécutent en < 1s
- [ ] Le cache Redis fonctionne
- [ ] L'API supporte au moins 100 req/s

## 🐛 Débogage

### L'API ne démarre pas
```bash
# Vérifier les logs
LOG_LEVEL=debug npm start

# Vérifier la configuration
cat config/*.yaml

# Vérifier la base de données
ls -la outputs/database.db
```

### Les tests échouent
```bash
# Réinitialiser la base de données
rm outputs/database.db
node tests/setup-test-data.js

# Vérifier Redis
redis-cli ping

# Exécuter un test spécifique
npm test -- --testNamePattern="Metadata"
```

### Problèmes de performance
```bash
# Activer le profiling
NODE_ENV=development LOG_LEVEL=debug npm start

# Vérifier les index de la base
# Dans DuckDB : PRAGMA table_info(fact_table);
```

## 📊 Exemples de requêtes utiles

### Requête de santé
```graphql
query HealthCheck {
  __typename
}
```

### Requête complète de test
```graphql
query CompleteTest {
  # Métadonnées
  meta: getMetaData(name: "country") {
    name
    label
    is_categorical
  }
  
  # Dimension
  countries: getDimensionTable(name: "country") {
    value
    label
  }
  
  # Faits avec détails
  facts: getFactTable(limit: 5) {
    data {
      value
      dimensionDetails {
        name
        label
      }
    }
    total
  }
  
  # Agrégation
  aggregated: getAggregatedFacts(
    groupBy: "country"
    aggregation: AVG
  ) {
    keyLabel
    aggregatedValue
  }
}
```

## 🎯 Critères de succès

L'API est considérée comme fonctionnelle si :
1. ✅ Tous les tests Jest passent
2. ✅ Le script de validation ne montre aucune erreur
3. ✅ Les requêtes dans Apollo Studio fonctionnent
4. ✅ Les performances sont acceptables (< 1s pour requêtes complexes)
5. ✅ Aucune erreur de sécurité n'est détectée

## 📚 Ressources

- [Documentation GraphQL](https://graphql.org/learn/)
- [Apollo Studio](https://studio.apollographql.com)
- [DuckDB Documentation](https://duckdb.org/docs/)
- [Jest Documentation](https://jestjs.io/docs/getting-started)
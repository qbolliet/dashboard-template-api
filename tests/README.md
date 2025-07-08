# Guide de test de l'API GraphQL DuckDB

## Installation des dépendances de test

```bash
npm install --save-dev jest @jest/globals graphql-request
```

## Exécution des tests

### 1. Configuration des données de test
```bash
npm run test:setup
```

### 2. Tests unitaires avec Jest
```bash
# Tous les tests
npm test

# Tests en mode watch
npm run test:watch

# Tests avec coverage
npm run test:coverage
```

### 3. Tests manuels
```bash
# Démarrer l'API
npm start

# Dans un autre terminal, exécuter les tests manuels
node tests/manual-test.js
```

### 4. Tests de charge
```bash
# S'assurer que l'API est démarrée
node tests/stress-test.js
```

### 5. Tests avec Apollo Studio

1. Démarrer l'API : `npm start`
2. Ouvrir https://studio.apollographql.com
3. Se connecter à `http://localhost:4000/graphql`
4. Utiliser les requêtes du fichier `graphql-test-queries.graphql`

## Structure des tests

- `setup-test-data.js` : Insère des données de test dans la base
- `api.test.js` : Tests unitaires Jest
- `manual-test.js` : Tests manuels avec graphql-request
- `stress-test.js` : Tests de performance
- `graphql-test-queries.graphql` : Requêtes pour Apollo Studio

## Vérifications importantes

1. **Métadonnées** : Vérifier que tous les champs ont leurs métadonnées
2. **Dimensions** : Vérifier que les labels sont correctement résolus
3. **Pagination** : Tester les limites et offsets
4. **Filtres** : Tester les filtres simples et structurés
5. **Agrégations** : Tester toutes les fonctions (SUM, AVG, MAX, MIN, COUNT)
6. **Performance** : Vérifier les temps de réponse
7. **Sécurité** : Tester les limites de profondeur et de complexité
8. **Cache** : Vérifier que le cache Redis fonctionne

## Debugging

Pour activer les logs détaillés pendant les tests :
```bash
LOG_LEVEL=debug npm test
```
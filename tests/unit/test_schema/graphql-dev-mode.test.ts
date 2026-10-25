/**
 * Tests that the suite runs GraphQL.js 17 in development mode.
 *
 * The `development` export condition (jest.config.js) loads the __dev__ build,
 * whose checks reject a second graphql instance: the override forcing
 * @apollo/server onto graphql 17 must keep a single one.
 */

import { describe, test, expect } from '@jest/globals';
import { isDevModeEnabled } from 'graphql';
import { schema } from '../../../src/schema/index.js';

describe('GraphQL.js development mode', () => {
  test('is enabled in the test suite', () => {
    expect(isDevModeEnabled()).toBe(true);
  });

  test('builds the executable schema with a single graphql instance', () => {
    expect(schema.getQueryType()?.name).toBe('Query');
  });
});

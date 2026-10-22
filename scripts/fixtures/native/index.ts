import { optionsFrom, runFixtures } from './fixtures.js';
import { FixtureFailure } from './network.js';

try {
  process.exitCode = await runFixtures(optionsFrom(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof FixtureFailure ? error.message : 'Fixture operation failed');
  process.exitCode = 1;
}

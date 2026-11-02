/**
 * Minimal dependency-free test runner for the unit tests.
 *
 * The project deliberately has no test framework (see AGENTS.md §3): tests are
 * plain Node scripts compiled by `tsconfig.test.json` and executed by
 * `npm test`. This harness only adds named cases, compact progress output and
 * readable failure reports so a regression points straight at the assertion.
 *
 * Usage:
 *   import { describe, test, run } from './harness';
 *   describe('thing', () => { test('does the thing', () => assert.equal(1, 1)); });
 *   void run();
 */

type TestCase = { name: string; fn: () => void | Promise<void> };

const cases: TestCase[] = [];
let prefix = '';

/** Groups case names under a common label. Callbacks run synchronously. */
export function describe(name: string, fn: () => void): void {
  const previous = prefix;
  prefix = previous ? `${previous} > ${name}` : name;
  try {
    fn();
  } finally {
    prefix = previous;
  }
}

/** Registers a case. `fn` may be async; cases run in registration order. */
export function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name: prefix ? `${prefix} > ${name}` : name, fn });
}

/**
 * Runs every registered case and exits the process with a non-zero code when
 * anything failed. Exits explicitly (rather than returning) so a stray timer
 * left behind by the code under test can never hang `npm test`.
 */
export async function run(): Promise<void> {
  let passed = 0;
  const failures: Array<{ name: string; error: unknown }> = [];

  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      process.stdout.write('.');
    } catch (error) {
      failures.push({ name: c.name, error });
      process.stdout.write('X');
    }
  }

  process.stdout.write('\n');
  if (failures.length === 0) {
    console.log(`All ${passed} cases passed.`);
    process.exit(0);
  }

  console.log(`\n${failures.length} of ${cases.length} cases FAILED:\n`);
  for (const f of failures) {
    console.log(`--- ${f.name}`);
    const error = f.error;
    if (error instanceof Error) {
      console.log(`    ${error.message.split('\n').join('\n    ')}`);
      // First frame inside src/ or test/ is the useful one.
      const frame = (error.stack ?? '')
        .split('\n')
        .find((l) => /out-test[/\\](src|test)[/\\]/.test(l));
      if (frame) {
        console.log(`    at ${frame.trim().replace(/^at\s+/, '')}`);
      }
    } else {
      console.log(`    ${String(error)}`);
    }
    console.log('');
  }
  process.exit(1);
}

#!/usr/bin/env node

/**
 * AutoResearch Evaluation Harness
 *
 * Runs build + tests + coverage and outputs a JSON metrics object.
 * Usage: node scripts/autoresearch/evaluate.mjs [--quick]
 *
 * --quick: skip build, only run tests + coverage
 */

import { execSync } from "child_process";

const isQuick = process.argv.includes("--quick");

function run(cmd, label) {
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });
    return { success: true, output };
  } catch (err) {
    return { success: false, output: err.stdout || err.stderr || err.message };
  }
}

function parseCoverage(output) {
  // Parse the V8 coverage text table for "All files" line
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.includes("All files")) {
      const nums = line.match(/[\d.]+/g);
      if (nums && nums.length >= 4) {
        return {
          statements: parseFloat(nums[0]),
          branches: parseFloat(nums[1]),
          functions: parseFloat(nums[2]),
          lines: parseFloat(nums[3]),
        };
      }
    }
  }
  return { statements: 0, branches: 0, functions: 0, lines: 0 };
}

const results = {
  timestamp: new Date().toISOString(),
  build: { success: true, skipped: isQuick },
  tests: { success: false, total: 0, passed: 0, failed: 0 },
  coverage: { statements: 0, branches: 0, functions: 0, lines: 0 },
};

// Step 1: Build (unless --quick)
if (!isQuick) {
  console.error("[evaluate] Running build...");
  const buildResult = run("npm run build", "build");
  results.build.success = buildResult.success;
  if (!buildResult.success) {
    console.error("[evaluate] Build FAILED");
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }
}

// Step 2: Tests with coverage
console.error("[evaluate] Running tests with coverage...");
const testResult = run("npx vitest run --coverage --reporter=verbose", "test");
results.tests.success = testResult.success;

// Parse test counts from output
const testCountMatch = testResult.output.match(
  /Tests\s+(\d+)\s+passed\s*(?:\|\s*(\d+)\s+failed)?/i
);
if (testCountMatch) {
  results.tests.passed = parseInt(testCountMatch[1], 10);
  results.tests.failed = testCountMatch[2] ? parseInt(testCountMatch[2], 10) : 0;
  results.tests.total = results.tests.passed + results.tests.failed;
} else {
  // Alternative pattern: "X tests passed" or check for vitest summary
  const altMatch = testResult.output.match(/(\d+)\s+test[s]?\s+(passed|completed)/i);
  if (altMatch) {
    results.tests.passed = parseInt(altMatch[1], 10);
    results.tests.total = results.tests.passed;
  }
}

// Parse coverage
results.coverage = parseCoverage(testResult.output);

// Output results
console.log(JSON.stringify(results, null, 2));

if (!results.tests.success) {
  process.exit(1);
}

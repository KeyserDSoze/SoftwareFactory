/** Pure, fail-closed gate for the network-isolated fullstack Playwright run.
 * Count tests in the GENERATED fixture, not a stale number in the wrapper.
 * Only top-level test("...") declarations are counted; test.skip/only and
 * unexecuted scenarios cannot silently increase a passing receipt.
 */
export function verifyFullstackPlaywrightOutcome(spec, outcome) {
  if (typeof spec !== "string" || spec.length > 1_000_000)
    throw Error("Invalid generated fullstack Playwright specification");
  const declared = (spec.match(/^test\("/gm) || []).length;
  if (declared < 1 || declared > 80)
    throw Error("Invalid declared fullstack Playwright test count");
  const output = outcome?.stdout;
  if (outcome?.state !== "passed" || outcome.exitCode !== 0 ||
      outcome.timedOut !== false || typeof output !== "string")
    throw Error("Fullstack Playwright execution was not a verified pass");
  // The summary must be exact, anchored at start of line and end of its
  // parenthesized duration. 118 passed must not satisfy 18 passed.
  const summary = new RegExp("(?:^|\\n)\\s*" + declared +
    " passed \\([^\\r\\n]{1,80}\\)(?:\\r?\\n|$)");
  if (!summary.test(output) ||
      /(?:^|\n)\s*\d+ (?:failed|skipped|flaky|interrupted)\b/i.test(output))
    throw Error("Fullstack Playwright did not pass every declared test");
  return declared;
}

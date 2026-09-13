import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

/**
 * The release workflow must run the same gates as CI — or a stronger one.
 *
 * Why this exists: `release.yml` said "Same gates as CI: a release must never be
 * the first place a broken build is discovered", and then ran `npm test` while CI
 * ran `npm run test:coverage`. The per-file branch thresholds in
 * `vitest.config.ts` only apply when coverage runs (`ci.yml` says so in a comment
 * on its own step), so the coverage ratchet — the thing that stops a commit from
 * deleting coverage in the three modules whose bugs silently corrupt user data —
 * simply did not exist on the release path. It was found by reading both files
 * side by side; nothing could fail.
 *
 * That is the same shape as rule 27's missing template import and rule 33's
 * undocumented exports: a hand-maintained list, a claim in a comment, and no
 * signal when the two diverge. Two hand-written gate lists is one list too many,
 * so this test is the signal.
 *
 * Deliberately mechanical: it compares which npm SCRIPTS each workflow invokes,
 * not the prose around them. Review is for prose.
 *
 * The scripts below are derived from each file's own `run:` lines rather than
 * hardcoded, so adding a gate to CI and forgetting release fails here instead of
 * passing because this list went stale too.
 */

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** Every `run:` command value in a workflow file. */
function runCommands(file: string): string[] {
  return [...read(file).matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());
}

/**
 * The npm scripts a workflow invokes.
 *
 * Filtered against `package.json`'s declared scripts, which is what keeps `npm ci`
 * (not a script) out without a denylist to maintain, and means a typo'd script
 * name is simply invisible here rather than counted as a gate that ran.
 */
function npmScripts(file: string): Set<string> {
  const declared = new Set(Object.keys(JSON.parse(read('package.json')).scripts ?? {}));
  const found = new Set<string>();
  for (const command of runCommands(file)) {
    for (const [, name] of command.matchAll(/\bnpm (?:run )?([\w:-]+)/g)) {
      if (declared.has(name)) found.add(name);
    }
  }
  return found;
}

/**
 * For each CI gate, the release steps that satisfy it.
 *
 * A named mapping rather than a blanket "must be equal": the release path
 * legitimately differs in two measured ways, and both must be *stated* so a new
 * difference is a failure rather than a silent pass.
 */
const SATISFIED_BY: Readonly<Record<string, readonly string[]>> = {
  // `test:coverage` is the real gate — `test` skips the thresholds entirely
  // (vitest.config.ts applies them only under coverage). One direction only.
  'test:coverage': ['test:coverage'],
  // `wxt zip` builds as well as packages — measured 2026-09-13 by deleting
  // `.output/` and confirming `npm run zip` recreated `.output/chrome-mv3`.
  build: ['build', 'zip'],
};

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';

describe('release runs the same gates as CI', () => {
  it('the workflow shapes really parsed', () => {
    // Without this, a change to how commands are written would make every check
    // below pass by finding nothing at all.
    expect(runCommands(CI).length, `no run: commands parsed from ${CI}`).toBeGreaterThan(3);
    expect(runCommands(RELEASE).length, `no run: commands parsed from ${RELEASE}`).toBeGreaterThan(3);
    expect(npmScripts(CI).size, `no npm scripts parsed from ${CI}`).toBeGreaterThan(3);
    expect(npmScripts(RELEASE).size, `no npm scripts parsed from ${RELEASE}`).toBeGreaterThan(2);
  });

  it('covers every script CI runs, with an equal or stronger one', () => {
    const release = npmScripts(RELEASE);
    const unsatisfied = [...npmScripts(CI)].filter((gate) => {
      const satisfies = SATISFIED_BY[gate] ?? [gate];
      return !satisfies.some((candidate) => release.has(candidate));
    });
    expect(
      unsatisfied,
      `${RELEASE} does not run: ${unsatisfied.join(', ')}\n` +
        `CI runs ${[...npmScripts(CI)].join(', ')}; ${RELEASE} runs ${[...release].join(', ')}.\n` +
        'A release must never be the first place a broken build is discovered — add the step, ' +
        'or add a SATISFIED_BY entry saying which release step is at least as strong, and why.',
    ).toEqual([]);
  });

  it('each workflow is valid YAML with a real step list', () => {
    // A malformed workflow is worse than a missing gate: GitHub reports a run
    // with no steps at all, so it surfaces during a release. Parsing is the only
    // honest check — a hand-rolled structural scan does not catch bad
    // indentation (verified: breaking one `run:`'s indent parses as invalid YAML
    // while every regex-shaped assertion still passes). `js-yaml` is a DECLARED
    // devDependency for exactly this reason; leaning on a transitive one would be
    // its own defect (rule 21).
    for (const file of [CI, RELEASE]) {
      let doc: { jobs?: Record<string, { steps?: unknown[] }> };
      try {
        doc = yaml.load(read(file)) as typeof doc;
      } catch (err) {
        throw new Error(`${file} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
      }
      const jobs = Object.entries(doc?.jobs ?? {});
      expect(jobs.length, `${file} declares no jobs`).toBeGreaterThan(0);
      for (const [jobName, job] of jobs) {
        const steps = job?.steps;
        expect(Array.isArray(steps), `${file}: job "${jobName}" has no steps list`).toBe(true);
        expect((steps as unknown[]).length, `${file}: job "${jobName}" has too few steps`).toBeGreaterThan(3);
        // Every step must actually do something; a step with neither `run` nor
        // `uses` is a placeholder that silently checks nothing.
        const idle = (steps as Array<{ name?: string; run?: unknown; uses?: unknown }>).filter(
          (s) => typeof s?.run !== 'string' && typeof s?.uses !== 'string',
        );
        expect(idle.map((s) => s?.name ?? '(unnamed)'), `${file}: job "${jobName}" has inert steps`).toEqual([]);
      }
    }
  });

  it('runs the extension E2E gate the same way', () => {
    // The gate needs a display and its screen size has been a real defect before
    // (`xvfb-run` defaults to 1280x1024, narrower than the 1440x900 window, so
    // clicks near the window edge are dropped). Comparing the invocation rather
    // than re-deriving it is the point: one recipe, two callers.
    const gateLines = (file: string) => runCommands(file).filter((c) => c.includes('release-gate.mjs'));
    expect(gateLines(CI), `${CI} does not invoke the E2E gate`).toHaveLength(1);
    expect(
      gateLines(RELEASE),
      'the E2E gate invocation differs between CI and release — one of them was edited alone',
    ).toEqual(gateLines(CI));
  });
});

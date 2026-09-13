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

/**
 * A release must have a body, and the body must be reviewable before the tag
 * exists.
 *
 * The first release shipped with a one-line body (「Full Changelog」 + a commits
 * URL) because `--generate-notes` had no earlier tag to diff against. The first
 * attempt at a fix used `--notes-from-tag` — which reads the tag message, and
 * `npm version` (the release command in the workflow header) writes only the
 * version number there, so the body would have read 「1.1.0」. Both were only
 * visible by looking at a published release page.
 *
 * The body is now a file, checked before the build. These tests keep the two
 * halves honest: the file must exist for the version about to be released, and
 * the workflow must actually read it — otherwise the check passes while the
 * release page stays empty.
 */
describe('every release has a body', () => {
  const workflow = read(RELEASE);

  it('the shipping version has release notes that say something', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    const path = `docs/releases/v${version}.md`;
    let text: string;
    try {
      text = read(path);
    } catch {
      throw new Error(
        `${path} is missing. A release for ${version} would publish an empty page — write the notes, ` +
          'commit them, THEN run the version bump (PUBLISHING.md §5.1.1).',
      );
    }
    // Not a length limit for its own sake: it is the floor below which a file
    // exists but carries no information, which is the failure being prevented.
    expect(
      text.replace(/\s/g, '').length,
      `${path} exists but says nothing — a stub passes an existence check and still ships a blank page`,
    ).toBeGreaterThan(200);
  });

  it('the workflow publishes that file, not a stub of its own', () => {
    // The existence check above is only worth having if the publish step consumes
    // the same directory. Asserting the wiring here is the guard on the guard: a
    // step that verifies `docs/releases/` while `gh release create` still asks
    // GitHub to invent a body would pass every other check in this file.
    expect(
      /--notes-file\s+"?docs\/releases\//.test(workflow),
      `${RELEASE} does not pass docs/releases/<tag>.md to \`gh release create\` — the body would come ` +
        'from a flag again, and this file\'s existence check would be decorative',
    ).toBe(true);
  });
});

/**
 * The publish step's reads must not be able to kill it.
 *
 * GitHub runs a `run:` block as `bash -e`, and `-e` exits on ANY failing command
 * — including a command substitution in an assignment. The step is a retry loop
 * whose whole purpose is to tolerate a transient 5xx on `gh api`, so a probe that
 * is not guarded makes the loop unreachable: the first failure ends the step.
 *
 * This shipped, and its signature is worth recognising. On the v1.0.1 release the
 * release WAS created, the asset WAS attached and the tag WAS published — and the
 * step still exited 1 with no `::error::` line and no completion line, because it
 * died at a probe after `sleep 5`. A red X on a successful release is worse than a
 * failure, because the next person re-runs it or hand-publishes.
 *
 * The check is deliberately narrow: `|| true` on the reads that carry output, not
 * a blanket ban on failing commands anywhere in the file.
 */
describe('the publish step survives a failed read', () => {
  const workflow = read(RELEASE);

  /** The body of the `Publish GitHub release` step. */
  const publishStep = (() => {
    const start = workflow.indexOf('Publish GitHub release');
    expect(start, `${RELEASE} has no Publish GitHub release step`).toBeGreaterThan(-1);
    return workflow.slice(start);
  })();

  it.each([
    // The helper name, and the shape of its closing line, which is what carries
    // the guard. Anchoring on the helper keeps this readable; anchoring on the
    // exact line keeps it honest (a lone `|| true` elsewhere would not satisfy it).
    ['target_id'],
    ['published_id'],
  ])('%s tolerates a failed read', (helper) => {
    // Match the helper's body up to the next helper definition or the end of the
    // `bash -e` block — not up to a line starting with `}`: the closing brace is
    // YAML-indented, so an anchored `\n}` never matches and the test would fail
    // for a reason that has nothing to do with the guard.
    const body = publishStep.match(
      new RegExp(`${helper}\\(\\) \\{([\\s\\S]*?)\\n\\s*(?=(?:\\w+\\(\\) \\{|asset_names|ok=0))`),
    )?.[1];
    expect(body, `${helper} not found in the publish step`).toBeTruthy();
    expect(
      /2>\/dev\/null[^\n]*\|\| true/.test(body as string),
      `${helper} has no \`|| true\`. The runner executes this step as \`bash -e\`, so one transient ` +
        '5xx on this read exits the step before the retry loop can retry — a red X on a release that ' +
        'actually published (measured on v1.0.1; reproduced under `bash -e` with a stub gh).',
    ).toBe(true);
  });

  it('the final read cannot fail the step after it has published', () => {
    // Found by reading the step after fixing the two helpers: the last `gh api`
    // was unguarded too. It is the worst place for the bug, because "ok=1" means
    // the release is already live — a failure here turns a completed release into
    // a red X, and an empty `published_id` would build a URL ending in
    // `/releases/` that 404s.
    const lines = publishStep.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    const last = lines[lines.length - 1];
    expect(last, 'the publish step is empty').toBeTruthy();
    expect(
      last.includes('|| true'),
      `the publish step ends with an unguarded command:\n  ${last.trim()}\n` +
        'A failure there exits 1 after the release is public.',
    ).toBe(true);
  });
});

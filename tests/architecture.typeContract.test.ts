import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Public contract modules must be documented in their `ARCHITECTURE.md` section.
 *
 * Why this exists: `ARCHITECTURE.md` §4 calls itself 当前事实与契约 — the current
 * facts and contracts — and the repo's rule is that a public interface change
 * updates it in the SAME commit. That rule was stated and then broken: the
 * 2026-09-12 deletion-domain rework added `KnownPlatform`, `isKnownPlatform`,
 * `KNOWN_PLATFORMS`, `NameSource`, `FetchResult.degraded`, the `storage` code and
 * more, and left §4.1/§4.2 untouched. It was found later, by a human reading
 * both sides — nothing could fail.
 *
 * A rule nothing can fail on gets broken again. This test is the failure signal.
 *
 * Deliberately mechanical: it checks the symbol is NAMED in the section, not
 * that the prose is good. Prose is what review is for; what a machine can hold
 * is "the name exists". The cost is one paragraph per new export, which is the
 * intended cost.
 */

/** file → the ARCHITECTURE.md section heading whose body must mention its exports. */
const CONTRACT_MODULES: ReadonlyArray<{ file: string; section: string; until: string }> = [
  { file: 'src/types/index.ts', section: '### 4.1', until: '### 4.2' },
  { file: 'src/adapters/types.ts', section: '### 4.2', until: '### 4.3' },
];

function doc(): string {
  return readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
}

/** The body of a section, from its heading up to the next one. */
function sectionBody(section: string, until: string): string {
  const text = doc();
  const start = text.indexOf(section);
  const end = text.indexOf(until);
  expect(start, `ARCHITECTURE.md has no "${section}" heading`).toBeGreaterThan(-1);
  expect(end, `ARCHITECTURE.md has no "${until}" heading`).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** Exported symbol names, by declaration form. */
function exportedSymbols(file: string): string[] {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  return [...src.matchAll(/^export (?:type|interface|const|function|enum) (\w+)/gm)].map((m) => m[1]);
}

describe('ARCHITECTURE §4 documents every public contract export', () => {
  for (const { file, section, until } of CONTRACT_MODULES) {
    describe(`${file} → ${section}`, () => {
      it('names each exported symbol', () => {
        const body = sectionBody(section, until);
        const names = exportedSymbols(file);
        expect(names.length, `no exports parsed from ${file} — did its shape change?`).toBeGreaterThan(3);
        const missing = names.filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
        expect(
          missing,
          `${section} does not mention: ${missing.join(', ')}\n` +
            `${section} is the current-facts contract for ${file}; a public interface change must ` +
            'update it in the same commit. Add a bullet for each missing symbol.',
        ).toEqual([]);
      });

      it('the export list really parsed', () => {
        // Without this, an export-syntax change would make the check above pass
        // by finding nothing at all.
        expect(exportedSymbols(file).length).toBeGreaterThan(3);
      });
    });
  }
});

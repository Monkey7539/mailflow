import { describe, expect, it } from 'vitest';
import * as canonical from './attachmentExtensions.js';
// The download warning's bundled copy. The frontend image cannot import from backend/src, so it keeps
// its own, and this is what stops the two lists drifting apart again (#457). It is loaded without
// frontend/node_modules, which the backend CI job does not install, so that file stays import-free.
import * as bundled from '../../../frontend/src/utils/attachmentExtensions.js';
import { scoreRules } from './spamRules.js';

const TIERS = ['BLOCK', 'WARN', 'NOTICE', 'DECOY'];

describe('attachment extension tiers', () => {
  it.each(TIERS)('frontend/src/utils/attachmentExtensions.js has the same %s set', (tier) => {
    const missing = [...canonical[tier]].filter(ext => !bundled[tier].has(ext)).sort();
    const extra = [...bundled[tier]].filter(ext => !canonical[tier].has(ext)).sort();
    // Named, so a failure says which extensions to add or remove on which side.
    expect({ missingFromFrontend: missing, onlyInFrontend: extra }).toEqual({ missingFromFrontend: [], onlyInFrontend: [] });
  });

  it('puts each extension in at most one of block, warn and notice', () => {
    const tierOf = new Map();
    const clashes = [];
    for (const tier of ['BLOCK', 'WARN', 'NOTICE']) {
      for (const ext of canonical[tier]) {
        if (tierOf.has(ext)) clashes.push(`${ext}: ${tierOf.get(ext)} and ${tier}`);
        tierOf.set(ext, tier);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('lists bare lowercase extensions, the form both sides compare against', () => {
    const malformed = TIERS.flatMap(tier => [...canonical[tier]].filter(ext => ext !== ext.toLowerCase() || ext.includes('.') || ext !== ext.trim()));
    expect(malformed).toEqual([]);
  });

  it('is what ATTACHMENT_DOUBLE_EXT treats as the fake half of a disguise', () => {
    const doubleExt = attachment => scoreRules({ subject: 'Hi', body: '', headers: [], attachments: [attachment] })
      .fired.some(r => r.name === 'ATTACHMENT_DOUBLE_EXT');
    for (const decoy of canonical.DECOY) expect(doubleExt({ filename: `invoice.${decoy}.exe` }), decoy).toBe(true);
    expect(doubleExt({ filename: 'Statement 09.15.exe' })).toBe(false);
  });
});

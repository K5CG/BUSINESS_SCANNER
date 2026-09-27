import { COMMON_FIRST_NAMES } from '../lib/parser-engine/validators/dictionaries.ts';

const low = 'giovanhi';
let best = null;
let bestDist = 3;
for (const name of COMMON_FIRST_NAMES) {
  if (name.length < 5 || Math.abs(name.length - low.length) > 2) continue;
  let dist = 0;
  const maxLen = Math.max(name.length, low.length);
  for (let i = 0; i < maxLen; i++) {
    if ((name[i] ?? '') !== (low[i] ?? '')) dist++;
  }
  if (dist <= 2 && dist < bestDist) {
    bestDist = dist;
    best = name;
    console.log('match', name, dist);
  }
}
console.log('best', best, bestDist);

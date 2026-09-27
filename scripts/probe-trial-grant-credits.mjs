/**
 * Live probe: check-license trial grant amount from DB commercial settings.
 * Uses a fresh installationId. Numbers only — no secrets.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim()])
);

const base = env.EXPO_PUBLIC_SUPABASE_URL;
const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const installationId = process.argv[2] ?? randomUUID();

const response = await fetch(`${base}/functions/v1/check-license`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({ installationId }),
});
const body = await response.json();
console.log(
  JSON.stringify(
    {
      httpStatus: response.status,
      installationId,
      access: body.access ?? null,
      kind: body.kind ?? null,
      aiCreditsRemaining: body.aiCreditsRemaining ?? null,
      errorCode: body.errorCode ?? null,
    },
    null,
    2
  )
);

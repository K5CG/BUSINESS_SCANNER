/**
 * Genera chiavi licenza e SQL INSERT per Supabase.
 *
 * Uso:
 *   node scripts/generate-license-keys.js test 3
 *   node scripts/generate-license-keys.js premium 5
 *   node scripts/generate-license-keys.js premium 1 cliente@email.it
 */
const crypto = require('crypto');

const TEST_DAYS = 15;
const PREMIUM_DAYS = 365;

function randomSegment(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function makeKey(type) {
  const prefix = type === 'premium' ? 'BS-PREM' : 'BS-TEST';
  return `${prefix}-${randomSegment()}-${randomSegment()}`;
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function main() {
  const type = (process.argv[2] || 'premium').toLowerCase();
  const count = Math.max(1, parseInt(process.argv[3] || '1', 10));
  const emailArg = process.argv[4] ? normalizeEmail(process.argv[4]) : null;

  if (type !== 'test' && type !== 'premium') {
    console.error('Tipo: test | premium');
    process.exit(1);
  }

  const validDays = type === 'premium' ? PREMIUM_DAYS : TEST_DAYS;
  const maxActivations = type === 'premium' ? 2 : 5;

  console.log(`-- Licenze ${type} (${validDays} giorni)\n`);

  for (let i = 0; i < count; i++) {
    const key = makeKey(type);
    const email = emailArg ? `'${emailArg}'` : 'NULL';
    const note = emailArg
      ? `'Cliente ${emailArg} — ${new Date().toISOString().slice(0, 10)}'`
      : `'Generata ${new Date().toISOString().slice(0, 10)}'`;

    console.log(
      `INSERT INTO app_licenses (license_key, license_type, valid_days, max_activations, assigned_email, note) VALUES ('${key}', '${type}', ${validDays}, ${maxActivations}, ${email}, ${note});`
    );
    console.log(`-- Chiave: ${key}${emailArg ? ` · Email: ${emailArg}` : ''}\n`);
  }
}

main();

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getNativeUiPolicy } from '../lib/ui-native-policy.ts';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const ios = getNativeUiPolicy('ios');
const android = getNativeUiPolicy('android');

assert.equal(ios.stackAnimation, 'default');
assert.equal(ios.stackGesturesEnabled, true);
assert.equal(ios.fullScreenBackGesture, true);
assert.equal(ios.modalAnimation, 'slide');
assert.equal(ios.actionSheetAlignment, 'flex-end');
assert.equal(ios.scrollBounces, true);

assert.equal(android.stackAnimation, 'fade_from_bottom');
assert.equal(android.stackGesturesEnabled, false);
assert.equal(android.fullScreenBackGesture, false);
assert.equal(android.modalAnimation, 'fade');
assert.equal(android.actionSheetAlignment, 'center');
assert.equal(android.androidOverScrollMode, 'never');

const rootLayout = read('app/_layout.tsx');
assert.match(rootLayout, /getNativeUiPolicy/);
assert.match(rootLayout, /fullScreenGestureEnabled/);
assert.match(rootLayout, /backgroundColor=\{Platform\.OS === 'android'/);

const scan = read('app/scan/[type].tsx');
assert.match(scan, /Platform\.OS !== 'android'/);
assert.match(scan, /Platform\.OS !== 'android'/);
assert.match(scan, /headerBack:[\s\S]*?minWidth: 44,[\s\S]*?minHeight: 44/);

for (const file of [
  'components/EmailSharePicker.tsx',
  'components/ContactReparseProposalModal.tsx',
]) {
  assert.match(read(file), /getNativeUiPolicy/);
}

console.log('Native UI policy: 3/3 platform contracts passed');


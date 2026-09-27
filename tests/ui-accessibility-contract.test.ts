import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const cases: Array<[string, () => void]> = [
  ['modal focus is centralized', () => {
    const source = read('lib/use-modal-accessibility-focus.ts');
    assert.match(source, /AccessibilityInfo\.setAccessibilityFocus/);
    assert.match(source, /InteractionManager\.runAfterInteractions/);
  }],
  ['critical modals expose modal semantics and focus', () => {
    for (const file of [
      'components/GeminiConfirmationModal.tsx',
      'components/ContactReparseProposalModal.tsx',
      'components/EmailSharePicker.tsx',
      'components/LanguagePicker.tsx',
      'components/ThemePicker.tsx',
    ]) {
      const source = read(file);
      assert.match(source, /useModalAccessibilityFocus/);
      assert.match(source, /accessibilityViewIsModal/);
    }
  }],
  ['scanner announces processing and errors', () => {
    const source = read('components/Camera/MultiPageScanner.tsx');
    assert.match(source, /accessibilityLiveRegion="polite"/);
    assert.match(source, /accessibilityLiveRegion="assertive"/);
    assert.match(source, /accessibilityState=\{\{ disabled: scanning/);
  }],
  ['editable fields and icon actions are named', () => {
    const source = read('components/EditableField.tsx');
    assert.match(source, /accessibilityLabel=\{label\}/);
    assert.match(source, /accessibilityRole="button"/);
    assert.match(source, /touchTarget\.minimum/);
  }],
  ['tabs and home actions are named controls', () => {
    assert.match(read('app/(tabs)/_layout.tsx'), /tabBarAccessibilityLabel/);
    const home = read('app/(tabs)/index.tsx');
    assert.match(home, /accessibilityRole="button"/);
    assert.match(home, /accessibilityLabel=\{item\.label\}/);
  }],
  ['modal focus follows async content and export dialogs', () => {
    assert.match(read('components/GeminiConfirmationModal.tsx'), /modalRef, loadingPref/);
    const contacts = read('app/(tabs)/contacts.tsx');
    assert.match(contacts, /useModalAccessibilityFocus\(exportMenuVisible/);
    assert.match(contacts, /useModalAccessibilityFocus\(exportPickerVisible/);
    assert.match(contacts, /menuBackdrop[\s\S]*?accessible=\{false\}/);
  }],
  ['compact accessibility controls retain 44 dp targets', () => {
    const language = read('components/LanguagePicker.tsx');
    assert.match(language, /trigger:[\s\S]*?minHeight: 44/);
    assert.match(language, /option:[\s\S]*?minHeight: 44/);
    const scanner = read('components/Camera/MultiPageScanner.tsx');
    assert.match(scanner, /remountBtn:[\s\S]*?minHeight: 44/);
    assert.match(scanner, /removeButton:[\s\S]*?width: 44,[\s\S]*?height: 44/);
    assert.match(read('app/(tabs)/contacts.tsx'), /pickerClose:[^\n]*minHeight: 44/);
    assert.match(language, /ref=\{selected \? menuRef : undefined\}/);
    assert.match(read('components/ContactPhotoSection.tsx'), /removeBtn:[\s\S]*?minHeight: 44/);
    const contacts = read('app/(tabs)/contacts.tsx');
    assert.match(contacts, /searchClear:[^\n]*minHeight: 44/);
    const sortControls = read('components/ContactSortControls.tsx');
    assert.match(sortControls, /direction:[\s\S]*?minWidth: 44,[\s\S]*?minHeight: 44/);
    assert.match(sortControls, /accessibilityRole="radio"/);
    assert.match(sortControls, /accessibilityLabel=\{t\(directionLabelKey\)\}/);
    assert.match(sortControls, /accessibilityHint=\{t\(hintKey\)\}/);
    const documents = read('app/(tabs)/documents.tsx');
    assert.match(documents, /typeFilterChip:[\s\S]*?minHeight: 44/);
    assert.match(documents, /searchClear:[^\n]*minHeight: 44/);
  }],
  ['contacts search keeps the placeholder on one line', () => {
    const contacts = read('app/(tabs)/contacts.tsx');
    assert.match(contacts, /multiline=\{false\}/);
    assert.match(contacts, /numberOfLines=\{1\}/);
    assert.match(contacts, /searchInput:\s*\{[\s\S]*?textAlignVertical: 'center'/);
    const en = JSON.parse(read('i18n/en.json'));
    const it = JSON.parse(read('i18n/it.json'));
    assert.equal(en.contactsSearchPlaceholder, 'Search contacts…');
    assert.equal(it.contactsSearchPlaceholder, 'Cerca contatti…');
    // Un segnaposto breve non manda a capo dentro un campo a riga singola.
    for (const label of [en.contactsSearchPlaceholder, it.contactsSearchPlaceholder]) {
      assert.ok(label.length <= 20, `segnaposto troppo lungo: ${label}`);
      assert.doesNotMatch(label, /,/);
    }
  }],
  ['contacts delete control matches the documents list styling', () => {
    const contacts = read('app/(tabs)/contacts.tsx');
    assert.match(contacts, /onPress=\{\(\) => confirmDelete\(item\.id, title\)\}/);
    assert.match(contacts, /accessibilityLabel=\{`\$\{t\('delete'\)\}: \$\{title\}`\}/);
    assert.match(contacts, /name="trash-outline" size=\{22\} color=\{colors\.danger\}/);
    assert.match(contacts, /deleteBtn:\s*\{[\s\S]*?borderWidth: 0/);
    assert.match(contacts, /deleteBtn:\s*\{[\s\S]*?minHeight: 44/);
    assert.doesNotMatch(contacts, /deleteBtn:\s*\{[\s\S]*?borderColor: colors\.danger/);
  }],
];

let passed = 0;
for (const [name, run] of cases) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}
console.log(`\nUI accessibility: ${passed}/${cases.length} passed`);

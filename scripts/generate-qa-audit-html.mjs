#!/usr/bin/env node
/**
 * Business Scanner QA Audit HTML Generator v2
 * Node.js 18+, zero dipendenze npm.
 *
 * Uso:
 *   node scripts\generate-qa-audit-html.mjs
 *   node scripts\generate-qa-audit-html.mjs "C:\percorso\export.zip"
 *   node scripts\generate-qa-audit-html.mjs "C:\percorso\cartella_estratta"
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION = '2.0.0';

function fail(message, details = '') {
  console.error(`\nERRORE: ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function pickInputOnWindows() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Seleziona Export QA ZIP'
$dialog.Filter = 'Export QA ZIP (*.zip)|*.zip|Tutti i file (*.*)|*.*'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
  exit 0
}
$folder = New-Object System.Windows.Forms.FolderBrowserDialog
$folder.Description = 'Oppure seleziona una cartella export già estratta'
$folder.ShowNewFolderButton = $false
if ($folder.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $folder.SelectedPath
  exit 0
}
exit 2
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: false }
  );
  if (result.status === 2) return '';
  if (result.status !== 0) {
    fail('Impossibile aprire la finestra di selezione.', result.stderr || result.stdout);
  }
  return (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
}

function extractZip(zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === 'win32') {
    const z = zipPath.replaceAll("'", "''");
    const d = destination.replaceAll("'", "''");
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
       `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${z}' -DestinationPath '${d}' -Force`],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) {
      fail('Estrazione ZIP fallita.', result.stderr || result.stdout);
    }
  } else {
    const result = spawnSync('unzip', ['-q', zipPath, '-d', destination], { encoding: 'utf8' });
    if (result.status !== 0) fail('Estrazione ZIP fallita.', result.stderr || result.stdout);
  }
}

function findExportRoot(root) {
  if (exists(path.join(root, 'contacts.json'))) return root;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (exists(path.join(full, 'contacts.json'))) return full;
      stack.push(full);
    }
  }
  fail('contacts.json non trovato nello ZIP o nella cartella selezionata.');
}

function escapeHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function readContacts(exportRoot) {
  const file = path.join(exportRoot, 'contacts.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail('contacts.json non valido.', e?.message || String(e));
  }
  const contacts = Array.isArray(parsed) ? parsed : parsed.contacts || parsed.items;
  if (!Array.isArray(contacts)) fail('contacts.json non contiene un array di contatti.');
  return contacts;
}

function formatEmails(value) {
  if (Array.isArray(value)) return value.join(' | ');
  return String(value || '');
}

function formatPhones(value) {
  if (!Array.isArray(value)) return String(value || '');
  return value.map(p => typeof p === 'string' ? p : `${p.number || ''}${p.type ? ` (${p.type})` : ''}`)
    .filter(Boolean).join(' | ');
}

function formatAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.full || [
    value.street, value.civicNumber, value.postalCode,
    value.city, value.province, value.country
  ].filter(Boolean).join(' - ');
}

function locateImages(exportRoot, contactId) {
  const dir = path.join(exportRoot, 'images');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.startsWith(contactId) && /\.(png|jpe?g|webp)$/i.test(n))
    .sort()
    .map(n => `../images/${encodeURIComponent(n)}`);
}

function automaticIssues(c) {
  const issues = [];
  const company = String(c.company || '');
  const website = String(c.website || '');
  const address = formatAddress(c.address);
  const raw = String(c.rawText || '');
  const emails = formatEmails(c.emails);
  const phones = formatPhones(c.phones);

  if (/^(---|\*\*\*|[-_]{2,})/.test(company.trim())) {
    issues.push(['company', 'Azienda con prefisso OCR sospetto']);
  }
  if (/\b(via|viale|piazza|tel|fax|www\.|@)\b/i.test(company)) {
    issues.push(['company', 'Azienda contaminata da indirizzo o contatti']);
  }
  if (website && (/www\.(s\.?r\.?l|snc|spa|sas)/i.test(website) || /\d{6,}/.test(website))) {
    issues.push(['website', 'Sito probabilmente falso']);
  }
  if (address && /@|www\.|\b(tel|fax|cell|mobile)\b/i.test(address)) {
    issues.push(['address', 'Indirizzo contaminato da contatti']);
  }
  if (!emails && /[\w.+-]+@\s*[\w.-]+/i.test(raw)) {
    issues.push(['emails', 'Email presente nell OCR ma campo vuoto']);
  }
  if (!phones && /\b(tel|fax|cell|mobile|mob|ph)\b/i.test(raw)) {
    issues.push(['phones', 'Telefono presente nell OCR ma campo vuoto']);
  }
  if (!c.vatNumber && /\b(p\.?\s*iva|vat)\b/i.test(raw)) {
    issues.push(['vatNumber', 'P.IVA/VAT presente nell OCR ma campo vuoto']);
  }
  return issues;
}

let input = process.argv[2] || '';
if (!input) {
  if (process.platform !== 'win32') {
    fail('Senza parametro la selezione grafica è disponibile solo su Windows.');
  }
  console.log('Apertura finestra di selezione...');
  input = pickInputOnWindows();
  if (!input) {
    console.log('Operazione annullata.');
    process.exit(0);
  }
}

input = path.resolve(input);
if (!exists(input)) fail(`Percorso non trovato: ${input}`);

let workingRoot;
if (fs.statSync(input).isDirectory()) {
  workingRoot = input;
} else if (/\.zip$/i.test(input)) {
  const parent = path.dirname(input);
  const name = path.basename(input, path.extname(input));
  workingRoot = path.join(parent, `${name}_QA_REVIEW`);
  if (exists(workingRoot)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    workingRoot = `${workingRoot}_${stamp}`;
  }
  console.log(`Estrazione in:\n${workingRoot}`);
  extractZip(input, workingRoot);
} else {
  fail('Selezionare un file ZIP oppure una cartella export estratta.');
}

const exportRoot = findExportRoot(workingRoot);
const contacts = readContacts(exportRoot);
const qaDir = path.join(exportRoot, 'QA_REVIEW');
fs.mkdirSync(qaDir, { recursive: true });

const payload = contacts.map((c, i) => ({
  index: i + 1,
  id: c.id,
  title: c.title || c.company || `${c.firstName || ''} ${c.lastName || ''}`.trim() || `Contatto ${i + 1}`,
  rawText: c.rawText || '',
  images: locateImages(exportRoot, c.id),
  fields: {
    company: c.company || '',
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    role: c.role || '',
    emails: formatEmails(c.emails),
    phones: formatPhones(c.phones),
    website: c.website || '',
    address: formatAddress(c.address),
    vatNumber: c.vatNumber || '',
    taxCode: c.taxCode || '',
    notes: c.notes || '',
  },
  issues: automaticIssues(c),
}));

const dataJson = JSON.stringify(payload).replaceAll('</script>', '<\\/script>');

const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Business Scanner QA Review</title>
<style>
body{margin:0;font-family:Segoe UI,Arial;background:#f4f6f8;color:#17202a}
header{position:sticky;top:0;background:#101828;color:white;padding:10px;display:flex;gap:8px;align-items:center;z-index:10}
button,input,select,textarea{font:inherit}
button,input,select{padding:7px;border-radius:6px;border:1px solid #98a2b3}
header input{width:260px}
.wrap{display:grid;grid-template-columns:270px 1fr;min-height:calc(100vh - 54px)}
aside{background:white;border-right:1px solid #d0d5dd;padding:10px;overflow:auto;height:calc(100vh - 54px);position:sticky;top:54px}
.item{width:100%;text-align:left;margin-bottom:6px;padding:8px;background:white;border:1px solid #d0d5dd;border-radius:7px;cursor:pointer}
.item.active{background:#edf6ff;border-color:#1264a3}
main{padding:14px}
.card{background:white;border:1px solid #d0d5dd;border-radius:9px;padding:12px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
img{width:100%;max-height:460px;object-fit:contain;background:#222;border-radius:7px}
pre{white-space:pre-wrap;max-height:420px;overflow:auto;background:#fafbfc;padding:10px;border:1px solid #eaecf0;border-radius:7px}
.row{display:grid;grid-template-columns:110px 1fr 1fr 50px;gap:7px;padding:6px 0;border-bottom:1px solid #eee}
.row label{font-weight:700;padding-top:8px}
textarea{width:100%;min-height:42px;padding:7px;border:1px solid #d0d5dd;border-radius:6px}
.expected{background:#fffbea}
.small{font-size:12px;color:#667085}
.issue{color:#b42318;margin:4px 0}
@media(max-width:900px){.wrap{grid-template-columns:1fr}aside{position:static;height:220px}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
<strong>Business Scanner QA Review</strong>
<button id="prev">◀</button>
<button id="next">▶</button>
<input id="search" placeholder="Cerca...">
<button id="exportCsv">Esporta errori CSV</button>
<button id="exportJson">Esporta review JSON</button>
<span id="count"></span>
</header>
<div class="wrap"><aside id="list"></aside><main id="main"></main></div>
<script id="payload" type="application/json">${dataJson}</script>
<script>
const contacts=JSON.parse(document.getElementById('payload').textContent);
const KEY='bs-qa-review-v2:'+location.pathname;
let saved={};
try{saved=JSON.parse(localStorage.getItem(KEY)||'{}')}catch{}
let idx=0, filtered=contacts.map((_,i)=>i);
const labels={company:'Azienda',firstName:'Nome',lastName:'Cognome',role:'Ruolo',emails:'Email',phones:'Telefoni',website:'Sito',address:'Indirizzo',vatNumber:'P.IVA',taxCode:'Codice fiscale',notes:'Note'};

function esc(v){return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]))}
function review(c){
  if(!saved[c.id]){
    saved[c.id]={status:'open',cause:'',comment:'',fields:{}};
    for(const [k,v] of Object.entries(c.fields)) saved[c.id].fields[k]={actual:v,expected:v,ok:true};
  }
  return saved[c.id];
}
function store(){localStorage.setItem(KEY,JSON.stringify(saved));renderList()}
function renderList(){
  const list=document.getElementById('list');list.innerHTML='';
  filtered.forEach(i=>{
    const c=contacts[i],r=review(c),bad=Object.values(r.fields).some(f=>!f.ok);
    const b=document.createElement('button');
    b.className='item'+(i===idx?' active':'');
    b.innerHTML='<b>'+esc(c.index+'. '+c.title)+'</b><div class="small">'+(bad?'ERRORI':'DA VERIFICARE')+'</div>';
    b.onclick=()=>{idx=i;render()};
    list.appendChild(b);
  });
}
function render(){
  const c=contacts[idx],r=review(c);
  document.getElementById('count').textContent=(idx+1)+' / '+contacts.length;
  const imgs=c.images.length?c.images.map(s=>'<img src="'+s+'">').join(''):'<div class="small">Nessuna immagine</div>';
  const issues=c.issues.length?c.issues.map(x=>'<div class="issue"><b>'+esc(labels[x[0]]||x[0])+':</b> '+esc(x[1])+'</div>').join(''):'<div class="small">Nessuna anomalia automatica evidente.</div>';
  const rows=Object.entries(c.fields).map(([k,v])=>{
    const f=r.fields[k];
    return '<div class="row"><label>'+esc(labels[k]||k)+'</label><textarea readonly>'+esc(v)+'</textarea><textarea class="expected" data-f="'+k+'">'+esc(f.expected)+'</textarea><input type="checkbox" data-ok="'+k+'" '+(f.ok?'checked':'')+'></div>';
  }).join('');
  document.getElementById('main').innerHTML=
    '<div class="card"><h2>'+esc(c.index+'. '+c.title)+'</h2></div>'+
    '<div class="grid"><div class="card"><h3>Immagini</h3>'+imgs+'</div><div><div class="card"><h3>OCR grezzo</h3><pre>'+esc(c.rawText)+'</pre></div><div class="card"><h3>Segnalazioni automatiche</h3>'+issues+'</div></div></div>'+
    '<div class="card"><h3>Confronto campi</h3><div class="small">Sinistra: estratto. Destra: valore corretto atteso.</div>'+rows+
    '<p><label>Causa <select id="cause"><option></option><option>camera</option><option>ocr</option><option>parser</option><option>post-processing</option><option>confidence</option><option>ambiguo</option></select></label></p>'+
    '<textarea id="comment" placeholder="Note revisore...">'+esc(r.comment||'')+'</textarea></div>';
  document.getElementById('cause').value=r.cause||'';
  document.getElementById('cause').onchange=e=>{r.cause=e.target.value;store()};
  document.getElementById('comment').oninput=e=>{r.comment=e.target.value;store()};
  document.querySelectorAll('[data-f]').forEach(el=>el.oninput=()=>{
    const k=el.dataset.f;r.fields[k].expected=el.value;r.fields[k].ok=el.value.trim()===String(c.fields[k]||'').trim();
    const cb=document.querySelector('[data-ok="'+k+'"]');if(cb)cb.checked=r.fields[k].ok;store();
  });
  document.querySelectorAll('[data-ok]').forEach(el=>el.onchange=()=>{
    const k=el.dataset.ok;r.fields[k].ok=el.checked;if(el.checked)r.fields[k].expected=c.fields[k]||'';store();render();
  });
  renderList();scrollTo(0,0);
}
function move(d){idx=Math.max(0,Math.min(contacts.length-1,idx+d));render()}
function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
document.getElementById('prev').onclick=()=>move(-1);
document.getElementById('next').onclick=()=>move(1);
document.getElementById('search').oninput=e=>{
 const q=e.target.value.toLowerCase();filtered=contacts.map((c,i)=>({c,i})).filter(x=>JSON.stringify(x.c).toLowerCase().includes(q)).map(x=>x.i);renderList()
};
document.getElementById('exportJson').onclick=()=>download('business-scanner-qa-review.json',JSON.stringify(saved,null,2),'application/json');
document.getElementById('exportCsv').onclick=()=>{
 const rows=[['contact','id','field','actual','expected','cause','comment']];
 contacts.forEach(c=>{const r=review(c);Object.entries(r.fields).forEach(([k,f])=>{if(!f.ok)rows.push([c.title,c.id,k,f.actual,f.expected,r.cause,r.comment])})});
 const csv=rows.map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(';')).join('\\r\\n');
 download('business-scanner-qa-errors.csv','\\ufeff'+csv,'text/csv;charset=utf-8');
};
renderList();render();
</script>
</body>
</html>`;

const htmlPath = path.join(qaDir, 'index.html');
fs.writeFileSync(htmlPath, html, 'utf8');
fs.writeFileSync(path.join(qaDir, 'README.txt'),
`Business Scanner QA Review v${VERSION}

Aprire index.html con Chrome o Edge.
Le modifiche vengono salvate automaticamente nel browser.
Esportare periodicamente il file JSON come backup.
`, 'utf8');

console.log(`\nOK: ${contacts.length} contatti caricati.`);
console.log(`Pagina creata:\n${htmlPath}`);

if (process.platform === 'win32') {
  const open = spawnSync('cmd.exe', ['/c', 'start', '', htmlPath], { windowsHide: false });
  if (open.status !== 0) {
    console.log(`\nAprire manualmente:\n${htmlPath}`);
  }
}

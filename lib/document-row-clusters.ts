import type { DocumentLayoutLine } from './document-structure';
import { parseInternationalAmount } from './document-international-values';
import { logQaDocument } from './qa-document-logging';
import type { OrphanRowBand } from './document-orphan-cells';

function lineY(line: DocumentLayoutLine): number {
  return line.boundingBox?.y ?? 0;
}

function lineX(line: DocumentLayoutLine): number {
  const box = line.boundingBox;
  return box ? box.x + box.width / 2 : line.readingOrder;
}

function parsedAmount(line: DocumentLayoutLine): number | undefined {
  return parseInternationalAmount(line.text).normalizedValue;
}

function isCodeLike(text: string): boolean {
  const token = text.trim();
  if (token.length < 3 || token.length > 18 || /\s/.test(token)) return false;
  return /[A-Za-z]/.test(token) && /[0-9]/.test(token);
}

function hasCommercialDescription(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  return row.lines.some((line) => {
    const kind = assignColumn(line);
    if (kind === 'itemCode' || kind === 'quantity' || kind === 'unitPrice' || kind === 'discount' || kind === 'vatRate' || kind === 'lineTotal') {
      return false;
    }
    if (parsedAmount(line) !== undefined && !/[A-Za-zÀ-ÿ]{4,}/.test(line.text)) return false;
    if (isCodeLike(line.text)) return false;
    return /[A-Za-zÀ-ÿ]{4,}/.test(line.text);
  });
}

function hasItemCode(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  return row.lines.some((line) => assignColumn(line) === 'itemCode' || isCodeLike(line.text));
}

function fieldValue(
  row: OrphanRowBand,
  kind: string,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): number | undefined {
  for (const line of row.lines) {
    if (assignColumn(line) !== kind) continue;
    const value = parsedAmount(line);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasIndependentNumerics(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  const qty = fieldValue(row, 'quantity', assignColumn);
  const price = fieldValue(row, 'unitPrice', assignColumn);
  const total = fieldValue(row, 'lineTotal', assignColumn);
  return (qty !== undefined && price !== undefined)
    || (qty !== undefined && total !== undefined)
    || (price !== undefined && total !== undefined);
}

function numericColumnCount(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): number {
  const kinds = new Set<string>();
  for (const line of row.lines) {
    const kind = assignColumn(line);
    if (kind === 'quantity' || kind === 'unitPrice' || kind === 'discount' || kind === 'vatRate' || kind === 'lineTotal') {
      kinds.add(kind);
    }
  }
  return kinds.size;
}

function isStrongNumericCluster(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  const qty = fieldValue(row, 'quantity', assignColumn);
  const price = fieldValue(row, 'unitPrice', assignColumn);
  const total = fieldValue(row, 'lineTotal', assignColumn);
  const vat = fieldValue(row, 'vatRate', assignColumn);
  const columns = numericColumnCount(row, assignColumn);
  const hasPositiveMoney = (price !== undefined && price > 0) || (total !== undefined && total > 0);
  if (!hasPositiveMoney) return false;
  return columns >= 3 || (qty !== undefined && price !== undefined && total !== undefined)
    || (qty !== undefined && price !== undefined && vat !== undefined && total !== undefined);
}

function clusterNeedsDisplacedDescriptionSearch(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  if (isStrongNumericCluster(row, assignColumn)) return true;
  if (hasCommercialDescription(row, assignColumn) || !hasIndependentNumerics(row, assignColumn)) {
    return false;
  }
  const qty = fieldValue(row, 'quantity', assignColumn);
  const price = fieldValue(row, 'unitPrice', assignColumn);
  const total = fieldValue(row, 'lineTotal', assignColumn);
  const vat = fieldValue(row, 'vatRate', assignColumn);
  const columns = numericColumnCount(row, assignColumn);
  const zeroPriced = (price === 0 || total === 0) && (qty === undefined || qty > 0);
  if (!zeroPriced) return false;
  return columns >= 3
    || (qty !== undefined && price !== undefined && vat !== undefined)
    || hasItemCode(row, assignColumn);
}

function isLeftAnchorRow(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  return hasCommercialDescription(row, assignColumn) || hasItemCode(row, assignColumn);
}

function missingPrimaryNumerics(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  return fieldValue(row, 'quantity', assignColumn) === undefined
    && fieldValue(row, 'unitPrice', assignColumn) === undefined;
}

function stronglyOwned(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  return hasCommercialDescription(row, assignColumn)
    && hasIndependentNumerics(row, assignColumn)
    && fieldValue(row, 'quantity', assignColumn) !== undefined
    && (fieldValue(row, 'unitPrice', assignColumn) !== undefined || fieldValue(row, 'lineTotal', assignColumn) !== undefined);
}

function arithmeticSupport(
  owner: OrphanRowBand,
  cluster: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  const qty = fieldValue(cluster, 'quantity', assignColumn) ?? fieldValue(owner, 'quantity', assignColumn);
  const price = fieldValue(cluster, 'unitPrice', assignColumn) ?? fieldValue(owner, 'unitPrice', assignColumn);
  const total = fieldValue(owner, 'lineTotal', assignColumn) ?? fieldValue(cluster, 'lineTotal', assignColumn);
  const discount = fieldValue(cluster, 'discount', assignColumn) ?? fieldValue(owner, 'discount', assignColumn);
  if (qty === undefined || price === undefined || total === undefined) return false;
  const factor = discount !== undefined && discount > 0 && discount < 80 ? 1 - discount / 100 : 1;
  return Math.abs(qty * price * factor - total) <= Math.max(0.06, Math.abs(total) * 0.01);
}

function compareClusterScores(
  left: { score: number; dy: number; rowY: number; rowX: number; index: number },
  right: { score: number; dy: number; rowY: number; rowX: number; index: number },
): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.dy !== right.dy) return left.dy - right.dy;
  if (left.rowY !== right.rowY) return left.rowY - right.rowY;
  if (left.rowX !== right.rowX) return left.rowX - right.rowX;
  return left.index - right.index;
}

function isLeftAnchorLine(
  line: DocumentLayoutLine,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  const kind = assignColumn(line);
  if (kind === 'itemCode' || isCodeLike(line.text)) return true;
  if (kind === 'quantity' || kind === 'unitPrice' || kind === 'discount' || kind === 'vatRate' || kind === 'lineTotal') {
    return false;
  }
  if (parsedAmount(line) !== undefined && !/[A-Za-zÀ-ÿ]{4,}/.test(line.text)) return false;
  return kind === 'description' || /[A-Za-zÀ-ÿ]{4,}/.test(line.text);
}

function isRowStartAnchor(
  line: DocumentLayoutLine,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  const text = line.text.trim();
  if (!text || isCodeLike(text)) return false;
  if (!isLeftAnchorLine(line, assignColumn)) return false;
  return /^[A-ZÀ-Ü]/.test(text) && /[A-Za-zÀ-ÿ]{4,}/.test(text);
}

function commercialSameBandLimit(medianLineHeight: number, spacing: number): number {
  const fromGlyph = Math.max(medianLineHeight * 1.15, 16);
  const fromRowGap = Math.max(spacing * 0.42, medianLineHeight * 0.85);
  return Math.min(fromGlyph, fromRowGap);
}

function groupHasItemCode(
  group: readonly DocumentLayoutLine[],
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  return group.some((line) => assignColumn(line) === 'itemCode' || isCodeLike(line.text));
}

function groupIsLeftOfCluster(group: readonly DocumentLayoutLine[], clusterX: number): boolean {
  return group.some((line) => lineX(line) < clusterX - 12);
}

type DisplacedAnchorGroup = {
  group: DocumentLayoutLine[];
  dy: number;
  hasDescription: boolean;
  hasRowStart: boolean;
  substantial: boolean;
  hasCode: boolean;
};

function selectAlignedSameBandAnchor(
  ranked: readonly DisplacedAnchorGroup[],
  band: number,
  clusterX: number,
): DisplacedAnchorGroup | undefined {
  const inBand = ranked.filter((entry) =>
    entry.dy <= band && groupIsLeftOfCluster(entry.group, clusterX));
  const codeDesc = inBand.filter((entry) => entry.hasCode && entry.hasDescription);
  if (codeDesc.length === 1) return codeDesc[0];
  if (codeDesc.length > 1) return undefined;
  const descriptions = inBand.filter((entry) => entry.hasDescription);
  return descriptions.length === 1 ? descriptions[0] : undefined;
}

export function assignUnownedNumericClusters(input: {
  rows: OrphanRowBand[];
  assignColumn: (line: DocumentLayoutLine) => string | undefined;
  pageIndex: number;
  medianLineHeight: number;
  medianRowSpacing: number;
  body?: readonly DocumentLayoutLine[];
}): { rows: OrphanRowBand[]; attached: number; ambiguous: number } {
  const rows = input.rows.map((row) => ({ ...row, lines: row.lines.slice() }));
  const spacing = Math.max(input.medianLineHeight * 1.8, Math.min(input.medianRowSpacing, input.medianLineHeight * 5));
  const ownedClusterIds = new Set<number>();
  const claimedOwners = new Set<number>();
  let attached = 0;
  let ambiguous = 0;

  const donors = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      row.pageIndex === input.pageIndex
      && !stronglyOwned(row, input.assignColumn)
      && hasIndependentNumerics(row, input.assignColumn)
      && !hasCommercialDescription(row, input.assignColumn));

  const owners = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      row.pageIndex === input.pageIndex
      && hasCommercialDescription(row, input.assignColumn)
      && missingPrimaryNumerics(row, input.assignColumn)
      && !hasIndependentNumerics(row, input.assignColumn)
      && !stronglyOwned(row, input.assignColumn));

  for (const donor of donors) {
    if (ownedClusterIds.has(donor.index)) continue;
    const clusterY = donor.row.y;
    const clusterX = donor.row.lines[0] ? lineX(donor.row.lines[0]) : 0;
    const descriptionOwners = owners.filter((owner) =>
      owner.index !== donor.index && !claimedOwners.has(owner.index) && hasCommercialDescription(owner.row, input.assignColumn));
    const eligibleOwners = descriptionOwners.length > 0
      ? descriptionOwners
      : owners.filter((owner) => owner.index !== donor.index && !claimedOwners.has(owner.index));
    const scored = eligibleOwners
      .filter((owner) => owner.row.pageIndex === donor.row.pageIndex)
      .map((owner) => {
        const dy = Math.abs(owner.row.y - clusterY);
        const ownerX = owner.row.lines[0] ? lineX(owner.row.lines[0]) : 0;
        const maxDy = spacing * 1.35;
        const inSpacing = dy <= maxDy;
        let score = 48 - (dy / Math.max(8, spacing)) * 28;
        if (!inSpacing) score -= 400;
        if (owner.row.pageIndex !== donor.row.pageIndex) score -= 1000;
        if (hasIndependentNumerics(owner.row, input.assignColumn)) score -= 400;
        if (hasItemCode(owner.row, input.assignColumn) && hasItemCode(donor.row, input.assignColumn)) {
          score -= 80;
        }
        if (hasCommercialDescription(owner.row, input.assignColumn) && !hasCommercialDescription(donor.row, input.assignColumn)) {
          score += 24;
        }
        if (ownerX < clusterX) score += 6;
        const ownerTotal = fieldValue(owner.row, 'lineTotal', input.assignColumn);
        const donorTotal = fieldValue(donor.row, 'lineTotal', input.assignColumn);
        if (ownerTotal !== undefined && donorTotal !== undefined && Math.abs(ownerTotal - donorTotal) > 0.05) {
          score -= 400;
        }
        const ownerQty = fieldValue(owner.row, 'quantity', input.assignColumn);
        const donorQty = fieldValue(donor.row, 'quantity', input.assignColumn);
        if (ownerQty !== undefined && donorQty !== undefined && Math.abs(ownerQty - donorQty) > 0.05) {
          score -= 400;
        }
        const ownerPrice = fieldValue(owner.row, 'unitPrice', input.assignColumn);
        const donorPrice = fieldValue(donor.row, 'unitPrice', input.assignColumn);
        if (ownerPrice !== undefined && donorPrice !== undefined && Math.abs(ownerPrice - donorPrice) > 0.05) {
          score -= 400;
        }
        if (hasItemCode(donor.row, input.assignColumn)) score += 10;
        if (fieldValue(owner.row, 'quantity', input.assignColumn) === undefined) score += 8;
        if (fieldValue(owner.row, 'unitPrice', input.assignColumn) === undefined) score += 6;
        if (arithmeticSupport(owner.row, donor.row, input.assignColumn)) score += 12;
        const codeLine = donor.row.lines.find((line) => isCodeLike(line.text) || input.assignColumn(line) === 'itemCode');
        if (codeLine) {
          score += Math.max(0, 8 - Math.abs(lineY(codeLine) - owner.row.y) / Math.max(8, spacing) * 8);
        }
        return {
          owner,
          score,
          dy,
          rowY: owner.row.y,
          rowX: ownerX,
          index: owner.index,
          inSpacing,
        };
      })
      .sort(compareClusterScores);

    const best = scored[0];
    const second = scored[1];
    const unique = !!best
      && best.inSpacing
      && best.score > 0
      && (!second || best.score >= second.score + 8);

    logQaDocument('RowClusterOwnership', {
      page: input.pageIndex,
      clusterId: donor.index,
      candidateRows: scored.slice(0, 4).map((entry) => ({
        row: entry.index,
        score: Math.round(entry.score * 100) / 100,
        dy: Math.round(entry.dy * 10) / 10,
      })),
      chosenRow: unique ? best.index : undefined,
      scoreBreakdown: best
        ? { score: Math.round(best.score * 100) / 100, dy: Math.round(best.dy * 10) / 10, inSpacing: best.inSpacing }
        : undefined,
      ownershipStatus: unique ? 'attached' : (!best || !best.inSpacing) ? 'unattached' : 'ambiguous',
      ambiguous: !unique && !!best && !!second && Math.abs(best.score - second.score) < 8,
      clusterX,
      clusterY,
    });

    if (!unique || !best) {
      if (best && second && Math.abs(best.score - second.score) < 8) ambiguous += 1;
      const strongCluster = clusterNeedsDisplacedDescriptionSearch(donor.row, input.assignColumn);
      const inBandOwners = scored.filter((entry) => entry.inSpacing);
      if (!strongCluster || inBandOwners.length > 0) continue;
      const assignedIds = new Set(rows.flatMap((row) => row.lines.map((line) => line.id)));
      const maxDy = Math.max(spacing * 1.35, input.medianLineHeight * 3);
      const nearbyAnchors = (input.body ?? []).filter((line) =>
        line.pageIndex === donor.row.pageIndex
        && !assignedIds.has(line.id)
        && !donor.row.lines.some((owned) => owned.id === line.id)
        && isLeftAnchorLine(line, input.assignColumn)
        && Math.abs(lineY(line) - clusterY) <= maxDy);
      const peelFrom = new Map<string, number>();
      for (const [index, row] of rows.entries()) {
        if (index === donor.index || row.pageIndex !== donor.row.pageIndex) continue;
        const numericYs = row.lines
          .map((line) => ({ line, kind: input.assignColumn(line) }))
          .filter((entry) => entry.kind === 'quantity' || entry.kind === 'unitPrice' || entry.kind === 'lineTotal')
          .map((entry) => lineY(entry.line));
        const numericY = numericYs.length > 0
          ? numericYs.reduce((sum, value) => sum + value, 0) / numericYs.length
          : row.y;
        for (const line of row.lines) {
          if (!isRowStartAnchor(line, input.assignColumn)) continue;
          const dy = Math.abs(lineY(line) - clusterY);
          if (dy <= maxDy && dy + 12 < Math.abs(lineY(line) - numericY)) {
            nearbyAnchors.push(line);
            peelFrom.set(line.id, index);
          }
        }
      }
      const groups: DocumentLayoutLine[][] = [];
      for (const line of [...nearbyAnchors].sort((left, right) => lineY(left) - lineY(right))) {
        const last = groups[groups.length - 1];
        const lastLine = last?.[last.length - 1];
        const sameBaseline = !!lastLine
          && Math.abs(lineY(line) - lineY(lastLine)) <= Math.max(10, input.medianLineHeight * 0.45);
        const close = !!lastLine
          && Math.abs(lineY(line) - lineY(lastLine)) <= Math.max(input.medianLineHeight * 1.8, 36);
        if (last && (sameBaseline || (close && !isRowStartAnchor(line, input.assignColumn)))) {
          last.push(line);
        } else {
          groups.push([line]);
        }
      }
      const ranked: DisplacedAnchorGroup[] = groups.map((group) => ({
        group,
        dy: Math.min(...group.map((line) => Math.abs(lineY(line) - clusterY))),
        hasDescription: group.some((line) => /[A-Za-zÀ-ÿ]{4,}/.test(line.text) && !isCodeLike(line.text)),
        hasRowStart: group.some((line) => isRowStartAnchor(line, input.assignColumn)),
        hasCode: groupHasItemCode(group, input.assignColumn),
        substantial: group.some((line) => {
          const words = line.text.trim().split(/\s+/).filter((word) => /[A-Za-zÀ-ÿ]{3,}/.test(word));
          return words.length >= 3 || line.text.trim().length >= 28;
        }),
      })).sort((left, right) =>
        Number(right.hasCode && right.hasDescription) - Number(left.hasCode && left.hasDescription)
        || Number(right.hasRowStart) - Number(left.hasRowStart)
        || Number(right.substantial) - Number(left.substantial)
        || Number(right.hasDescription) - Number(left.hasDescription)
        || left.dy - right.dy);
      const sameBand = commercialSameBandLimit(input.medianLineHeight, spacing);
      const aligned = selectAlignedSameBandAnchor(ranked, sameBand, clusterX);
      const substantialStarts = ranked.filter((entry) => entry.hasRowStart && entry.substantial);
      const rowStarts = ranked.filter((entry) => entry.hasRowStart);
      const fallbackTop = substantialStarts[0]
        ?? (rowStarts.length === 1 ? rowStarts[0] : undefined);
      const runnerUp = (fallbackTop && substantialStarts.length > 1 ? substantialStarts[1] : undefined)
        ?? (fallbackTop && rowStarts.length > 1 && !fallbackTop.substantial
          ? rowStarts.find((entry) => entry !== fallbackTop)
          : undefined);
      const fallbackUnique = !!fallbackTop
        && (!runnerUp || fallbackTop.dy + Math.max(12, input.medianLineHeight) < runnerUp.dy)
        && !(aligned && fallbackTop !== aligned && fallbackTop.dy > sameBand);
      const top = aligned ?? (fallbackUnique ? fallbackTop : undefined);
      const uniqueGroup = !!top;
      logQaDocument('RowClusterOwnership', {
        page: input.pageIndex,
        clusterId: donor.index,
        candidateRows: ranked.slice(0, 4).map((entry, index) => ({
          row: index,
          score: Math.round((48 - entry.dy) * 100) / 100,
          dy: Math.round(entry.dy * 10) / 10,
          hasCode: entry.hasCode,
          hasDescription: entry.hasDescription,
          sameBand: entry.dy <= sameBand,
        })),
        chosenRow: uniqueGroup ? donor.index : undefined,
        ownershipStatus: uniqueGroup ? 'attached' : ranked.length > 1 ? 'ambiguous' : 'unattached',
        ambiguous: !uniqueGroup && ranked.length > 1,
        clusterX,
        clusterY,
      });
      if (!uniqueGroup || !top) {
        if (!uniqueGroup && ranked.length > 1) ambiguous += 1;
        continue;
      }
      const seenIds = new Set(donor.row.lines.map((line) => line.id));
      for (const line of top.group) {
        if (seenIds.has(line.id)) continue;
        donor.row.lines.push(line);
        seenIds.add(line.id);
        const sourceIndex = peelFrom.get(line.id);
        if (sourceIndex !== undefined) {
          rows[sourceIndex]!.lines = rows[sourceIndex]!.lines.filter((entry) => entry.id !== line.id);
        }
      }
      const extraCode = ranked.filter((entry) =>
        entry !== top
        && !entry.hasDescription
        && entry.group.every((line) => isCodeLike(line.text) || input.assignColumn(line) === 'itemCode')
        && entry.dy <= maxDy);
      if (extraCode.length === 1) {
        for (const line of extraCode[0]!.group) {
          if (seenIds.has(line.id)) continue;
          donor.row.lines.push(line);
          seenIds.add(line.id);
        }
      }
      ownedClusterIds.add(donor.index);
      attached += 1;
      continue;
    }
    const target = rows[best.index]!;
    const seen = new Set(target.lines.map((line) => line.id));
    for (const line of donor.row.lines) {
      if (seen.has(line.id)) continue;
      target.lines.push(line);
      seen.add(line.id);
    }
    donor.row.lines = [];
    ownedClusterIds.add(donor.index);
    claimedOwners.add(best.index);
    attached += 1;
    if (hasCommercialDescription(target, input.assignColumn)) {
      const strong = isStrongNumericCluster(target, input.assignColumn);
      const absorbDy = strong
        ? Math.max(spacing * 2.6, input.medianLineHeight * 6)
        : spacing * 1.35;
      const codeAnchors = owners.filter((owner) =>
        !claimedOwners.has(owner.index)
        && owner.index !== best.index
        && owner.row.pageIndex === donor.row.pageIndex
        && hasItemCode(owner.row, input.assignColumn)
        && !hasCommercialDescription(owner.row, input.assignColumn)
        && Math.abs(owner.row.y - target.y) <= absorbDy);
      if (codeAnchors.length === 1) {
        const codeOwner = codeAnchors[0]!;
        for (const line of codeOwner.row.lines) {
          if (seen.has(line.id)) continue;
          target.lines.push(line);
          seen.add(line.id);
        }
        codeOwner.row.lines = [];
        claimedOwners.add(codeOwner.index);
      }
    }
  }

  return { rows, attached, ambiguous };
}

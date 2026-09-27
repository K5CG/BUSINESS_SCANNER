import type { CustomerExportLocale } from './export-contacts-customer';

export function customerExportBcp47(locale: CustomerExportLocale): 'it-IT' | 'en-US' {
  return locale === 'en' ? 'en-US' : 'it-IT';
}

export function coerceCustomerExportDate(value: Date | string | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function formatCustomerExportDecimal(
  value: number,
  locale: CustomerExportLocale,
  options: { minimumFractionDigits?: number; maximumFractionDigits?: number; useGrouping?: boolean } = {}
): string {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat(customerExportBcp47(locale), {
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
    useGrouping: options.useGrouping ?? true,
  }).format(value);
}

export function formatCustomerExportMoney(value: number, locale: CustomerExportLocale): string {
  return formatCustomerExportDecimal(value, locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatCustomerExportQuantity(value: number, locale: CustomerExportLocale): string {
  return formatCustomerExportDecimal(value, locale, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 0,
    maximumFractionDigits: 3,
  });
}

export function formatCustomerExportPercent(value: number, locale: CustomerExportLocale): string {
  return `${formatCustomerExportDecimal(value, locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
    useGrouping: false,
  })}%`;
}

export function normalizeCustomerExportCurrency(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

export function formatCustomerExportMoneyWithCurrency(
  value: number,
  locale: CustomerExportLocale,
  currency: string | undefined
): string {
  const amount = formatCustomerExportMoney(value, locale);
  if (!amount) return '';
  const code = normalizeCustomerExportCurrency(currency);
  return code ? `${amount} ${code}` : amount;
}

export function formatCustomerDocumentDate(
  value: Date | string | undefined,
  locale: CustomerExportLocale
): string {
  const date = coerceCustomerExportDate(value);
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = String(date.getFullYear());
  return locale === 'en' ? `${month}/${day}/${year}` : `${day}/${month}/${year}`;
}

export function formatCustomerExportTimestamp(
  value: Date | string | undefined,
  locale: CustomerExportLocale
): string {
  const date = coerceCustomerExportDate(value);
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatCustomerDocumentDate(date, locale)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const XLSX_DATE_FORMAT = {
  it: 'dd/mm/yyyy',
  en: 'mm/dd/yyyy',
} as const;

export const XLSX_DATETIME_FORMAT = {
  it: 'dd/mm/yyyy hh:mm',
  en: 'mm/dd/yyyy hh:mm',
} as const;

export function toCustomerExcelDate(
  value: Date | string | undefined,
  mode: 'date' | 'datetime'
): Date | '' {
  const date = coerceCustomerExportDate(value);
  if (!date) return '';
  if (mode === 'date') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  }
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    0,
    0
  );
}

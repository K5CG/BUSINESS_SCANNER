export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  heading1: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  heading2: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  heading3: { fontSize: 17, lineHeight: 23, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodySecondary: { fontSize: 14, lineHeight: 21, fontWeight: '400' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: '400' },
  button: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  input: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 10,
  lg: 14,
  xl: 18,
  pill: 999,
} as const;

export const touchTarget = {
  minimum: 44,
  comfortable: 48,
} as const;

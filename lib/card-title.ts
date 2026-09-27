export function buildCardTitle(
  company: string,
  firstName: string,
  lastName: string
): string {
  const normalizedCompany = company.trim();
  const person = [firstName, lastName]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ');

  if (normalizedCompany && person) return `${normalizedCompany} - ${person}`;
  if (normalizedCompany) return normalizedCompany;
  if (person) return person;
  return 'Contatto';
}

export function shortAddress(value: string | null): string {
  if (value === null) return "—";
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export function shortTopic(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

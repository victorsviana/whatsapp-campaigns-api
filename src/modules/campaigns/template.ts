const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export type TemplateValues = Record<string, string | number>;

export function extractVariables(template: string): string[] {
  const names = Array.from(template.matchAll(VARIABLE_PATTERN), (match) => match[1] as string);
  return [...new Set(names)];
}

export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(VARIABLE_PATTERN, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}

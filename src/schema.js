/**
 * Tool-parameter JSON Schema helper.
 *
 * Built-in harness tools author their parameters through `defineTool()` from
 * `@deepseek-ai/dsh-tools`, which is not resolvable from a third-party bundle's
 * `node_modules`. An external plugin therefore has to hand the tool registry a
 * plain JSON Schema, so this module reproduces the small spec dialect those
 * built-in tools are written in: a property map whose entries carry
 * `type` / `required` / `description` / `enum` / `items` / `properties`.
 */

function convert(spec) {
  if (!spec || typeof spec !== 'object') return {};
  const out = {};
  if (spec.type) out.type = spec.type;
  if (spec.description) out.description = spec.description;
  if (Array.isArray(spec.enum)) out.enum = [...spec.enum];
  if (Array.isArray(spec.oneOf)) out.oneOf = spec.oneOf.map(convert);
  if (spec.default !== undefined) out.default = spec.default;
  if (spec.minimum !== undefined) out.minimum = spec.minimum;
  if (spec.maximum !== undefined) out.maximum = spec.maximum;
  if (spec.type === 'array') out.items = convert(spec.items ?? {});
  if (spec.properties) {
    const required = [];
    const properties = {};
    for (const [key, child] of Object.entries(spec.properties)) {
      const converted = convert(child);
      if (child?.required === true) required.push(key);
      delete converted.required;
      properties[key] = converted;
    }
    out.type = out.type ?? 'object';
    out.properties = properties;
    if (required.length > 0) out.required = required;
    out.additionalProperties = spec.additionalProperties ?? false;
  }
  return out;
}

/** Whole-object schema for a tool's `parameters` property map. */
export function parametersSchema(properties) {
  if (!properties || typeof properties !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  const required = [];
  const props = {};
  for (const [key, spec] of Object.entries(properties)) {
    const converted = convert(spec);
    if (spec?.required === true) required.push(key);
    delete converted.required;
    props[key] = converted;
  }
  const schema = { type: 'object', properties: props, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Spec fragments reused across tool definitions. */
export const stringArray = (description, extra = {}) => ({ type: 'array', items: { type: 'string' }, description, ...extra });

export const scopeSpec = {
  type: 'object',
  description:
    'Applicability scope: { match: {branch, commit, backend, dtype, os, ...}, context: {...}, revalidate_on: ["branch-change", "version-change", ...] }. Conditions that are unknown must stay unknown rather than being assumed applicable.',
  properties: {
    match: { type: 'object', description: 'Hard preconditions: a mismatching value makes the finding inapplicable.' },
    context: { type: 'object', description: 'Soft task context that only affects ranking and revalidation hints.' },
    revalidate_on: stringArray('Events that invalidate this finding (e.g. branch-change, dependency-upgrade).'),
  },
  additionalProperties: false,
};

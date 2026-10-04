import { serverSchema } from './schema.js';
import type { ServerMessage } from './protocol.js';
export interface JsonSchema {
  not?: JsonSchema; propertyNames?: JsonSchema;
  type?: string; const?: unknown; enum?: readonly unknown[]; anyOf?: readonly JsonSchema[];
  properties?: Readonly<Record<string, JsonSchema>>; required?: readonly string[]; additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema; minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number;
  minProperties?: number; maxProperties?: number;
}
export function matchesSchema(value: unknown, schema: JsonSchema): boolean {
  if (schema.anyOf && !schema.anyOf.some(candidate => matchesSchema(value, candidate))) return false;
  if (schema.not && matchesSchema(value, schema.not)) return false;
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string' && (schema.minLength === undefined || [...value].length >= schema.minLength) && (schema.maxLength === undefined || [...value].length <= schema.maxLength) && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'array') return Array.isArray(value) && (!schema.items || value.every(item => matchesSchema(item, schema.items!)));
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    const keys = Object.keys(data);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties) return false;
    if (schema.required?.some(key => !Object.hasOwn(data, key))) return false;
    if (schema.propertyNames && !keys.every(key => matchesSchema(key, schema.propertyNames!))) return false;
    return keys.every(key => {
      const field = schema.properties?.[key];
      return field ? matchesSchema(data[key], field) : schema.additionalProperties === false ? false : typeof schema.additionalProperties === 'object' ? matchesSchema(data[key], schema.additionalProperties) : true;
    });
  }
  return true;
}
export function isServerMessage(value: unknown): value is ServerMessage { return matchesSchema(value, serverSchema); }

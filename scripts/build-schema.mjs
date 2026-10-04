import * as ts from 'typescript/unstable/sync';
import { writeFile } from 'node:fs/promises';
const api = new ts.API();
const snapshot = api.updateSnapshot({ openProjects: ['tsconfig.json'] });
const project = snapshot.getProject('tsconfig.json');
const program = project.program;
const checker = project.checker;
const protocolModule = checker.getSymbolAtLocation(program.getSourceFile('src/protocol/index.ts'));
const protocolVersion = checker.getTypeOfSymbol(checker.getExportsOfModule(protocolModule).find(symbol => symbol.name === 'PROTOCOL_VERSION')).value;
function exportedType(file, name) {
  const source = program.getSourceFile(file);
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find(item => item.name === name);
  if (!symbol) throw new Error(`Missing protocol type ${name}`);
  return checker.getDeclaredTypeOfSymbol(symbol);
}
function schemaFor(type, seen = new Set()) {
  if (type.flags & ts.TypeFlags.StringLiteral) return { type: 'string', const: type.value };
  if (type.flags & ts.TypeFlags.NumberLiteral) return { type: 'number', const: type.value };
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: type.value };
  if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
  if (type.isUnionType()) return { anyOf: type.getTypes().filter(item => !(item.flags & ts.TypeFlags.Undefined)).map(item => schemaFor(item, seen)) };
  if (type.flags & ts.TypeFlags.String) return { type: 'string' };
  if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
  if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) throw new Error('Unspecified protocol field type');
  if (checker.isArrayType(type) || checker.isTupleType(type) || type.getSymbol()?.name === 'ReadonlyArray') return { type: 'array', items: schemaFor(checker.getTypeArguments(type)[0], seen) };
  if (seen.has(type)) throw new Error('Recursive wire type requires a schema reference');
  const nested = new Set(seen).add(type);
  const properties = {};
  const required = [];
  for (const property of checker.getPropertiesOfType(type)) {
    properties[property.name] = schemaFor(checker.getTypeOfSymbol(property), nested);
    if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
  }
  const index = checker.getIndexInfosOfType(type).find(info => info.keyType.flags & ts.TypeFlags.String)?.valueType;
  return { type: 'object', properties, required, additionalProperties: index ? schemaFor(index, nested) : false };
}
function constrain(schema, direction, field = '', command = '') {
  if (schema.anyOf) schema.anyOf.forEach(item => constrain(item, direction, field, command));
  if (schema.type === 'string') {
    if (['requestId', 'invitationToken', 'snapshotId', 'roomId', 'proposalId', 'resultId', 'matchId', 'gameId', 'messageId'].includes(field)) Object.assign(schema, { minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' });
    if (direction === 'client') {
      const maxima = { token: 3500, name: 32, password: 128, query: 64, cursor: 256, version: 64, mode: 64, region: 64, playerId: 128, text: 2000, reason: 512 };
      if (field in maxima) Object.assign(schema, { minLength: ['query', 'version', 'mode', 'region'].includes(field) || field === 'password' && command === 'update_room' ? 0 : 1, maxLength: maxima[field], pattern: '^[^\\p{Cc}\\p{Cs}]*$' });
    }
  }
  if (schema.type === 'number' && schema.const === undefined && (direction === 'client' || ['revision', 'lobbyRevision', 'chunkIndex', 'chunkCount', 'playerCount', 'spectatorCount', 'maxPlayers', 'maxSpectators', 'total'].includes(field))) {
    Object.assign(schema, { type: 'integer', minimum: ['maxSpectators', 'revision', 'lobbyRevision', 'chunkIndex', 'until', 'playerCount', 'spectatorCount', 'total'].includes(field) ? 0 : 1, maximum: Number.MAX_SAFE_INTEGER });
    if (field === 'chunkCount') schema.maximum = 1024;
    if (field === 'chunkIndex') schema.maximum = 1023;
  }
  if (field === 'protocolVersion') Object.assign(schema, { const: protocolVersion });
  if (schema.properties) {
    const tag = schema.properties.type?.const ?? command;
    for (const [name, value] of Object.entries(schema.properties)) constrain(value, direction, name, tag);
    if (direction === 'client' && tag === 'update_room') schema.anyOf = Object.keys(schema.properties).filter(key => key !== 'type' && key !== 'requestId').map(key => ({ type: 'object', required: [key] }));
    if (direction === 'client' && tag === 'list_rooms') schema.not = { type: 'object', required: ['cursor', 'page'] };
    if (field === 'rules') {
      schema.maxProperties = 16;
      const secrets = ['password', 'token', 'ticket', 'secret', 'authorization'].map(word => [...word].map(letter => `[${letter}${letter.toUpperCase()}]`).join('')).join('|');
      schema.propertyNames = { type: 'string', pattern: `^(?!.*(?:${secrets}))[a-zA-Z0-9][a-zA-Z0-9._:-]{0,31}$` };
    }
  }
  if (schema.items) constrain(schema.items, direction, field, command);
  if (typeof schema.additionalProperties === 'object') {
    // Numeric rule/result values are bounded finite numbers, not counts.
    if (field === 'rules' || field === 'result') {
      for (const branch of schema.additionalProperties.anyOf ?? [schema.additionalProperties]) {
        if (branch.type === 'number') Object.assign(branch, { type: 'number', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
        if (branch.type === 'string') branch.maxLength = 128;
      }
    } else constrain(schema.additionalProperties, direction);
  }
}
const client = schemaFor(exportedType('src/protocol/index.ts', 'ClientMessage'));
const server = schemaFor(exportedType('src/client/protocol.ts', 'ServerMessage'));
constrain(client, 'client'); constrain(server, 'server');
await writeFile('protocol.schema.json', JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `https://beacon.js/protocol/v${protocolVersion}`, title: `Beacon protocol v${protocolVersion}`, $defs: { client, server }, anyOf: [{ $ref: '#/$defs/client' }, { $ref: '#/$defs/server' }] }, null, 2) + '\n');
await writeFile('src/client/schema.ts', `// Generated from ClientMessage and ServerMessage by scripts/build-schema.mjs.\nimport type { JsonSchema } from './validation.js';\nexport const clientSchema: JsonSchema = ${JSON.stringify(client)};\nexport const serverSchema: JsonSchema = ${JSON.stringify(server)};\n`);
function typeText(schema) {
  if (schema.anyOf) return '(' + schema.anyOf.map(typeText).join(' | ') + ')';
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.type === 'array') return `Array<${typeText(schema.items)}>`;
  if (schema.type === 'object') {
    const members = Object.entries(schema.properties).map(([key, value]) => `${JSON.stringify(key)}${schema.required.includes(key) ? '' : '?'}: ${typeText(value)};`);
    if (typeof schema.additionalProperties === 'object') members.push(`[key: string]: ${typeText(schema.additionalProperties)};`);
    return `{ ${members.join(' ')} }`;
  }
  return schema.type === 'integer' ? 'number' : schema.type;
}
const declarations = ['ClientMessage', 'Compatibility', 'RoomSettings'].map(name => `export type ${name} = ${typeText(schemaFor(exportedType('src/protocol/index.ts', name)))};`);
await writeFile('packages/client/commands.d.ts', '// Generated from the authoritative shared protocol types.\n' + declarations.join('\n') + '\n');
api.close();

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
const destination = 'packages/client/dist';
await mkdir(destination, { recursive: true });
for (const name of await readdir('dist/client')) {
  if (!/\.(?:js|d\.ts)$/.test(name)) continue;
  let text = await readFile(`dist/client/${name}`, 'utf8');
  if (name.endsWith('.d.ts')) text = text.replaceAll("'../protocol/index.js'", "'./commands.js'");
  // Source maps refer to unpublished service source and are intentionally omitted.
  text = text.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  await writeFile(`${destination}/${name}`, text);
}
await copyFile('packages/client/commands.d.ts', `${destination}/commands.d.ts`);
await copyFile('protocol.schema.json', 'packages/client/protocol.schema.json');
await copyFile('LICENSE', 'packages/client/LICENSE');

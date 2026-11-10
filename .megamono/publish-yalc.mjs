#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const yalc = process.platform === 'win32' ? 'yalc.cmd' : 'yalc';
const projects = [
  {
    name: 'browsersweet-mcp',
    outputPath: 'dist/packages/mcp',
  },
];

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NX_DAEMON: 'false' },
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', (error) =>
      reject(new Error(`Unable to run ${command}: ${error.message}`)),
    );
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${command} ${args.join(' ')} ${code === null ? `stopped after signal ${signal ?? 'unknown'}` : `exited with code ${code}`}`,
        ),
      );
    });
  });
}

try {
  await run(yalc, ['--version']);
  await run(packageManager, [
    ...['exec', 'nx', 'run-many', '-t', 'build', '-p'],
    ...projects.map(({ name }) => name),
    '--output-style=static',
  ]);
  for (const { name, outputPath } of projects) {
    const directory = join(root, outputPath);
    await access(join(directory, 'package.json'));
    process.stdout.write(
      `\nPublishing ${name} from ${outputPath} to yalc...\n`,
    );
    await run(yalc, ['publish'], directory);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

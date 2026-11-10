import { execFile } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Action, Plan } from './plan.js';

/** The side effects a plan needs. `nodeApplyIo` is the real one. */
export interface ApplyIo {
  mkdir(path: string, mode?: number): void;
  writeFile(path: string, content: string, mode: number): void;
  copy(from: string, to: string): void;
  remove(path: string): void;
  reg(args: readonly string[]): Promise<void>;
}

/** Skip type declarations, maps, build info and sources when copying the host runtime. */
export function runtimeCopyFilter(source: string): boolean {
  const base = path.basename(source);
  if (base.endsWith('.tsbuildinfo') || base.endsWith('.map')) return false;
  if (/\.d\.[cm]?ts$/.test(base)) return false;
  return true;
}

export function nodeApplyIo(
  platform: NodeJS.Platform = process.platform,
): ApplyIo {
  return {
    mkdir: (p, mode) => {
      mkdirSync(p, { recursive: true, ...(mode ? { mode } : {}) });
    },
    writeFile: (p, content, mode) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content, { mode });
      if (platform !== 'win32') chmodSync(p, mode);
    },
    copy: (from, to) => {
      cpSync(from, to, {
        recursive: true,
        dereference: true,
        filter: runtimeCopyFilter,
      });
    },
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    reg: (args) =>
      new Promise((resolve, reject) => {
        // No shell: arguments go to reg.exe as-is.
        execFile(
          'reg',
          [...args],
          { windowsHide: true },
          (error, _out, stderr) =>
            error
              ? reject(
                  new Error(
                    `reg ${args[0]} failed: ${String(stderr).trim() || error.message}`,
                  ),
                )
              : resolve(),
        );
      }),
  };
}

/** Run a plan. Stops at the first required failure; returns errors from optional steps too. */
export async function applyPlan(plan: Plan, io: ApplyIo): Promise<string[]> {
  const errors: string[] = [];
  for (const action of plan.actions) {
    try {
      await applyAction(action, io);
    } catch (error) {
      const message = (error as Error).message;
      if (action.kind === 'reg' && action.optional) continue;
      errors.push(message);
      break;
    }
  }
  return errors;
}

async function applyAction(action: Action, io: ApplyIo): Promise<void> {
  switch (action.kind) {
    case 'mkdir':
      io.mkdir(action.path, action.mode);
      return;
    case 'write':
      io.writeFile(action.path, action.content, action.mode);
      return;
    case 'copy':
      io.copy(action.from, action.to);
      return;
    case 'remove':
      io.remove(action.path);
      return;
    case 'reg':
      await io.reg(action.args);
      return;
  }
}

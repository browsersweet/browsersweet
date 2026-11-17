import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

/*
 * Windows named pipes. Node can't set a pipe's DACL, so the default applies (full control for
 * the creating user, SYSTEM and Administrators; read for Everyone). We compensate:
 *   - The pipe name carries the user's SID and a random per-run id, and is only published in a
 *     record under %LOCALAPPDATA%\BrowserSweet\run (the user's profile ACL).
 *   - libuv creates the first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so a squatter who
 *     guessed the name makes our listen fail instead of capturing clients.
 *   - The host writes nothing to a client until it presents the 256-bit token from that record,
 *     so a read-only opener learns nothing.
 */

/** The current user's SID via `whoami /user`, or a sanitized user name if that fails. */
export function currentUserSid(
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true }),
): string {
  try {
    const out = run('whoami', ['/user', '/fo', 'csv', '/nh']);
    const match = /S-1-[0-9-]+/.exec(out);
    if (match) return match[0];
  } catch {
    // Fall through.
  }
  return `user-${userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function pipePrefix(sid: string): string {
  return `browsersweet-bridge-${sid}`;
}

export function pipePath(prefix: string, id: string): string {
  return `\\\\.\\pipe\\${prefix}-${id}`;
}

/**
 * Telling a process from another that was later given its id.
 *
 * A pid names a process only while it lives: once it is gone the number goes back into the
 * pool, and a record that holds nothing but a pid then points at whoever got it next. When
 * the process started does not change and is not handed on, so the pair names one process.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** When the process with this id started, in milliseconds since the epoch, or null where that cannot be read. */
export function processStartedAt(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Counted from after the command name, which may itself hold spaces and brackets:
      // the start time is field 22 of the line, the 20th after the name.
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      // shortcut: 100 ticks a second, which is what Linux reports to user space on the
      // architectures akapen is built for; ask sysconf(_SC_CLK_TCK) if one ever differs.
      return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
    } catch {
      return null;
    }
  }
  // macOS and the BSDs: `ps` prints it, in the C locale as "Sun Nov 22 22:10:01 2026".
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  const at = ps.status === 0 ? Date.parse(ps.stdout.trim()) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

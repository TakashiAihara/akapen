/**
 * Telling a process from another that was later given its id.
 *
 * A pid names a process only while it lives: once it is gone the number goes back into the
 * pool, and a record that holds nothing but a pid then points at whoever got it next. When
 * the process started does not change and is not handed on, so the pair names one process.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * What stays the same for as long as the process with this id lives and differs for any
 * other process that ever holds the id, or null where it cannot be read.
 *
 * "Any other" is as fine as the platform counts: a hundredth of a second on Linux, a
 * second where `ps` is asked, so a later process that got the id within that same second
 * reads the same there.
 *
 * Compared for equality and nothing else. On Linux it is the boot and the tick the process
 * started at, as the kernel counts them: not a time of day, which moves when the clock is
 * set (the boot time in `/proc/stat` moves with it), and a clock corrected after a server
 * started must not make it look like another process.
 */
export function processIdentity(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Counted from after the command name, which may itself hold spaces and brackets:
      // the start time is field 22 of the line, the 20th after the name.
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (ticks === undefined || !/^\d+$/.test(ticks)) return null;
      return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${ticks}`;
    } catch {
      return null;
    }
  }
  // macOS and the BSDs: `ps` prints when the process began. In one locale and one time zone,
  // whoever asks: the same instant must read the same from a service and from a shell.
  // By its path, so a service and a shell with another PATH ask the same program.
  const ps = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    timeout: 2_000,
  });
  const at = ps.status === 0 ? ps.stdout.trim() : '';
  return at === '' ? null : at;
}

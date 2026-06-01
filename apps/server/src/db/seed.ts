import 'dotenv/config';
import { getPool } from './pool.js';

/**
 * Dev seed: vloží pár demo PC a několik set eventů za posledních 24h.
 * Idempotentní — používá MERGE / NOT EXISTS.
 */

const COMPUTERS = [
  { name: 'PC-DEV-001', fqdn: 'pc-dev-001.axinetwork.loc', os: 'Windows 11 Pro 23H2' },
  { name: 'PC-DEV-002', fqdn: 'pc-dev-002.axinetwork.loc', os: 'Windows 11 Pro 23H2' },
  { name: 'NTB-IT-005', fqdn: 'ntb-it-005.axinetwork.loc', os: 'Windows 11 Enterprise' },
  { name: 'SRV-FILE-01', fqdn: 'srv-file-01.axinetwork.loc', os: 'Windows Server 2022' },
  { name: 'SRV-DC-01', fqdn: 'srv-dc-01.axinetwork.loc', os: 'Windows Server 2022' },
];

const PROVIDERS = ['Microsoft-Windows-Kernel-Power', 'Service Control Manager', 'DCOM', 'NTFS', 'Microsoft-Windows-WindowsUpdateClient'];
const LOG_NAMES = ['System', 'Application', 'Security'];

const EVENT_TEMPLATES = [
  { id: 41, level: 1, msg: 'The system has rebooted without cleanly shutting down first.' },
  { id: 6008, level: 2, msg: 'The previous system shutdown was unexpected.' },
  { id: 7034, level: 2, msg: 'The service terminated unexpectedly.' },
  { id: 7031, level: 3, msg: 'The service terminated unexpectedly. It has done this 1 time(s).' },
  { id: 10016, level: 3, msg: 'The application-specific permission settings do not grant Local Activation permission.' },
  { id: 1014, level: 3, msg: 'Name resolution for the name timed out.' },
  { id: 36887, level: 3, msg: 'A fatal alert was received from the remote endpoint.' },
  { id: 4625, level: 2, msg: 'An account failed to log on.' },
];

function pick<T>(arr: T[]): T {
  const x = arr[Math.floor(Math.random() * arr.length)];
  if (x === undefined) throw new Error('empty array');
  return x;
}

async function main() {
  const pool = await getPool();
  console.log('Seeding…');

  for (const c of COMPUTERS) {
    await pool.request()
      .input('name', c.name).input('fqdn', c.fqdn).input('os', c.os)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM computers WHERE name = @name)
          INSERT INTO computers (name, fqdn, os_version, last_seen, enabled)
          VALUES (@name, @fqdn, @os, DATEADD(MINUTE, -FLOOR(RAND()*60), SYSUTCDATETIME()), 1);
      `);
  }

  const computersRes = await pool.request().query<{ id: number; name: string }>('SELECT id, name FROM computers');
  const computers = computersRes.recordset;

  const N_EVENTS = 800;
  for (let i = 0; i < N_EVENTS; i++) {
    const c = pick(computers);
    const tpl = pick(EVENT_TEMPLATES);
    const minutesAgo = Math.floor(Math.random() * 60 * 24);
    await pool.request()
      .input('cid', c.id)
      .input('log', pick(LOG_NAMES))
      .input('eid', tpl.id)
      .input('lvl', tpl.level)
      .input('mins', minutesAgo)
      .input('prov', pick(PROVIDERS))
      .input('msg', tpl.msg)
      .query(`
        INSERT INTO events (computer_id, log_name, event_id, level, time_created, provider_name, message)
        VALUES (@cid, @log, @eid, @lvl, DATEADD(MINUTE, -@mins, SYSUTCDATETIME()), @prov, @msg);
      `);
    if ((i + 1) % 100 === 0) process.stdout.write(`  ${i + 1}/${N_EVENTS}\r`);
  }

  console.log(`\n✓ Seeded ${COMPUTERS.length} computers and ${N_EVENTS} events`);
  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

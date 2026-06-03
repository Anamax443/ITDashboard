import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { runServicesScanOnce } from '../services/services-collector.js';

export async function registerServicesRoutes(app: FastifyInstance) {
  app.get('/services/problems', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT sp.id, sp.computer_id, c.name AS computer, sp.service_name, sp.display_name,
             sp.start_mode, sp.state, sp.delayed_start, sp.trigger_start, sp.per_user_start,
             sp.is_compliant, sp.policy_id, sp.collected_at
      FROM service_problems sp
      JOIN computers c ON c.id = sp.computer_id
      WHERE c.enabled = 1 AND c.monitor_enabled = 1
      ORDER BY c.name, sp.service_name
    `);
    return { items: r.recordset };
  });

  app.get('/services/aggregate', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT sp.service_name, MAX(sp.display_name) AS display_name,
             MAX(sp.start_mode) AS start_mode,
             COUNT(*) AS pc_count,
             SUM(CASE WHEN sp.is_compliant = 0 THEN 1 ELSE 0 END) AS drift_count,
             SUM(CASE WHEN sp.is_compliant = 1 THEN 1 ELSE 0 END) AS ok_count,
             SUM(CASE WHEN sp.is_compliant IS NULL THEN 1 ELSE 0 END) AS unclassified_count,
             CAST(MAX(CAST(sp.trigger_start AS TINYINT)) AS BIT) AS trigger_start,
             CAST(MAX(CAST(sp.delayed_start AS TINYINT)) AS BIT) AS delayed_start,
             CAST(MAX(CAST(sp.per_user_start AS TINYINT)) AS BIT) AS per_user_start,
             MAX(sp.policy_id) AS policy_id
      FROM service_problems sp
      JOIN computers c ON c.id = sp.computer_id
      WHERE c.enabled = 1 AND c.monitor_enabled = 1 AND c.excluded = 0
      GROUP BY sp.service_name
      ORDER BY pc_count DESC, sp.service_name
    `);
    return { items: r.recordset };
  });

  app.get('/services/gpo-script', async (_req, reply) => {
    const pool = await getPool();
    // Pick rules where expected_start_mode is set; these become Set-Service targets
    const r = await pool.request().query(`
      SELECT pattern, expected_start_mode, reason
      FROM service_policy
      WHERE expected_start_mode IS NOT NULL
      ORDER BY priority, pattern
    `);
    const lines: string[] = [
      '# ITDashboard service-policy remediation script',
      '# Generated: ' + new Date().toISOString(),
      '# Apply via GPO → Computer Configuration → Policies → Windows Settings →',
      '#   Scripts → Startup (PowerShell tab) → Add → this file',
      '# Or run manually as admin on a target PC for one-off fix.',
      '',
      '$ErrorActionPreference = "SilentlyContinue"',
      '$serviceConfigs = @{',
    ];
    for (const row of r.recordset as Array<{ pattern: string; expected_start_mode: string; reason: string | null }>) {
      const mode = row.expected_start_mode === 'Auto' ? 'Automatic' : row.expected_start_mode;
      lines.push(`  ${JSON.stringify(row.pattern)} = ${JSON.stringify(mode)}   # ${row.reason ?? ''}`);
    }
    lines.push('}', '');
    lines.push('foreach ($pattern in $serviceConfigs.Keys) {');
    lines.push('  Get-Service -Name $pattern -ErrorAction SilentlyContinue | ForEach-Object {');
    lines.push('    try {');
    lines.push('      Set-Service -Name $_.Name -StartupType $serviceConfigs[$pattern]');
    lines.push('      Write-Output "$($_.Name): -> $($serviceConfigs[$pattern])"');
    lines.push('    } catch { Write-Output "$($_.Name): FAIL $($_.Exception.Message)" }');
    lines.push('  }');
    lines.push('}');
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="itdashboard-service-policy.ps1"');
    return lines.join('\r\n');
  });

  app.get('/services/policies', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT id, pattern, expected_start_mode, expected_state, priority, reason, created_at
      FROM service_policy ORDER BY priority, pattern
    `);
    return { items: r.recordset };
  });

  app.post('/services/scan', async (_req, reply) => {
    const result = await runServicesScanOnce();
    if (result === null) {
      reply.code(409);
      return { error: 'Services scan already running' };
    }
    return result;
  });
}

-- Park the per-branch service-port matrix: the meaningful target is "can a branch
-- reach the printer SEGMENT", which is being created by the in-progress SD-WAN
-- redesign (separating the printer network) — a moving target, and the right
-- vantage is the branch router, not the central .213. Stop the scheduled probe
-- sweep and hide the UI tab. All code/endpoints/settings stay — set
-- svcports.enabled=1 and restore the nav button to revive once the segment exists.
UPDATE settings SET [value] = '0' WHERE [key] = 'svcports.enabled';

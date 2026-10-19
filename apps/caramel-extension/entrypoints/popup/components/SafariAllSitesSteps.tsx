/**
 * Safari's own route to the every-website grant, spelled out. Safari keeps
 * that state behind its menus, and its permissions.request() can resolve
 * without prompting or granting anything (measured on macOS Safari 26,
 * 2026-10-17), so every Safari surface that offers an Enable button names the
 * menus that always work. One copy, shared by PermissionView and
 * AllSitesBanner, so the two cannot drift.
 *
 * The Mac route is Safari's Settings, not the toolbar button: the toolbar
 * only offers "Always Allow on Every Website" on a site Caramel is not yet
 * allowed on, and on an allowed store (the one the shopper is usually on) it
 * just opens this popup.
 */
export function SafariAllSitesSteps({ lead }: { lead: string }) {
    return (
        <p className="permission-manual-note">
            {lead} on Mac, open Safari <strong>Settings</strong> &gt;{' '}
            <strong>Websites</strong>, choose Caramel, and set{' '}
            <strong>For other websites</strong> to <strong>Allow</strong>. On
            iPhone or iPad, tap <strong>AA</strong> in the address bar, choose
            Caramel, then <strong>Always Allow</strong>.
        </p>
    )
}

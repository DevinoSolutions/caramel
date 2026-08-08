/**
 * The single source of truth for the avatar letter.
 *
 * The header and the profile page each derived this themselves and drifted: the
 * profile page fell back name -> email -> 'U', the header went straight to 'U'.
 * A Google account whose profile carries no `name` (Better Auth only writes the
 * provider profile at account creation, so accounts that predate social sign-in
 * keep a null name) therefore showed a meaningless "U" in the header while the
 * profile page showed the right letter for the same session.
 */
export function userInitial(user: {
    name?: string | null
    email?: string | null
}): string {
    const source = user.name?.trim() || user.email?.trim() || ''
    return source.charAt(0).toUpperCase() || 'U'
}

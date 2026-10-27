package com.devino.caramel.core

/**
 * DEV-ONLY proof path (T-9413). Compiled into every build type but REACHED only when `BuildConfig.DEV_PROOF` is true,
 * which is the `devproof` build type alone (app/build.gradle.kts): every call site is guarded by that constant, so R8
 * strips this object, [SessionStore.adoptDevProofBearer] and the intent-extra read from the release build
 * (RUNBOOK.md "Dev-only proof path"; the android-devproof-guard workflow checks the shrunk release for this extra's name).
 *
 * Why it exists: the app signs in with Google or Apple only, and a release build has to be walked signed in (account
 * deletion included) on an emulator before a tag goes out, without a real external account. POST /api/dev-proof/session
 * on dev.grabcaramel.com mints a bearer for a throwaway `devproof+<slug>@devino.ca` user; it is handed to the app as the
 * `devproof_session` extra of the launch intent and stored as if the sign-in had happened.
 *
 * The bearer is a credential: nothing here logs it.
 */
object DevProofSession {
    /** The intent extra that carries the bearer: `adb shell am start -n <package>/com.devino.caramel.MainActivity --es devproof_session <token>`. */
    const val EXTRA_NAME = "devproof_session"

    // The server's session token is 32 random bytes as base64url (43 characters); the bounds leave room without admitting a sentence.
    private val shape = Regex("^[A-Za-z0-9_-]{32,128}$")

    /** What the launch intent carried under [EXTRA_NAME]. */
    sealed interface Extra {
        /** No extra: an ordinary launch. */
        data object Absent : Extra

        /** An extra that is not a session bearer; the shell says so rather than ignoring it. */
        data object Malformed : Extra

        class Bearer(val token: String) : Extra
    }

    fun parse(extra: String?): Extra = when {
        extra == null -> Extra.Absent
        shape.matches(extra) -> Extra.Bearer(extra)
        else -> Extra.Malformed
    }
}

package com.devino.caramel

import android.app.Activity
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.NoCredentialException
import com.devino.caramel.core.AppConfig
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException

/**
 * Native Google sign-in: Credential Manager's "Sign in with Google" bottom sheet lists the
 * device's own Google accounts, with no browser page. The Google ID token it returns (audience =
 * [AppConfig.GOOGLE_SERVER_CLIENT_ID]) is traded by SessionStore.completeGoogleSignIn.
 */
class GoogleCredentialSignIn(private val activity: Activity) {
    sealed interface Outcome {
        data class Token(val idToken: String) : Outcome

        /** The shopper dismissed the sheet. */
        data object Cancelled : Outcome

        /**
         * This device cannot sign in with Google natively: no credential provider (no Google Play
         * Services, as on Fire devices) or no Google account to offer. The browser flow can still
         * sign the shopper in with any Google account, so the caller opens it.
         */
        data object Unavailable : Outcome

        data class Failed(val message: String) : Outcome
    }

    suspend fun requestIdToken(): Outcome {
        val option = GetSignInWithGoogleOption.Builder(AppConfig.GOOGLE_SERVER_CLIENT_ID).build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        return try {
            val credential = CredentialManager.create(activity).getCredential(activity, request).credential
            if (credential is CustomCredential &&
                credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
                Outcome.Token(GoogleIdTokenCredential.createFrom(credential.data).idToken)
            } else {
                Outcome.Failed("Google sign-in returned an unexpected credential (${credential.type}).")
            }
        } catch (_: GetCredentialCancellationException) {
            Outcome.Cancelled
        } catch (_: GetCredentialProviderConfigurationException) {
            Outcome.Unavailable
        } catch (_: NoCredentialException) {
            Outcome.Unavailable
        } catch (e: GoogleIdTokenParsingException) {
            Outcome.Failed("Google's sign-in answer could not be read: ${e.message}")
        } catch (e: GetCredentialException) {
            // Includes "[28444] Developer console is not set up correctly": the Cloud project has no
            // Android OAuth client for this package + signing certificate. Shown, never hidden
            // behind the browser flow, so a broken configuration is visible.
            Outcome.Failed("Google sign-in failed: ${e.errorMessage ?: e.type}")
        }
    }
}

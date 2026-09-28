package com.corxlabs.automa

import android.app.Activity
import android.content.Context
import androidx.core.content.ContextCompat
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import org.json.JSONObject

/** Firebase is usable only when this build carried google-services.json. */
object FirebaseSupport {
    fun isReady(context: Context): Boolean =
        BuildConfig.FIREBASE_ENABLED && FirebaseApp.getApps(context).isNotEmpty()
}

/**
 * "Continue with Google": Android's Credential Manager shows the Google
 * account sheet, and the Google ID token signs the person in to Firebase
 * Auth (creating the Firebase account on first use). The Firebase ID token
 * can then sign them in to their Automa server as well.
 */
class GoogleSignIn(private val activity: Activity) {
    private val credentialManager = CredentialManager.create(activity)
    private val mainExecutor = ContextCompat.getMainExecutor(activity)

    /** The OAuth web client id the google-services plugin writes when Google sign-in is enabled. */
    private fun webClientId(): String? {
        @Suppress("DiscouragedApi")
        val id = activity.resources.getIdentifier("default_web_client_id", "string", activity.packageName)
        return if (id == 0) null else activity.getString(id).takeIf { it.isNotBlank() }
    }

    val enabled: Boolean get() = FirebaseSupport.isReady(activity) && webClientId() != null

    val currentUser: FirebaseUser?
        get() = if (FirebaseSupport.isReady(activity)) FirebaseAuth.getInstance().currentUser else null

    val needsSignIn: Boolean get() = enabled && currentUser == null

    fun stateJson(): String = JSONObject()
        .put("enabled", enabled)
        .put("user", currentUser?.let(::userJson) ?: JSONObject.NULL)
        .toString()

    /** Must be called on the main thread with the activity in the foreground. */
    fun signIn(onResult: (Result<FirebaseUser>) -> Unit) {
        val clientId = webClientId()
        if (!FirebaseSupport.isReady(activity) || clientId == null) {
            onResult(Result.failure(IllegalStateException(activity.getString(R.string.sign_in_unavailable))))
            return
        }
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetSignInWithGoogleOption.Builder(clientId).build())
            .build()
        credentialManager.getCredentialAsync(
            activity,
            request,
            null,
            mainExecutor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val credential = result.credential
                    if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                        onResult(Result.failure(IllegalStateException("Google did not return an account")))
                        return
                    }
                    val google = runCatching { GoogleIdTokenCredential.createFrom(credential.data) }.getOrElse {
                        onResult(Result.failure(it))
                        return
                    }
                    FirebaseAuth.getInstance()
                        .signInWithCredential(GoogleAuthProvider.getCredential(google.idToken, null))
                        .addOnSuccessListener(mainExecutor) { auth ->
                            val user = auth.user
                            if (user != null) onResult(Result.success(user))
                            else onResult(Result.failure(IllegalStateException("Firebase did not return a user")))
                        }
                        .addOnFailureListener(mainExecutor) { onResult(Result.failure(it)) }
                }

                override fun onError(e: GetCredentialException) {
                    val message = when (e) {
                        is GetCredentialCancellationException -> activity.getString(R.string.sign_in_cancelled)
                        is NoCredentialException -> activity.getString(R.string.sign_in_no_account)
                        else -> e.message ?: "Google sign-in failed"
                    }
                    onResult(Result.failure(IllegalStateException(message)))
                }
            },
        )
    }

    fun signOut() {
        if (FirebaseSupport.isReady(activity)) FirebaseAuth.getInstance().signOut()
        credentialManager.clearCredentialStateAsync(
            ClearCredentialStateRequest(),
            null,
            mainExecutor,
            object : CredentialManagerCallback<Void?, ClearCredentialException> {
                override fun onResult(result: Void?) = Unit
                override fun onError(e: ClearCredentialException) = Unit
            },
        )
    }

    /** A fresh Firebase ID token for the server's sign-in endpoint, or null when signed out. */
    fun idToken(onResult: (String?) -> Unit) {
        val user = currentUser ?: return onResult(null)
        user.getIdToken(false)
            .addOnSuccessListener(mainExecutor) { onResult(it.token) }
            .addOnFailureListener(mainExecutor) { onResult(null) }
    }

    private fun userJson(user: FirebaseUser): JSONObject = JSONObject()
        .put("uid", user.uid)
        .put("name", user.displayName ?: JSONObject.NULL)
        .put("email", user.email ?: JSONObject.NULL)
        .put("photoUrl", user.photoUrl?.toString() ?: JSONObject.NULL)
}

package app.p2pchat

import android.content.Context
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.crypto.tink.subtle.AesGcmJce
import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519

fun ByteArray.b64(): String = Base64.encodeToString(this, Base64.NO_WRAP)
fun String.unb64(): ByteArray = Base64.decode(this, Base64.NO_WRAP)

class Identity(
    val id: String,
    val username: String,
    val token: String,
    val priv: ByteArray,
    val pub: ByteArray,
)

/** Stocke l'identité (clé privée incluse) chiffrée via Android Keystore. */
class IdentityStore(ctx: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        ctx, "identity",
        MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun load(): Identity? {
        val id = prefs.getString("id", null) ?: return null
        return Identity(
            id,
            prefs.getString("username", "")!!,
            prefs.getString("token", "")!!,
            prefs.getString("priv", "")!!.unb64(),
            prefs.getString("pub", "")!!.unb64(),
        )
    }

    fun save(i: Identity) {
        prefs.edit()
            .putString("id", i.id).putString("username", i.username).putString("token", i.token)
            .putString("priv", i.priv.b64()).putString("pub", i.pub.b64())
            .apply()
    }
}

/**
 * Chiffrement de bout en bout : X25519 (clé partagée) + HKDF + AES-256-GCM.
 * LIMITE : clés statiques => pas de forward secrecy. À remplacer par libsignal (Double Ratchet).
 */
object E2E {
    fun newKeyPair(): Pair<ByteArray, ByteArray> {
        val priv = X25519.generatePrivateKey()
        return priv to X25519.publicFromPrivate(priv)
    }

    private fun cipher(myPriv: ByteArray, myPub: ByteArray, theirPub: ByteArray): Pair<AesGcmJce, ByteArray> {
        val salt = listOf(myPub.b64(), theirPub.b64()).sorted().joinToString("").toByteArray()
        val key = Hkdf.computeHkdf(
            "HmacSha256", X25519.computeSharedSecret(myPriv, theirPub), salt, "p2p-chat-v1".toByteArray(), 32,
        )
        return AesGcmJce(key) to salt
    }

    fun encrypt(myPriv: ByteArray, myPub: ByteArray, theirPub: ByteArray, plain: ByteArray): ByteArray {
        val (c, aad) = cipher(myPriv, myPub, theirPub)
        return c.encrypt(plain, aad)
    }

    fun decrypt(myPriv: ByteArray, myPub: ByteArray, theirPub: ByteArray, data: ByteArray): ByteArray {
        val (c, aad) = cipher(myPriv, myPub, theirPub)
        return c.decrypt(data, aad)
    }
}

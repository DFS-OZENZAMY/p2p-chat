package app.p2pchat

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Client de l'annuaire (Cloudflare Worker) : inscription, recherche, signalisation. */
class Directory {
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val base = Config.DIRECTORY_URL.trimEnd('/')

    suspend fun register(username: String, publicKey: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val body = JSONObject().put("username", username).put("publicKey", publicKey).toString()
            .toRequestBody("application/json".toMediaType())
        http.newCall(Request.Builder().url("$base/register").post(body).build()).execute().use { r ->
            val json = runCatching { JSONObject(r.body?.string().orEmpty()) }.getOrNull()
            if (!r.isSuccessful) error(json?.optString("error") ?: "Erreur HTTP ${r.code}")
            json!!.getString("id") to json.getString("token")
        }
    }

    suspend fun lookup(key: String): Contact? = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url("$base/users/$key").build()).execute().use { r ->
            if (r.code == 404) return@use null
            if (!r.isSuccessful) error("Erreur HTTP ${r.code}")
            val j = JSONObject(r.body!!.string())
            Contact(j.getString("id"), j.getString("username"), j.getString("publicKey"))
        }
    }

    fun openSocket(me: Identity, onMsg: (JSONObject) -> Unit, onDown: () -> Unit): WebSocket {
        val url = base.replaceFirst("http", "ws") + "/ws?id=${me.id}"
        val req = Request.Builder().url(url).header("Authorization", "Bearer ${me.token}").build()
        return http.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { JSONObject(text) }.getOrNull()?.let(onMsg)
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { onDown() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { onDown() }
        })
    }
}

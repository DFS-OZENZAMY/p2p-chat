package app.p2pchat

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import okhttp3.WebSocket
import org.json.JSONObject
import org.webrtc.PeerConnectionFactory
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Cœur de l'app : annuaire (signalisation) + connexions P2P + chiffrement + file d'attente locale.
 * Les messages ne transitent JAMAIS par le serveur : seulement offer/answer/ice.
 */
class ChatEngine(app: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val dao = AppDb.create(app).dao()
    private val store = IdentityStore(app)
    private val directory = Directory()
    private val sessions = ConcurrentHashMap<String, PeerSession>()
    private var socket: WebSocket? = null
    private val factory: PeerConnectionFactory

    val identity = MutableStateFlow(store.load())
    val contacts: Flow<List<Contact>> = dao.contacts()
    fun messages(peerId: String): Flow<List<Msg>> = dao.messages(peerId)

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions(),
        )
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        identity.value?.let { connectSocket(it) }
    }

    // ---------- Compte & contacts ----------

    suspend fun register(username: String) {
        val (priv, pub) = E2E.newKeyPair()
        val (id, token) = directory.register(username, pub.b64())
        val me = Identity(id, username, token, priv, pub)
        store.save(me)
        identity.value = me
        connectSocket(me)
    }

    /** Ajoute un contact. La clé publique est mémorisée à la 1re vue ; un changement est refusé. */
    suspend fun addContact(username: String): Contact {
        val c = directory.lookup(username.trim().lowercase()) ?: error("Utilisateur introuvable")
        val old = dao.contact(c.id)
        if (old != null && old.publicKey != c.publicKey) error("⚠ La clé de ${c.username} a changé")
        dao.upsert(c)
        return c
    }

    private suspend fun contactFor(id: String): Contact? =
        dao.contact(id) ?: directory.lookup(id)?.also { dao.upsert(it) }

    // ---------- Signalisation ----------

    private fun connectSocket(me: Identity) {
        socket = directory.openSocket(me, onMsg = { handleSignal(it) }, onDown = {
            scope.launch { delay(2000); if (identity.value != null) connectSocket(me) }
        })
    }

    private fun sendSignal(to: String, m: JSONObject) {
        socket?.send(m.put("to", to).toString())
    }

    private fun handleSignal(m: JSONObject) {
        val from = m.optString("from")
        val me = identity.value ?: return
        if (from.isEmpty()) return
        when (m.optString("type")) {
            "offer" -> synchronized(sessions) {
                val old = sessions[from]
                if (old != null && old.isCaller && me.id < from) return // conflit : je reste l'appelant
                old?.close()
                val s = newSession(from, caller = false)
                sessions[from] = s
                s.onSignal(m)
            }
            "answer", "ice" -> sessions[from]?.onSignal(m)
        }
    }

    private fun newSession(peerId: String, caller: Boolean): PeerSession {
        lateinit var s: PeerSession
        s = PeerSession(
            factory, caller,
            signal = { sendSignal(peerId, it) },
            onOpen = { scope.launch { flush(peerId) } },
            onBytes = { scope.launch { receive(peerId, it) } },
            onClosed = { scope.launch { if (sessions.remove(peerId, s)) s.close() } },
        )
        return s
    }

    // ---------- Envoi / réception ----------

    /** Pré-chauffe la connexion à l'ouverture d'une conversation => 1er message sans attente. */
    fun open(peerId: String) = synchronized(sessions) {
        val s = sessions[peerId]
        if (s == null || (!s.isOpen && System.currentTimeMillis() - s.createdAt > 15_000)) {
            s?.close()
            sessions[peerId] = newSession(peerId, caller = true)
        }
    }

    suspend fun send(peerId: String, text: String) {
        dao.insert(Msg(UUID.randomUUID().toString(), peerId, text.take(4000), System.currentTimeMillis(), true, false))
        open(peerId)
        flush(peerId) // si le canal est déjà ouvert, part immédiatement ; sinon à l'ouverture
    }

    private suspend fun flush(peerId: String) {
        val s = sessions[peerId]?.takeIf { it.isOpen } ?: return
        val me = identity.value ?: return
        val c = contactFor(peerId) ?: return
        for (m in dao.pending(peerId)) {
            val plain = JSONObject().put("id", m.id).put("ts", m.ts).put("text", m.text).toString().toByteArray()
            val ct = E2E.encrypt(me.priv, me.pub, c.publicKey.unb64(), plain)
            if (s.send(ct)) dao.markSent(m.id) else break
        }
    }

    private suspend fun receive(peerId: String, bytes: ByteArray) {
        runCatching {
            val me = identity.value ?: return
            val c = contactFor(peerId) ?: return
            val j = JSONObject(String(E2E.decrypt(me.priv, me.pub, c.publicKey.unb64(), bytes)))
            dao.insert(Msg(j.getString("id"), peerId, j.getString("text"), j.getLong("ts"), outgoing = false, sent = true))
        }
    }
}

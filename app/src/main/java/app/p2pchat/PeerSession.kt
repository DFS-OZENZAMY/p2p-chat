package app.p2pchat

import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer

open class PcObserver : PeerConnection.Observer {
    override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {}
    override fun onIceConnectionReceivingChange(b: Boolean) {}
    override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
    override fun onIceCandidate(c: IceCandidate?) {}
    override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
    override fun onAddStream(s: MediaStream?) {}
    override fun onRemoveStream(s: MediaStream?) {}
    override fun onDataChannel(ch: DataChannel?) {}
    override fun onRenegotiationNeeded() {}
}

open class SdpObs : SdpObserver {
    override fun onCreateSuccess(d: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(e: String?) {}
    override fun onSetFailure(e: String?) {}
}

/** Une connexion pair-à-pair (DataChannel fiable et ordonné) avec un contact. */
class PeerSession(
    factory: PeerConnectionFactory,
    val isCaller: Boolean,
    private val signal: (JSONObject) -> Unit,
    private val onOpen: () -> Unit,
    private val onBytes: (ByteArray) -> Unit,
    private val onClosed: () -> Unit,
) {
    val createdAt = System.currentTimeMillis()
    private var dc: DataChannel? = null
    private val pendingIce = mutableListOf<IceCandidate>()
    private var remoteSet = false
    private val pc: PeerConnection

    val isOpen: Boolean get() = dc?.state() == DataChannel.State.OPEN

    init {
        val cfg = PeerConnection.RTCConfiguration(Config.ICE_SERVERS).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        pc = factory.createPeerConnection(cfg, object : PcObserver() {
            override fun onIceCandidate(c: IceCandidate?) {
                c ?: return
                signal(
                    JSONObject().put("type", "ice").put("sdpMid", c.sdpMid)
                        .put("sdpMLineIndex", c.sdpMLineIndex).put("candidate", c.sdp),
                )
            }
            override fun onDataChannel(ch: DataChannel?) { ch?.let { attach(it) } }
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {
                if (s == PeerConnection.IceConnectionState.FAILED || s == PeerConnection.IceConnectionState.CLOSED) onClosed()
            }
        })!!

        if (isCaller) {
            attach(pc.createDataChannel("chat", DataChannel.Init()))
            pc.createOffer(object : SdpObs() {
                override fun onCreateSuccess(d: SessionDescription?) {
                    d ?: return
                    pc.setLocalDescription(SdpObs(), d)
                    signal(JSONObject().put("type", "offer").put("sdp", d.description))
                }
            }, MediaConstraints())
        }
    }

    private fun attach(ch: DataChannel) {
        dc = ch
        ch.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) {}
            override fun onStateChange() { if (ch.state() == DataChannel.State.OPEN) onOpen() }
            override fun onMessage(b: DataChannel.Buffer) {
                val bytes = ByteArray(b.data.remaining())
                b.data.get(bytes)
                onBytes(bytes)
            }
        })
    }

    private fun remoteReady() = synchronized(this) {
        remoteSet = true
        pendingIce.forEach { pc.addIceCandidate(it) }
        pendingIce.clear()
    }

    fun onSignal(m: JSONObject) {
        when (m.getString("type")) {
            "offer" -> pc.setRemoteDescription(object : SdpObs() {
                override fun onSetSuccess() {
                    remoteReady()
                    pc.createAnswer(object : SdpObs() {
                        override fun onCreateSuccess(d: SessionDescription?) {
                            d ?: return
                            pc.setLocalDescription(SdpObs(), d)
                            signal(JSONObject().put("type", "answer").put("sdp", d.description))
                        }
                    }, MediaConstraints())
                }
            }, SessionDescription(SessionDescription.Type.OFFER, m.getString("sdp")))

            "answer" -> pc.setRemoteDescription(object : SdpObs() {
                override fun onSetSuccess() { remoteReady() }
            }, SessionDescription(SessionDescription.Type.ANSWER, m.getString("sdp")))

            "ice" -> {
                val c = IceCandidate(m.getString("sdpMid"), m.getInt("sdpMLineIndex"), m.getString("candidate"))
                synchronized(this) { if (remoteSet) pc.addIceCandidate(c) else pendingIce.add(c) }
            }
        }
    }

    fun send(bytes: ByteArray): Boolean =
        dc?.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), true)) ?: false

    fun close() {
        runCatching { dc?.close(); pc.close(); pc.dispose() }
    }
}

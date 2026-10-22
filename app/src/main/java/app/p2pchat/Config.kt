package app.p2pchat

import org.webrtc.PeerConnection

object Config {
    val DIRECTORY_URL: String = BuildConfig.DIRECTORY_URL

    // STUN public gratuit. Ajoute un TURN (coturn) : ~10-20 % des réseaux mobiles bloquent le P2P direct.
    val ICE_SERVERS: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        // PeerConnection.IceServer.builder("turn:turn.exemple.com:3478")
        //     .setUsername("user").setPassword("pass").createIceServer(),
    )
}

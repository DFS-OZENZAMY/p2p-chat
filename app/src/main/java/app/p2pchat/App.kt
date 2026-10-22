package app.p2pchat

import android.app.Application

class App : Application() {
    lateinit var engine: ChatEngine
        private set

    override fun onCreate() {
        super.onCreate()
        engine = ChatEngine(this)
    }
}

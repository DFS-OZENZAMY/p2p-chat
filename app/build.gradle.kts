plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

// Adresse de l'annuaire : -PdirectoryUrl=... ou variable d'environnement DIRECTORY_URL (CI GitHub).
val directoryUrl: String = (findProperty("directoryUrl") as String?)
    ?: System.getenv("DIRECTORY_URL")?.takeIf { it.isNotBlank() }
    ?: "https://p2p-chat-directory.TON-SOUS-DOMAINE.workers.dev"

// Signature de l'APK publié (fournie par la CI). Sans keystore : signature de debug.
val releaseKeystore = System.getenv("KEYSTORE_PATH")?.let { file(it) }?.takeIf { it.exists() }

android {
    namespace = "app.p2pchat"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.p2pchat"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "0.1"
        buildConfigField("String", "DIRECTORY_URL", "\"${directoryUrl.trimEnd('/')}\"")
    }

    signingConfigs {
        if (releaseKeystore != null) create("release") {
            storeFile = releaseKeystore
            storePassword = System.getenv("KEYSTORE_PASSWORD")
            keyAlias = System.getenv("KEY_ALIAS") ?: "p2pchat"
            keyPassword = System.getenv("KEYSTORE_PASSWORD")
        }
    }

    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (releaseKeystore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    implementation("io.getstream:stream-webrtc-android:1.3.8")      // WebRTC (DataChannel)
    implementation("com.google.crypto.tink:tink-android:1.13.0")    // X25519, HKDF, AES-GCM
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
